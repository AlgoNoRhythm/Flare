import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ProjectSession } from '../session';
import type { GraphEdge, GraphNode } from '../../shared/types';
import { isTestPath } from '../../shared/graph';
import {
  addNote,
  askQuestion,
  createTask,
  decisionAdvice,
  formatRoutineForAgent,
  nextStep,
  openQuestions,
  recordDecision,
  resolveLane,
  stopVerdict,
  tasksInLane,
  updateTask,
} from '../../shared/tasks';
import {
  covers as coversPath,
  formatFeed,
  noticesFor,
  openAsks,
  type Notice,
  type PostKind,
} from '../../shared/channel';
import { presenceOf } from '../../shared/roster';
import { formatAudit, type Chapter, type ChapterOutcome } from '../../shared/session';
import { stopHookReply } from './heartbeat';
import { McpRegistry, type McpRegistryEntry } from './mcpRegistry';
import { SlugBook } from './slugs';
import { APP_VERSION } from '../../shared/version';

/**
 * Dependency-free MCP server (streamable-HTTP transport, JSON responses)
 * bound to 127.0.0.1, designed for MANY Flare sessions on one machine:
 *
 * - every instance runs a private server on an ephemeral port and registers
 *   itself (per-pid file registry — no write races, dead entries pruned)
 * - ONE well-known public port (default 7345) is held by whichever instance
 *   grabbed it first ("gateway"); the others retry in the background and take
 *   over when it exits, so the public URL survives instance churn
 * - each project has a STABLE slug URL — /mcp/<folder-name> — that the
 *   gateway routes to the owning instance (proxying if it isn't itself), so a
 *   coding assistant registered per-project always reaches the right graph:
 *
 *     claude mcp add --transport http flare http://127.0.0.1:7345/mcp/<slug>
 *
 * - bare /mcp keeps working: with a single session it routes there; with
 *   several it answers tool calls with the project list so the agent can
 *   switch to a slug URL (or pass nothing and use list_projects).
 */

/**
 * A co-tenant on the same two ports.
 *
 * The web UI is served from here rather than from a port of its own so that a
 * restricted environment only has to expose one: `/mcp/<slug>` for agents and
 * `/<slug>/` for the browser, same host, same gateway, same slug. It sees the
 * requests this server does not want.
 */
export interface HttpMount {
  /** returns true if it took the request */
  request(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: MountContext,
  ): boolean | Promise<boolean>;
  upgrade(
    req: http.IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
    ctx: MountContext,
  ): void;
}

export interface MountContext {
  /** true on the shared public port, false on this instance's private one */
  gateway: boolean;
  /** every live Flare session on this machine */
  sessions(): McpRegistryEntry[];
  /** this instance's slug, if a project is open */
  slug: string | null;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Who is calling.
 *
 * The MCP session id, minted on `initialize` and echoed back by the client on
 * every later request. It is the only handle this server has that separates
 * one agent from another — a process list cannot (two `claude` sessions look
 * identical), and the board cannot (it attributes by path, so an agent editing
 * someone else's file is recorded as them). Null when the client predates the
 * header or never sent one, in which case attribution falls back down its
 * rungs exactly as before.
 */
export interface McpCaller {
  id: string | null;
  /**
   * What the client called itself on `initialize` — 'claude-code', 'codex'.
   *
   * The only first-person answer to "which tool is this": the process tree
   * knows what is *running* in a terminal, not which of those things opened
   * this socket. It is what turns an opaque session id into "Claude 2".
   */
  client?: string | null;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(
    args: Record<string, unknown>,
    session: ProjectSession,
    caller: McpCaller,
  ): Promise<string> | string;
}

const str = (desc: string) => ({ type: 'string', description: desc });

/** Fold an agent's own sentence into the middle of one of ours. */
function lowerFirst(text: string): string {
  const trimmed = text.trim().replace(/\.$/, '');
  if (/^[A-Z]{2,}/.test(trimmed)) return trimmed;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/**
 * Read whatever the agent put in `kind`.
 *
 * Forgiving on purpose: an agent that writes "take" or "DONE" meant the thing
 * it obviously meant, and dropping its post on the floor over a tag would cost
 * the room the message. Anything unrecognised is `saying`, which is the tag
 * that loses nothing — the words still reach everyone.
 */
function normalizeKind(raw: unknown): PostKind {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value.startsWith('tak') || value === 'claim' || value === 'working') return 'taking';
  if (value.startsWith('don') || value === 'release' || value === 'released') return 'done';
  if (value.startsWith('ask') || value === 'question') return 'asking';
  return 'saying';
}

/** Read whatever the agent put in `outcome`; anything unrecognised is done. */
function normalizeOutcome(raw: unknown): ChapterOutcome {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value.startsWith('part')) return 'partial';
  if (value.startsWith('aband') || value === 'dropped' || value === 'gave up') return 'abandoned';
  return 'done';
}

/** "Right now: Claude 2 has shared/graph.ts" — the line every read ends with. */
function summariseWorking(working: ReadonlyMap<string, Notice[]>, youId: string): string {
  const others = [...working.entries()]
    .map(([path, notices]) => [path, notices.filter((n) => n.agentId !== youId)] as const)
    .filter(([, notices]) => notices.length > 0);
  if (others.length === 0) return '';
  return [
    'Being worked on right now:',
    ...others.map(([path, notices]) => `  ${path} — ${[...new Set(notices.map((n) => n.agentName))].join(' AND ')}`),
  ].join('\n');
}

/**
 * Work out who is calling, minting an identity for a client that is new.
 *
 * `initialize` is the one message that means "a new agent is here", so it is
 * where the id is handed out; every later request carries it back in the
 * header. A client that ignores the header simply stays anonymous and
 * attribution falls back to the board, which is what it did before this
 * existed — so this cannot make anything worse than it already was.
 */
export function identify(
  req: { headers: Record<string, string | string[] | undefined> },
  body: string,
): { caller: McpCaller; minted: string | null } {
  let method: string | undefined;
  let client: string | null = null;
  try {
    const message = JSON.parse(body) as JsonRpcMessage;
    method = message.method;
    const info = message.params?.clientInfo as { name?: unknown } | undefined;
    if (typeof info?.name === 'string' && info.name !== '') client = info.name;
  } catch {
    // a malformed body is the responder's problem, not ours
  }

  const header = req.headers['mcp-session-id'];
  const existing = typeof header === 'string' && header.length > 0 ? header : null;
  if (existing) return { caller: { id: existing, client }, minted: null };
  if (method !== 'initialize') return { caller: { id: null, client }, minted: null };

  const minted = randomUUID();
  return { caller: { id: minted, client }, minted };
}

function adjacency(edges: GraphEdge[], reverse: boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const from = reverse ? e.target : e.source;
    const to = reverse ? e.source : e.target;
    if (!out.has(from)) out.set(from, []);
    out.get(from)!.push(to);
  }
  return out;
}

function walk(start: string[], adj: Map<string, string[]>): Set<string> {
  const seen = new Set(start);
  const queue = [...start];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  for (const s of start) seen.delete(s);
  return seen;
}

function resolveNode(session: ProjectSession, path: string): GraphNode | null {
  const graph = session.getGraphData();
  const exact = graph.nodes.find((n) => n.id === path);
  if (exact) return exact;
  const lower = path.toLowerCase().replace(/\\/g, '/');
  const suffix = graph.nodes.filter((n) => n.id.toLowerCase().endsWith(lower));
  return suffix.length === 1 ? suffix[0] : null;
}

const TOOLS: ToolDef[] = [
  {
    name: 'graph_overview',
    description:
      'Repo architecture at a glance: clusters (top-level modules) with file counts, dependency direction between them, and health summary (coverage, cycles, unreviewed changes, top risks).',
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, session) {
      const graph = session.getGraphData();
      const insights = await session.getInsights();
      const clusters = new Map<string, number>();
      for (const n of graph.nodes) clusters.set(n.cluster || '(root)', (clusters.get(n.cluster || '(root)') ?? 0) + 1);
      const clusterEdges = new Map<string, number>();
      for (const e of graph.edges) {
        const cs = graph.nodes.find((n) => n.id === e.source)?.cluster || '(root)';
        const ct = graph.nodes.find((n) => n.id === e.target)?.cluster || '(root)';
        if (cs !== ct) clusterEdges.set(`${cs} -> ${ct}`, (clusterEdges.get(`${cs} -> ${ct}`) ?? 0) + 1);
      }
      const s = insights.summary;
      const top = insights.files.slice(0, 5);
      return [
        `project: ${session.root}`,
        `files: ${s.files} · loc: ${s.loc} · coverage: ${s.avgCoverage ?? 'n/a'}${s.avgCoverage !== null ? '%' : ''} · reuse: ${s.reuse ?? 'n/a'}/100 · cycles: ${s.cycles} · orphans: ${s.orphans} · unreviewed: ${s.unreviewed} · TODOs: ${s.todos}`,
        '',
        'clusters:',
        ...[...clusters.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `  ${c} (${n} files)`),
        '',
        'inter-cluster dependencies (import count):',
        ...[...clusterEdges.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => `  ${k} (${n})`),
        '',
        'highest regression risk:',
        ...top.map((f) => `  ${f.path} — risk ${f.risk}/100, cx ${f.complexity}, ${f.blastRadius} downstream`),
        '',
        `issues: ${s.criticals} critical, ${s.warnings} warning (use the "issues" tool)`,
      ].join('\n');
    },
  },
  {
    name: 'file_info',
    description:
      'Everything known about one file: metrics (loc, complexity, churn, fan-in/out, blast radius, coverage, risk), imports, importers, symbols, and any issues.',
    inputSchema: {
      type: 'object',
      properties: { path: str('project-relative path (suffix match allowed)') },
      required: ['path'],
    },
    async handler(args, session, caller) {
      const node = resolveNode(session, String(args.path));
      if (!node) return `no file matching "${args.path}" in the code graph`;
      const graph = session.getGraphData();
      const insights = await session.getInsights();
      const m = insights.files.find((f) => f.path === node.id);
      const mine = session.agents.get(caller.id)?.id;
      const spoken = noticesFor(session.agents.working(), node.id);
      const imports = graph.edges.filter((e) => e.source === node.id).map((e) => e.target);
      const importers = graph.edges.filter((e) => e.target === node.id).map((e) => e.source);
      const issues = insights.issues.filter((i) => i.paths.includes(node.id));
      return [
        node.id,
        `loc ${node.loc} · complexity ${node.complexity} · symbols ${node.symbols.length} · TODOs ${node.todos}`,
        m
          ? `risk ${m.risk}/100 · hotspot ${m.hotspot}/100 · refactor ${m.refactor}/100 · reuse ${m.reuse ?? 'n/a'}/100 · churn ${m.churnGit} commits +${m.churnSession} this session · blast radius ${m.blastRadius}`
          : '',
        m?.coveragePct !== null && m !== undefined
          ? `coverage ${m.coveragePct}%`
          : `tested by ${node.testedBy} test file(s)`,
        m?.lastAgent ? `last changed by: ${m.lastAgent}${m.unreviewed ? ' (UNREVIEWED)' : ''}` : '',
        spoken.length > 0
          ? spoken.every((n) => n.agentId === mine)
            ? 'you told the channel you were taking this'
            : `BEING WORKED ON by ${[...new Set(spoken.filter((n) => n.agentId !== mine).map((n) => n.agentName))].join(' and ')}${
                spoken[0].text ? ` — ${lowerFirst(spoken[0].text)}` : ''
              }. Ask them in the channel before you edit it.`
          : '',
        node.cycleId !== null ? 'part of an import cycle' : '',
        node.orphan ? 'orphan: nothing imports it' : '',
        m && m.reuseBlockers.length > 0
          ? `reuse blocked by: ${m.reuseBlockers.join(', ')}${m.drag > 0 ? ` (and drags ${m.drag} project file(s) along)` : ''}`
          : '',
        '',
        `imports (${imports.length}): ${imports.join(', ') || '—'}`,
        `imported by (${importers.length}): ${importers.join(', ') || '—'}`,
        `symbols: ${node.symbols.map((s) => s.name).join(', ') || '—'}`,
        issues.length > 0 ? `\nissues:\n${issues.map((i) => `  [${i.severity}] ${i.title} — ${i.detail}`).join('\n')}` : '',
      ]
        .filter((line) => line !== '')
        .join('\n');
    },
  },
  {
    name: 'dependents',
    description: 'Files that import the given file (direct and transitive) — i.e. what could break when it changes.',
    inputSchema: {
      type: 'object',
      properties: { path: str('project-relative path (suffix match allowed)') },
      required: ['path'],
    },
    handler(args, session) {
      const node = resolveNode(session, String(args.path));
      if (!node) return `no file matching "${args.path}"`;
      const graph = session.getGraphData();
      const direct = graph.edges.filter((e) => e.target === node.id).map((e) => e.source);
      const transitive = [...walk([node.id], adjacency(graph.edges, true))];
      const tests = transitive.filter((p) => isTestPath(p));
      return [
        `${node.id}`,
        `direct importers (${direct.length}): ${direct.join(', ') || '—'}`,
        `transitive dependents (${transitive.length}): ${transitive.join(', ') || '—'}`,
        `affected tests: ${tests.join(', ') || 'none — this file has no test coverage via imports'}`,
      ].join('\n');
    },
  },
  {
    name: 'dependencies',
    description: 'Files the given file imports (direct and transitive).',
    inputSchema: {
      type: 'object',
      properties: { path: str('project-relative path (suffix match allowed)') },
      required: ['path'],
    },
    handler(args, session) {
      const node = resolveNode(session, String(args.path));
      if (!node) return `no file matching "${args.path}"`;
      const graph = session.getGraphData();
      const direct = graph.edges.filter((e) => e.source === node.id).map((e) => e.target);
      const transitive = [...walk([node.id], adjacency(graph.edges, false))];
      return [
        `${node.id}`,
        `direct imports (${direct.length}): ${direct.join(', ') || '—'}`,
        `transitive dependencies (${transitive.length}): ${transitive.join(', ') || '—'}`,
      ].join('\n');
    },
  },
  {
    name: 'find_path',
    description: 'Shortest import chain connecting two files (either direction) — answers "why does A depend on B".',
    inputSchema: {
      type: 'object',
      properties: { from: str('first file'), to: str('second file') },
      required: ['from', 'to'],
    },
    handler(args, session) {
      const a = resolveNode(session, String(args.from));
      const b = resolveNode(session, String(args.to));
      if (!a || !b) return `unresolved file: ${!a ? args.from : args.to}`;
      const graph = session.getGraphData();
      const adj = new Map<string, string[]>();
      for (const e of graph.edges) {
        if (!adj.has(e.source)) adj.set(e.source, []);
        if (!adj.has(e.target)) adj.set(e.target, []);
        adj.get(e.source)!.push(e.target);
        adj.get(e.target)!.push(e.source);
      }
      const prev = new Map<string, string>();
      const queue = [a.id];
      const seen = new Set([a.id]);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur === b.id) break;
        for (const next of adj.get(cur) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            prev.set(next, cur);
            queue.push(next);
          }
        }
      }
      if (!seen.has(b.id)) return `${a.id} and ${b.id} are not connected in the import graph`;
      const chain = [b.id];
      let cur = b.id;
      while (cur !== a.id) {
        cur = prev.get(cur)!;
        chain.unshift(cur);
      }
      return chain.join('\n  → ');
    },
  },
  {
    name: 'issues',
    description:
      'Current issue feed: regression risks, cycles, god-files, hotspots, coverage gaps, agent thrash, dead code. Filter by severity (critical|warning|info) or rule name.',
    inputSchema: {
      type: 'object',
      properties: { severity: str('optional filter'), rule: str('optional filter'), limit: { type: 'number' } },
    },
    async handler(args, session) {
      const insights = await session.getInsights();
      let list = insights.issues;
      if (args.severity) list = list.filter((i) => i.severity === args.severity);
      if (args.rule) list = list.filter((i) => i.rule === String(args.rule));
      const limit = Number(args.limit) || 25;
      if (list.length === 0) return 'no matching issues';
      return list
        .slice(0, limit)
        .map((i) => `[${i.severity}] (${i.rule}) ${i.title}\n  ${i.detail}\n  files: ${i.paths.join(', ')}`)
        .join('\n');
    },
  },
  {
    name: 'top_files',
    description:
      'Top files by a metric: risk (regression), hotspot (churn×complexity), refactor (refactor priority), reuse (least reusable first — what is welded to the host or the framework), complexity, churn, loc, todos, or lowest coverage.',
    inputSchema: {
      type: 'object',
      properties: {
        by: str('risk | hotspot | refactor | reuse | complexity | churn | loc | todos | low_coverage'),
        limit: { type: 'number' },
      },
      required: ['by'],
    },
    async handler(args, session) {
      const insights = await session.getInsights();
      const by = String(args.by);
      const limit = Number(args.limit) || 10;
      let sorted = [...insights.files];
      if (by === 'low_coverage') {
        sorted = sorted.filter((f) => f.coveragePct !== null && !f.isTest).sort((a, b) => a.coveragePct! - b.coveragePct!);
      } else if (by === 'reuse') {
        // ascending: the interesting end of this one is the bottom
        sorted = sorted
          .filter((f) => f.reuse !== null && !f.isTest)
          .sort((a, b) => a.reuse! - b.reuse!);
      } else if (by === 'churn') {
        sorted.sort((a, b) => b.churnGit + b.churnSession * 3 - (a.churnGit + a.churnSession * 3));
      } else {
        const key = by as 'risk' | 'hotspot' | 'refactor' | 'complexity' | 'loc' | 'todos';
        sorted.sort((a, b) => (b[key] as number) - (a[key] as number));
      }
      return sorted
        .slice(0, limit)
        .map(
          (f) =>
            `${f.path} — risk ${f.risk} · hot ${f.hotspot} · refac ${f.refactor} · reuse ${f.reuse ?? '—'} · cx ${f.complexity} · loc ${f.loc} · churn ${f.churnGit}+${f.churnSession} · cov ${f.coveragePct ?? '?'}${f.coveragePct !== null ? '%' : ''}`,
        )
        .join('\n');
    },
  },
  {
    name: 'search',
    description: 'Find files by name fragment or files declaring a symbol.',
    inputSchema: { type: 'object', properties: { query: str('name or symbol fragment') }, required: ['query'] },
    handler(args, session) {
      const q = String(args.query).toLowerCase();
      const graph = session.getGraphData();
      const byName = graph.nodes.filter((n) => n.id.toLowerCase().includes(q)).map((n) => n.id);
      const bySymbol = graph.nodes
        .map((n) => ({ id: n.id, syms: n.symbols.filter((s) => s.name.toLowerCase().includes(q)) }))
        .filter((r) => r.syms.length > 0);
      return [
        byName.length > 0 ? `files: ${byName.slice(0, 20).join(', ')}` : 'files: —',
        bySymbol.length > 0
          ? `symbols:\n${bySymbol.slice(0, 20).map((r) => `  ${r.id}: ${r.syms.map((s) => `${s.name} (line ${s.line})`).join(', ')}`).join('\n')}`
          : 'symbols: —',
      ].join('\n');
    },
  },
  {
    name: 'impact_of',
    description:
      'Before changing a set of files: everything downstream of them, which tests to run, and combined risk. Give it the files you are about to touch.',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' }, description: 'files you plan to change' } },
      required: ['paths'],
    },
    async handler(args, session, caller) {
      const wanted = (args.paths as string[]).map((p) => resolveNode(session, p)?.id).filter((p): p is string => Boolean(p));
      if (wanted.length === 0) return 'none of the given paths resolve to files in the graph';
      /*
       * "What breaks" is only half of what stops a change from landing. The
       * other half is another agent already being inside one of these files,
       * and this is the tool an agent calls at exactly the moment that matters
       * — before it starts.
       */
      const mine = session.agents.get(caller.id)?.id;
      const working = session.agents.working();
      const taken = wanted
        .map((path) => ({ path, notices: noticesFor(working, path).filter((n) => n.agentId !== mine) }))
        .filter((entry) => entry.notices.length > 0);
      const graph = session.getGraphData();
      const affected = [...walk(wanted, adjacency(graph.edges, true))];
      const tests = affected.filter((p) => isTestPath(p));
      const insights = await session.getInsights();
      const risky = insights.files.filter((f) => wanted.includes(f.path) && f.risk >= 50);
      return [
        `changing: ${wanted.join(', ')}`,
        `downstream impact (${affected.length} files): ${affected.slice(0, 30).join(', ') || '— nothing imports these'}`,
        `tests to run (${tests.length}): ${tests.join(', ') || 'NONE — no test imports these files; consider adding coverage first'}`,
        risky.length > 0
          ? `caution: ${risky.map((f) => `${f.path} is high-risk (${f.risk}/100)`).join('; ')}`
          : 'no high-risk files in this change set',
        taken.length > 0
          ? `\nANOTHER AGENT IS ALREADY IN THESE:\n${taken
              .map(
                ({ path, notices }) =>
                  `  ${path} — ${notices[0].agentName}${notices[0].text ? `, ${lowerFirst(notices[0].text)}` : ''}`,
              )
              .join(
                '\n',
              )}\nAsk them first with chat_post kind="asking". Editing anyway is recorded as a crossing and shown to the human next to your name.`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'recent_activity',
    description: 'What changed this session: unreviewed files with agent attribution, and the last shell commands run in the IDE terminals.',
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, session) {
      const insights = await session.getInsights();
      const unreviewed = insights.files.filter((f) => f.unreviewed);
      const commands = session.commands.slice(-10);
      return [
        `unreviewed changes (${unreviewed.length}):`,
        ...unreviewed
          .slice(0, 20)
          .map((f) => `  ${f.path} — risk ${f.risk}/100${f.lastAgent ? ` (by ${f.lastAgent})` : ''}`),
        '',
        'recent terminal commands:',
        ...commands.map(
          (c) =>
            `  [${c.agent ?? 'you'}] (${c.kind ?? 'read'}) ${c.command.slice(0, 120)}${
              c.outcome ? ` -> ${c.outcome}` : ''
            }`,
        ),
      ].join('\n');
    },
  },
  {
    name: 'tasks_list',
    description:
      "The project's task board. Call with no arguments to see every lane and what is in it, or pass a lane (\"to do\", \"in progress\", \"todo\", …) to see only that one. Use this to pick up your next piece of work.",
    inputSchema: {
      type: 'object',
      properties: { lane: str('Lane id or title. Omit for the whole board.') },
    },
    handler(args, session) {
      const board = session.getBoard();
      const wanted = args.lane ? resolveLane(board, String(args.lane)) : null;
      if (args.lane && !wanted) {
        return `no lane called "${String(args.lane)}". Lanes: ${board.lanes.map((l) => `${l.title} (${l.id})`).join(', ')}`;
      }
      const lanes = wanted ? [wanted] : board.lanes;
      const lines: string[] = [];
      for (const lane of lanes) {
        const tasks = tasksInLane(board, lane.id);
        lines.push(`## ${lane.title} (${lane.id}) — ${tasks.length}`);
        if (tasks.length === 0) lines.push('  (empty)');
        for (const task of tasks) {
          const files = task.paths.length > 0 ? ` [${task.paths.slice(0, 3).join(', ')}${task.paths.length > 3 ? ` +${task.paths.length - 3}` : ''}]` : '';
          lines.push(`  ${task.id}: ${task.title}${files}${task.draft ? ' (draft — not ready to pick up)' : ''}`);
        }
        lines.push('');
      }
      lines.push('Use task_get <id> for the full brief, task_update to move it or log progress.');
      return lines.join('\n');
    },
  },
  {
    name: 'task_get',
    description:
      'The full brief for one task, exactly as a human would paste it: the description, the files it concerns, what the dependency graph knows about those files, and the progress logged so far.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Task id, as listed by tasks_list.') },
      required: ['id'],
    },
    handler(args, session) {
      const text = session.formatTask(String(args.id ?? ''));
      return text ?? `no task with id "${String(args.id ?? '')}" — call tasks_list to see them`;
    },
  },
  {
    name: 'task_update',
    description:
      'Move a task to another lane and/or append a progress note. Move it to the review lane when you believe it is done — do not move it to done yourself; that is the human\'s call.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Task id.'),
        lane: str('Lane to move it to (id or title). Optional.'),
        note: str('What you did, found, or are blocked on. Optional but valuable.'),
      },
      required: ['id'],
    },
    handler(args, session, caller) {
      const id = String(args.id ?? '');
      let board = session.getBoard();
      const task = board.tasks.find((t) => t.id === id);
      if (!task) return `no task with id "${id}" — call tasks_list to see them`;
      const parts: string[] = [];
      if (args.lane) {
        const lane = resolveLane(board, String(args.lane));
        if (!lane) return `no lane called "${String(args.lane)}". Lanes: ${board.lanes.map((l) => l.id).join(', ')}`;
        board = updateTask(board, id, { laneId: lane.id });
        parts.push(`moved to ${lane.title}`);
      }
      if (args.note) {
        board = addNote(board, id, 'agent', String(args.note));
        parts.push('note logged');
      }
      if (parts.length === 0) return 'nothing to do: pass a lane, a note, or both';
      session.setBoard(board);
      // moving a card out of the queue is how an agent claims it — and it is
      // also the only moment this agent tells us what to *call* it
      session.noteClaim(caller.id, task.title);
      return `${task.title}: ${parts.join(', ')}`;
    },
  },
  {
    name: 'task_create',
    description:
      'File a new task on the board — use it for follow-up work you find but should not do right now, so it is not lost in a chat log. It lands in the first lane unless you say otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('One line describing the work.'),
        brief: str('The detail a future agent would need. Optional.'),
        paths: { type: 'array', items: { type: 'string' }, description: 'Project-relative files it concerns.' },
        lane: str('Lane to file it in. Optional.'),
      },
      required: ['title'],
    },
    handler(args, session) {
      const title = String(args.title ?? '').trim();
      if (title === '') return 'a task needs a title';
      const board = session.getBoard();
      const lane = args.lane ? resolveLane(board, String(args.lane)) : null;
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
      const result = createTask(board, { title, brief: args.brief ? String(args.brief) : '', paths, laneId: lane?.id });
      session.setBoard(result.board);
      return `filed "${result.task.title}" as ${result.task.id} in ${lane?.title ?? board.lanes[0]?.title}`;
    },
  },
  {
    name: 'working_agreement',
    description:
      'What this project expects you to do when you finish a piece of work — and what is outstanding right now: workable tasks, tasks blocked by an unanswered question, questions waiting on the human, and design decisions waiting to be agreed. Call it when you are unsure whether to keep going, and instead of stopping.',
    inputSchema: { type: 'object', properties: {} },
    handler(_args, session, caller) {
      const you = session.agents.get(caller.id);
      /*
       * "What should I do next" is a different question when someone else is
       * also answering it. The routine already refuses to hand out a card
       * another agent has started; this adds the half the board cannot know —
       * which files are being edited this minute, and by whom.
       */
      const others = session.agents.list().filter((a) => a.id !== you?.id && presenceOf(a, Date.now()) !== 'gone');
      const working = session.agents.working();
      const lines = [formatRoutineForAgent(session.getBoard())];
      if (you) lines.push('', `You are ${you.name} on this project.`);
      /*
       * The one thing that has to happen before the session ends, said at the
       * moment an agent is deciding whether to end it. A summary written after
       * the fact cannot be written at all: the only participant who knows what
       * the session was about stops existing when it stops running.
       */
      // the same fallback the recorder uses: an anonymous client's writes are
      // attributed to `you`, so its summary is filed there too
      const mine = you?.id ?? 'you';
      if (session.getSummaries().every((s) => s.by !== mine)) {
        lines.push(
          '',
          '## Before you stop',
          'Call `session_summary` with what you did — a headline and a chapter per piece of work, in prose, naming the files each covers. The review can show a human every diff and still not tell them what the session was *about*; you are the only one who can, and only while you are still running. Flare checks it against the writes it watched and tells you what you left out.',
        );
      }
      if (others.length > 0) {
        lines.push(
          '',
          `## You are not alone in here (${others.length} other agent${others.length === 1 ? '' : 's'})`,
          ...others.map((a) => {
            const taken = [...working.entries()]
              .filter(([, notices]) => notices.some((n) => n.agentId === a.id))
              .map(([path]) => path);
            return `- ${a.name} — ${a.doing ?? 'nothing announced'}${taken.length > 0 ? `; taking ${taken.join(', ')}` : ''}`;
          }),
          '',
          'There are no locks. The channel is how you stay out of each other\'s way, and it only works if you use it:',
          '- chat_post kind="taking" with the paths, BEFORE your first edit',
          '- chat_read when you finish a piece of work and before you pick up the next',
          '- chat_post kind="asking" with `to` set to an agent\'s name to ask whether a file is free',
          '- chat_post kind="done" with the paths the moment you stop needing them',
          'A file someone else has spoken for is a file whose changes will be folded into yours by whoever writes second.',
        );
      }
      return lines.join('\n');
    },
  },
  {
    name: 'decisions_list',
    description:
      'Design decisions recorded for this project and whether a human has agreed to them. A "proposed" decision is not settled — whether you may keep building on one is set by the project routine, which working_agreement will tell you.',
    inputSchema: {
      type: 'object',
      properties: { status: str('proposed | agreed | declined. Omit for all of them.') },
    },
    handler(args, session) {
      const board = session.getBoard();
      const wanted = args.status ? String(args.status).toLowerCase() : null;
      const decisions = wanted ? board.decisions.filter((d) => d.status === wanted) : board.decisions;
      if (decisions.length === 0) return wanted ? `no ${wanted} decisions` : 'no design decisions recorded yet';
      return decisions
        .map((d) => {
          const lines = [`## ${d.title}  [${d.status}]  (${d.id})`, `by ${d.by}`];
          if (d.detail) lines.push('', d.detail);
          if (d.alternatives) lines.push('', `Rejected: ${d.alternatives}`);
          if (d.paths.length > 0) lines.push('', `Files: ${d.paths.join(', ')}`);
          if (d.verdict) lines.push('', `Human said: ${d.verdict}`);
          return lines.join('\n');
        })
        .join('\n\n');
    },
  },
  {
    name: 'decision_record',
    description:
      'Write down an architectural decision you are making, with the alternatives you rejected, before the code that assumes it exists. It lands in the Control panel as *proposed* for a human to agree or decline — you must not mark your own decision agreed. Use it for the calls that shape the codebase: a module boundary, a dependency taken on, the shape of data that will spread, a refactor across several files, a pattern the rest of the code will copy. Not local names or anything one edit would undo. Whether you then build on it or leave that work is set by the project routine — call working_agreement.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('The decision in one line, e.g. "Parse imports with a lexer rather than a regex".'),
        detail: str('Why, and what it commits the codebase to.'),
        alternatives: str('What you considered and rejected, and why.'),
        paths: { type: 'array', items: { type: 'string' }, description: 'Files it affects.' },
      },
      required: ['title'],
    },
    handler(args, session) {
      const title = String(args.title ?? '').trim();
      if (title === '') return 'a decision needs a title';
      const result = recordDecision(session.getBoard(), {
        title,
        detail: args.detail ? String(args.detail) : '',
        alternatives: args.alternatives ? String(args.alternatives) : '',
        paths: Array.isArray(args.paths) ? args.paths.map(String) : [],
        by: 'agent',
      });
      session.setBoard(result.board);
      return `recorded "${result.decision.title}" as ${result.decision.id}, waiting for a human to agree. ${decisionAdvice(result.board)}`;
    },
  },
  {
    name: 'questions_list',
    description:
      'Questions you have asked the human, and any answers that have arrived. Call it when you come back to blocked work — an answer here unblocks the tasks the question named.',
    inputSchema: {
      type: 'object',
      properties: { open: { type: 'boolean', description: 'true for unanswered only.' } },
    },
    handler(args, session) {
      const board = session.getBoard();
      const list = args.open === true ? openQuestions(board) : board.questions;
      if (list.length === 0) return args.open === true ? 'nothing unanswered' : 'no questions asked yet';
      return list
        .map((q) => {
          const lines = [`## ${q.text}  (${q.id})`];
          if (q.detail) lines.push(q.detail);
          if (q.blocks.length > 0) lines.push(`Blocks: ${q.blocks.join(', ')}`);
          lines.push(q.answeredAt ? `Answer: ${q.answer}` : 'Answer: (still waiting)');
          return lines.join('\n');
        })
        .join('\n\n');
    },
  },
  {
    name: 'question_ask',
    description:
      'Ask the human something and carry on. Name the tasks it blocks; everything else stays workable, and you should pick one of those up rather than halting. Stop only when every remaining task is blocked. The answer comes back through questions_list.',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('The question, in one line.'),
        detail: str('What you will do with either answer — this is what makes it answerable.'),
        blocks: { type: 'array', items: { type: 'string' }, description: 'Task ids this holds up.' },
      },
      required: ['text'],
    },
    handler(args, session) {
      const text = String(args.text ?? '').trim();
      if (text === '') return 'a question needs to say something';
      const board = session.getBoard();
      const blocks = Array.isArray(args.blocks) ? args.blocks.map(String) : [];
      const unknown = blocks.filter((id) => !board.tasks.some((t) => t.id === id));
      const result = askQuestion(board, {
        text,
        detail: args.detail ? String(args.detail) : '',
        blocks: blocks.filter((id) => !unknown.includes(id)),
        by: 'agent',
      });
      session.setBoard(result.board);
      const step = nextStep(result.board);
      return [
        `asked "${result.question.text}" as ${result.question.id}.`,
        unknown.length > 0 ? `Ignored unknown task ids: ${unknown.join(', ')}.` : '',
        step.action,
      ]
        .filter(Boolean)
        .join(' ');
    },
  },
  {
    name: 'chat_post',
    description:
      'Say something to the other agents working on this project. This is how you coordinate: there are no locks and nothing is refused, so the room is the only thing stopping two of you rewriting the same file.\n\nWrite it the way you would to a colleague — a sentence or two saying what you are doing and why it matters to them ("moving the workspace lookup out of the resolver, so anything importing it will need the new signature"). A human reads this room as well, in Flare\'s Channel tab, and reads it to follow the work rather than to audit it: prose, not status codes, and no restating the paths you already passed in `paths`.\n\nPost with kind="taking" and the paths you are about to work on BEFORE your first edit — files or whole folders. Post kind="done" with those paths the moment you stop needing them, so whoever is waiting can move. Use kind="asking" with `to` to put a question to a specific agent by name ("is shared/graph.ts free?") — it is addressed to them and shows as waiting until they post again. Anything else is kind="saying".\n\nIf someone has already said they are taking a path you name, you are told so in the reply rather than stopped: talk to them. Posting also hands you everything said since you last looked, so this is usually the only call you need.',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('What you are doing, in a sentence or two of plain prose — for another agent to act on and a human to read.'),
        kind: str('taking | done | asking | saying. Defaults to saying.'),
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'The files or folders this is about — required for taking and done.',
        },
        to: str('The agent you are addressing, by the name Flare gave it ("Claude 2"). Omit for the room.'),
      },
      required: ['text'],
    },
    handler(args, session, caller) {
      if (!caller.id) {
        return "this MCP client did not keep a session id, so Flare cannot tell you from another agent — nothing was posted";
      }
      const text = String(args.text ?? '').trim();
      if (text === '') return 'say something';
      const kind = normalizeKind(args.kind);
      const paths = (Array.isArray(args.paths) ? args.paths.map(String) : [])
        .map((p) => p.trim())
        .filter(Boolean);
      if ((kind === 'taking' || kind === 'done') && paths.length === 0) {
        return `a "${kind}" post has to name the paths it is about — that is the part the other agents and the graph read`;
      }

      /* who else had spoken for these paths *before* this post landed */
      const before = session.agents.working();
      const clash = paths.flatMap((path) =>
        [...before.entries()]
          .filter(([held]) => coversPath(held, path) || coversPath(path, held))
          .flatMap(([, notices]) => notices)
          .filter((n) => n.agentId !== `mcp:${caller.id}`)
          .map((n) => ({ path, notice: n })),
      );

      const { message, unread, agent } = session.agents.say(caller.id, { text, kind, paths, to: args.to ? String(args.to) : null });
      /*
       * A "taking" is also an intent: it is the sentence `record_intent` asks
       * for, with the files attached. Recording it here is what lets a
       * well-behaved agent get away with one call, and what puts its name on
       * the burst in the review.
       */
      if (kind === 'taking') session.setIntent(text, undefined, 'agent', caller.id);

      return [
        `posted as ${agent.name}${message.toName ? ` → ${message.toName}` : ''}.`,
        kind === 'taking' && clash.length === 0
          ? 'Nobody else has spoken for those paths. Your writes to them will be attributed to you by name in the review.'
          : '',
        clash.length > 0
          ? [
              '',
              'HEADS UP — someone else has already said they are working on:',
              ...clash.map(
                ({ path, notice }) =>
                  `  ${path} — ${notice.agentName}${notice.text ? `, "${notice.text}"` : ''}`,
              ),
              'Nothing is blocked, so this is yours to sort out: ask them with chat_post kind="asking" and `to` set to their name, or take other work. Editing it anyway is recorded as a crossing and shown to the human next to your name.',
            ].join('\n')
          : '',
        unread.length > 0
          ? `\nSaid since you last looked (${unread.length}):\n${formatFeed(unread)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'chat_read',
    description:
      'Read the room. Call it when you finish a piece of work and before you pick up the next one — that is the moment another agent\'s "taking src/parser" or a question addressed to you changes what you should do next. By default you get what has been said since you last looked; pass all=true for the whole conversation.',
    inputSchema: {
      type: 'object',
      properties: { all: { type: 'boolean', description: 'true for the whole conversation.' } },
    },
    handler(args, session, caller) {
      if (!caller.id) return 'this MCP client did not keep a session id, so it has no place in the room';
      const { messages, unread, agent } = session.agents.read(caller.id, args.all === true);
      const working = session.agents.working();
      const asks = openAsks(session.agents.messages(), Date.now()).filter((m) => m.to === agent.id);

      if (messages.length === 0) {
        return [
          'nothing new.',
          summariseWorking(working, agent.id),
          'Say what you are about to work on with chat_post kind="taking" before you start.',
        ]
          .filter(Boolean)
          .join('\n\n');
      }
      return [
        args.all === true ? `the room (${messages.length}):` : `since you last looked (${unread}):`,
        formatFeed(messages),
        asks.length > 0
          ? `\nWAITING ON YOU:\n${formatFeed(asks)}\nAnswer with chat_post — kind="saying", to="${asks[0].fromName}".`
          : '',
        summariseWorking(working, agent.id),
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'agents_list',
    description:
      'Every agent working on this project right now, what each is doing and what it has said it is taking. Use it to know who you are sharing the repo with, to get the exact name to address one by — and to find out what Flare calls you, so the notes you leave on the board match the name the human sees.',
    inputSchema: { type: 'object', properties: {} },
    handler(_args, session, caller) {
      const now = Date.now();
      const roster = session.agents.list();
      const you = session.agents.get(caller.id);
      if (roster.length === 0) return 'no agents have connected to this project yet';
      const working = session.agents.working();
      return roster
        .map((agent) => {
          const taken = [...working.entries()]
            .filter(([, notices]) => notices.some((n) => n.agentId === agent.id))
            .map(([path]) => path);
          return [
            `${agent.name}${agent.id === you?.id ? '  (you)' : ''} — ${presenceOf(agent, now)}`,
            agent.doing ? `  doing: ${agent.doing}` : '',
            agent.task ? `  card: ${agent.task}` : '',
            taken.length > 0 ? `  taking: ${taken.join(', ')}` : '  taking: nothing announced',
            agent.files > 0 ? `  written this session: ${agent.files} file(s)` : '',
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n\n');
    },
  },
  {
    name: 'record_intent',
    description:
      'Record what you are about to change and why, before you change it. The IDE attaches this to the change burst so the human reviewing your diff can see the reasoning instead of reconstructing it. Call this at the start of any multi-file edit.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: str('What you are trying to accomplish, in one or two sentences.'),
        ruled_out: str('Approaches you considered and rejected, and why. Optional but valuable.'),
      },
      required: ['goal'],
    },
    handler(args, session, caller) {
      const goal = String(args.goal ?? '').trim();
      if (goal === '') return 'no goal given — nothing recorded';
      const ruledOut = args.ruled_out ? String(args.ruled_out).trim() : undefined;
      session.setIntent(goal, ruledOut, 'agent', caller.id);
      return 'intent recorded; it will be shown next to your changes in the review panel';
    },
  },
  {
    name: 'session_summary',
    description:
      'Write down what you did this session, as you finish and BEFORE you stop. This is the thing a human arrives to: the review can show them every burst, every diff and what checked it, and none of that answers "what happened while I was away" — only you know that, and only while you are still running.\n\nGive a `headline` and a list of `chapters`, one per piece of work: a title a person would recognise, a sentence or two of prose saying why and what it commits the codebase to, and the `paths` it covers. Prose, not a changelog — the diff is already there; what is missing is the reasoning that produced it.\n\nFlare watched the writes, so the reply tells you where your summary and the session disagree: chapters naming files that never changed, files that changed and no chapter accounts for, and chapters covering work nothing has verified. Fix it and call this again — it replaces your previous summary rather than stacking on it, so the version a human reads is your corrected one.',
    inputSchema: {
      type: 'object',
      properties: {
        headline: str('The session in one line, as you would open a handover with.'),
        chapters: {
          type: 'array',
          description: 'One per piece of work, in the order you did them.',
          items: {
            type: 'object',
            properties: {
              title: str('What this piece of work was, in one line.'),
              detail: str('Why, and what it commits the codebase to. A sentence or two of prose.'),
              paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'The files or folders this chapter covers.',
              },
              outcome: str('done | partial | abandoned. Defaults to done.'),
            },
            required: ['title'],
          },
        },
      },
      required: ['headline'],
    },
    handler(args, session, caller) {
      const headline = String(args.headline ?? '').trim();
      if (headline === '') return 'a summary needs a headline — the session in one line';
      const raw = Array.isArray(args.chapters) ? args.chapters : [];
      const chapters: Chapter[] = raw
        .map((entry) => (entry ?? {}) as Record<string, unknown>)
        .map((entry) => ({
          title: String(entry.title ?? '').trim(),
          detail: String(entry.detail ?? '').trim(),
          paths: (Array.isArray(entry.paths) ? entry.paths.map(String) : [])
            .map((p) => p.trim())
            .filter(Boolean),
          outcome: normalizeOutcome(entry.outcome),
        }))
        .filter((chapter) => chapter.title !== '');

      const me = session.agents.get(caller.id);
      /*
       * Attributed the same way its writes were.
       *
       * An anonymous client's bursts come back as the tool name or as `you`,
       * so a summary filed under an `mcp:` id it never wrote under would audit
       * against an empty set and report that it changed nothing.
       */
      const by = me?.id ?? 'you';
      const { audit } = session.recordSummary(by, me?.name ?? 'An agent', headline, chapters);

      return [
        `recorded. It is at the top of the Review panel now, under ${me?.name ?? 'your name'}.`,
        '',
        formatAudit(audit),
        '',
        audit.unaccounted.length > 0 || audit.chapters.some((c) => c.absent.length > 0)
          ? 'Call session_summary again with the corrections — the new one replaces this.'
          : 'Nothing unaccounted for.',
      ].join('\n');
    },
  },
  {
    name: 'verification_status',
    description:
      'Whether the recent change bursts have actually been verified: which ran tests after their last edit, what the outcome was, and which agent-smells were detected. Use this before reporting that you are done.',
    inputSchema: { type: 'object', properties: {} },
    handler(_args, session) {
      const bursts = session.getBursts().slice(-6).reverse();
      if (bursts.length === 0) return 'no changes recorded this session';
      return bursts
        .map((b) => {
          const files = [...b.changed, ...b.removed];
          const lines = [
            `${new Date(b.endedAt).toISOString().slice(11, 19)} by ${b.agent} — ${files.length} file(s): ${b.verification}`,
            `  ${files.slice(0, 8).join(', ')}${files.length > 8 ? ` +${files.length - 8}` : ''}`,
          ];
          if (b.verifiedBy) {
            lines.push(`  checked by: ${b.verifiedBy.command} -> ${b.verifiedBy.outcome}`);
            if (b.verifiedBy.evidence) lines.push(`  evidence: ${b.verifiedBy.evidence}`);
          }
          for (const smell of b.smells) lines.push(`  ! ${smell.severity}: ${smell.title}`);
          if (b.intent) lines.push(`  intent: ${b.intent.goal}`);
          return lines.join('\n');
        })
        .join('\n');
    },
  },
];

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

export class McpServer {
  private localServer: http.Server | null = null;
  private gatewayServer: http.Server | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** this instance's private port */
  localPort = 0;
  /** the machine-wide public port (whoever holds it) */
  readonly publicPort: number;
  slug: string | null = null;
  isGateway = false;
  /**
   * Settles once we know whether we hold the public port — binding is async,
   * so without this anything that reports on startup reports "someone else has
   * it" every time, including when it is about to be us.
   */
  readonly gatewayDecided: Promise<boolean>;
  private decideGateway!: (mine: boolean) => void;

  constructor(
    private getSession: () => ProjectSession | null,
    publicPort: number,
    private registry: McpRegistry,
    /**
     * Interface for the shared port. Loopback by default, everywhere: the
     * desktop app has no reason to listen wider, and the served build only
     * does so when told to, because what is behind this port is a filesystem
     * and a shell with no login in front of them.
     *
     * The per-instance private port is never widened — it is an internal
     * detail that only the gateway on this machine ever connects to.
     */
    private publicHost: string = '127.0.0.1',
    /** remembered, human-readable project names for urls */
    private slugs: SlugBook = new SlugBook(''),
  ) {
    this.publicPort = publicPort;
    this.gatewayDecided = new Promise((resolve) => {
      this.decideGateway = resolve;
    });
  }

  /** Serve the web UI on these same ports. Consulted per request, so it can be
   * set before or after `start()`. */
  mount(mount: HttpMount): void {
    this.mounted = mount;
  }

  private mounted: HttpMount | null = null;

  private context(gateway: boolean): MountContext {
    return { gateway, sessions: () => this.registry.list(), slug: this.slug };
  }

  /** True if the mount took it. MCP owns POST; everything else is the UI's. */
  private async offerToMount(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    gateway: boolean,
  ): Promise<boolean> {
    if (!this.mounted || req.method === 'POST') return false;
    return this.mounted.request(req, res, this.context(gateway));
  }

  private listenForUpgrades(server: http.Server, gateway: boolean): void {
    server.on('upgrade', (req, socket, head) => {
      if (this.mounted) this.mounted.upgrade(req, socket, head, this.context(gateway));
      else socket.destroy();
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      const server = http.createServer((req, res) => void this.handleLocal(req, res));
      this.listenForUpgrades(server, false);
      server.listen(0, '127.0.0.1', () => {
        this.localServer = server;
        this.localPort = (server.address() as { port: number }).port;
        resolve();
      });
    });
    this.tryBecomeGateway();
    this.heartbeatTimer = setInterval(() => this.registry.heartbeat(), 10_000);
  }

  /** The url name for a project — pretty, and the same every time. */
  slugFor(root: string): string {
    return this.slugs.slugFor(root);
  }

  /** Every live Flare session on this machine, this one included. */
  sessions(): McpRegistryEntry[] {
    return this.registry.list();
  }

  /** Called whenever this instance's open project changes. */
  updateProject(root: string | null, name: string): void {
    if (root === null) {
      this.slug = null;
      this.registry.unregister();
      return;
    }
    this.slug = this.slugFor(root);
    this.registry.register({ slug: this.slug, name, root, port: this.localPort });
  }

  private tryBecomeGateway(): void {
    if (this.stopped || this.gatewayServer) return;
    const server = http.createServer((req, res) => void this.handleGateway(req, res));
    this.listenForUpgrades(server, true);
    server.once('error', () => {
      // someone else holds the public port — take over when they exit
      this.decideGateway(false);
      if (!this.stopped) this.retryTimer = setTimeout(() => this.tryBecomeGateway(), 4000);
    });
    server.listen(this.publicPort, this.publicHost, () => {
      this.gatewayServer = server;
      this.isGateway = true;
      this.decideGateway(true);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.registry.unregister();
    this.localServer?.close();
    this.gatewayServer?.close();
    this.localServer = null;
    this.gatewayServer = null;
  }

  // ------------------------------------------------------------------
  // private per-instance endpoint: always serves THIS session
  // ------------------------------------------------------------------
  private async handleLocal(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (await this.handleStopHook(req, res)) return;
    if (await this.offerToMount(req, res, false)) return;
    if (req.method !== 'POST') {
      res.writeHead(req.method === 'GET' ? 405 : 404).end();
      return;
    }
    const body = await readBody(req);
    const { caller, minted } = identify(req, body);
    await this.respond(
      res,
      body,
      (message) => this.dispatch(message, caller),
      minted ? { 'mcp-session-id': minted } : undefined,
    );
  }

  // ------------------------------------------------------------------
  // public gateway endpoint: routes by /mcp/<slug>
  // ------------------------------------------------------------------
  private async handleGateway(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (await this.handleStopHook(req, res)) return;
    if (await this.offerToMount(req, res, true)) return;
    if (req.method !== 'POST') {
      res.writeHead(req.method === 'GET' ? 405 : 404).end();
      return;
    }
    const urlPath = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
    const match = /^\/mcp(?:\/([\w-]+))?$/.exec(urlPath === '' ? '/mcp' : urlPath);
    const slug = match?.[1] ?? null;
    const body = await readBody(req);

    const entries = this.registry.list();
    let target = slug ? entries.find((e) => e.slug === slug) ?? null : null;
    if (!slug && entries.length === 1) target = entries[0];

    // known target that is another instance → proxy verbatim
    if (target && target.pid !== process.pid) {
      try {
        /*
         * The session id has to survive the hop, both ways.
         *
         * Only content-type was forwarded before, which was fine while the
         * protocol was stateless — but the caller's identity now lives in a
         * header, and an agent that reaches its project *through* the gateway
         * would have arrived anonymous while one talking to the instance
         * directly did not. Same agent, different answer, depending on which
         * window happened to hold the well-known port.
         */
        const session = req.headers['mcp-session-id'];
        const upstream = await fetch(`http://127.0.0.1:${target.port}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(typeof session === 'string' && session ? { 'mcp-session-id': session } : {}),
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        const text = await upstream.text();
        const minted = upstream.headers.get('mcp-session-id');
        res.writeHead(upstream.status, {
          'content-type': 'application/json',
          ...(minted ? { 'mcp-session-id': minted } : {}),
        });
        res.end(text);
      } catch {
        await this.respond(res, body, (message) => ({
          id: message.id,
          result: {
            content: [{ type: 'text', text: `Flare session for "${slug}" is not responding — it may have just closed. Use list_projects.` }],
            isError: true,
          },
        }));
      }
      return;
    }

    /*
     * The gateway serves its own project too, and that path has to identify
     * callers exactly as the private one does — otherwise an agent's identity
     * depends on which URL it happened to be given.
     */
    const { caller, minted } = identify(req, body);
    await this.respond(
      res,
      body,
      async (message) => {
      if (target) return this.dispatch(message, caller); // target is this instance
      if (slug) {
        // stable URL whose session is gone
        if (message.method === 'tools/call') {
          return {
            result: {
              content: [{ type: 'text', text: `no open Flare session for project "${slug}". Open the project in Flare, or call list_projects on ${this.baseUrl()} to see live sessions.` }],
              isError: true,
            },
          };
        }
        if (message.method === 'initialize' || message.method === 'tools/list' || message.method === 'ping') {
          return this.dispatch(message, caller); // generic protocol handling still works
        }
        return { error: { code: -32001, message: `no session for project ${slug}` } };
      }
      // bare /mcp with zero or many sessions
      if (message.method === 'tools/call' && entries.length > 1) {
        const name = message.params?.name as string;
        if (name !== 'list_projects') {
          return {
            result: {
              content: [{ type: 'text', text: `${entries.length} Flare projects are open — this shared endpoint needs a project-specific URL.\n\n${this.projectList(entries)}\n\nRe-register with the URL of the project you are working in.` }],
            },
          };
        }
      }
      return this.dispatch(message, caller);
      },
      minted ? { 'mcp-session-id': minted } : undefined,
    );
  }

  /**
   * The heartbeat: the assistant's own stop hook, answered by the board.
   *
   * Not an MCP tool, because nothing calls it as one — it is a `curl` in a
   * hook, so it has to be a plain endpoint. It lives on both servers for the
   * same reason `/mcp/<slug>` does: the hook is written once, pointed at the
   * well-known port, and has to keep working when the session that installed
   * it is no longer the one holding that port.
   *
   * A hook that cannot be answered must never hold a session hostage, so every
   * failure here — wrong slug, dead session, unreadable body — lets the stop
   * through rather than blocking it.
   */
  private async handleStopHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const urlPath = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
    const match = /^\/hook(?:\/([\w-]+))?\/stop$/.exec(urlPath);
    if (!match) return false;

    const allow = (): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(stopHookReply(false, '')));
    };

    const body = req.method === 'POST' ? await readBody(req).catch(() => '') : '';
    let input: { stop_hook_active?: boolean } = {};
    try {
      input = body ? (JSON.parse(body) as typeof input) : {};
    } catch {
      input = {};
    }
    /*
     * The assistant sets this when the stop it is asking about was itself
     * caused by a stop hook. Blocking again there is how a heartbeat turns
     * into a session that cannot end.
     */
    if (input.stop_hook_active === true) {
      allow();
      return true;
    }

    const slug = match[1] ?? null;
    const target = slug ? this.registry.list().find((e) => e.slug === slug) ?? null : null;
    if (target && target.pid !== process.pid) {
      try {
        const upstream = await fetch(`http://127.0.0.1:${target.port}/hook/${slug}/stop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body || '{}',
          signal: AbortSignal.timeout(4000),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(await upstream.text());
      } catch {
        allow();
      }
      return true;
    }

    const session = this.getSession();
    if (!session || (slug && slug !== this.slug)) {
      allow();
      return true;
    }
    const board = session.getBoard();
    // `=== 'stop-hook'`, not a truthiness check: 'off' is a non-empty string,
    // so the obvious `!routine.heartbeat` reads as "a heartbeat is set" and
    // blocks sessions on a project that switched it off
    if (board.routine?.heartbeat !== 'stop-hook') {
      allow();
      return true;
    }
    const verdict = stopVerdict(board);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(stopHookReply(verdict.keepGoing, verdict.reason)));
    return true;
  }

  private baseUrl(): string {
    return `http://127.0.0.1:${this.publicPort}/mcp`;
  }

  private projectList(entries = this.registry.list()): string {
    if (entries.length === 0) return 'no Flare sessions are running with an open project';
    return entries
      .map((e) => `${e.name} — ${e.root}\n  url: ${this.baseUrl()}/${e.slug}`)
      .join('\n');
  }

  private async respond(
    res: http.ServerResponse,
    body: string,
    produce: (message: JsonRpcMessage) => Promise<Record<string, unknown>> | Record<string, unknown>,
    /** extra response headers — the minted session id, on an initialize */
    extra?: Record<string, string>,
  ): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(body) as JsonRpcMessage;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    // notifications get no response body
    if (message.id === undefined || message.id === null) {
      res.writeHead(202).end();
      return;
    }
    const result = await produce(message);
    res.writeHead(200, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...result }));
  }

  private async dispatch(
    message: JsonRpcMessage,
    caller: McpCaller = { id: null },
  ): Promise<Record<string, unknown>> {
    switch (message.method) {
      case 'initialize':
        /*
         * The one message that means "a new agent is here" is also the only
         * one that carries the client's name, so it is where an identity is
         * made: session id plus tool becomes "Claude 2", and everything this
         * agent writes for the rest of the session is filed under that.
         */
        this.getSession()?.agents.noteAgent(caller.id, caller.client ?? null);
        return {
          result: {
            protocolVersion: (message.params?.protocolVersion as string) ?? '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'flare', version: APP_VERSION },
          },
        };
      case 'ping':
        return { result: {} };
      case 'tools/list':
        return {
          result: {
            tools: [
              ...TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
              {
                name: 'list_projects',
                description:
                  'List every Flare session running on this machine with its stable per-project MCP URL. Use the URL of the project you are working in.',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        };
      case 'tools/call': {
        const name = message.params?.name as string;
        const args = (message.params?.arguments as Record<string, unknown>) ?? {};
        if (name === 'list_projects') {
          return { result: { content: [{ type: 'text', text: this.projectList() }] } };
        }
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return { error: { code: -32602, message: `unknown tool: ${name}` } };
        const session = this.getSession();
        if (!session) {
          return { result: { content: [{ type: 'text', text: 'no project is open in Flare' }], isError: true } };
        }
        /*
         * Presence is measured in tool calls, not in sockets.
         *
         * A streamable-HTTP client holds no connection between requests, so
         * there is nothing to watch go away — the only evidence an agent is
         * still working is that it keeps asking. That also means a client that
         * skipped `initialize` is registered here, on its first call, rather
         * than editing files as nobody.
         */
        session.agents.noteCall(caller.id);
        try {
          const text = await tool.handler(args, session, caller);
          return { result: { content: [{ type: 'text', text }] } };
        } catch (err) {
          return {
            result: {
              content: [{ type: 'text', text: `tool failed: ${(err as Error).message}` }],
              isError: true,
            },
          };
        }
      }
      default:
        return { error: { code: -32601, message: `method not found: ${message.method}` } };
    }
  }
}
