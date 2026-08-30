import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import {
  MAX_SEARCH_FILE_BYTES,
  MAX_SEARCH_HITS,
  compileQuery,
  isSearchableFile,
  replaceText,
  searchText,
  type SearchHit,
  type SearchOptions,
} from '../shared/search';
import * as path from 'node:path';
import { GraphBuilder } from '../shared/graph';
import { buildIgnore, parseFileFromDisk, scanProject } from '../shared/scanner';
import {
  parseJsonc,
  tsPathsFromConfig,
  workspacePackagesFrom,
  type ResolverOptions,
  type TsPathMapping,
} from '../shared/resolver';
import { CODE_EXTENSIONS } from '../shared/parser';
import { extname, toPosix } from '../shared/paths';
import { buildSymbolGraph } from '../shared/symbols';
import { parseLcov, resolveCoverage, type CoverageMap } from '../shared/coverage';
import { computeInsights, type Insights } from '../shared/insights';
import { imageMime } from '../shared/preview';
import { classifyCommand, detectOutcome } from '../shared/commands';
import { detectSmells, type FileChange } from '../shared/smells';
import {
  lastGreen,
  verificationFor,
  type BurstIntent,
  type ChangeBurst,
} from '../shared/activity';
import {
  claimedTasks,
  formatTaskForAgent,
  mergeBoards,
  type Board,
  type PathContext,
} from '../shared/tasks';
import {
  attribute,
  INTENT_TTL_MS,
  type Attributed,
  type LiveAgentInfo,
  type RecordedIntent,
  type TaskClaim,
} from '../shared/attribution';
import { changedRanges, type BurstEdit } from '../shared/conflicts';
import { AgentRegistry, type AgentsSnapshot } from './services/roster';
import {
  auditSummary,
  type Chapter,
  type SessionSummary,
  type SummaryAudit,
} from '../shared/session';
import type {
  ChangeEvent,
  CommandLogEntry,
  FileTreeNode,
  GraphPatch,
  NodeDetails,
  ProjectInfo,
  ReviewState,
  SymbolGraph,
} from '../shared/types';
import { GitService } from './services/git';
import { ShadowService } from './services/shadow';
import { WatcherService } from './services/watcher';
import { ProjectStore } from './services/store';
import type { LoggedCommand } from './services/agents';

export interface SessionEvents {
  onGraphPatch: (patch: GraphPatch) => void;
  onFilesChanged: (event: ChangeEvent) => void;
  onGitStatus: (status: import('../shared/types').GitStatus) => void;
  onTreeChanged: (tree: FileTreeNode) => void;
  onShadowSnapshot: (hash: string) => void;
  onCoverage: (coverage: CoverageMap) => void;
  /** The activity log changed: a burst opened, closed, or was re-verified. */
  onActivity: (bursts: ChangeBurst[]) => void;
  /** A logged command gained an outcome (or finished). */
  onCommandUpdate: (command: CommandLogEntry) => void;
  /** A command classified as hard-to-undo just started. */
  onDangerousCommand: (command: CommandLogEntry) => void;
  /** The task board changed (by you, or by an agent over MCP). */
  onBoard: (board: Board) => void;
  /** An agent arrived, went quiet, or claimed or released files. */
  onAgents: (snapshot: AgentsSnapshot) => void;
  /** An agent wrote down what it did this session. */
  onSummaries: (summaries: SessionSummary[]) => void;
}

/** Writes closer together than this belong to the same burst. */
const BURST_GAP_MS = Number(process.env.FLARE_BURST_GAP_MS) || 25_000;
/** Per-terminal output kept for reading verification verdicts. */
const TERM_BUFFER_MAX = 250_000;
const MAX_BURSTS = 120;
/** Files bigger than this are tracked for the graph but not diffed for smells. */
const MAX_SMELL_BYTES = 400_000;

interface FileState {
  /** undefined = never seen before this session (fall back to git HEAD) */
  beforeText: string | null | undefined;
  afterText: string | null;
  beforeParsed: import('../shared/types').ParsedFile | null | undefined;
  afterParsed: import('../shared/types').ParsedFile | null;
  added: boolean;
}

const LCOV_CANDIDATES = ['coverage/lcov.info', 'lcov.info', 'coverage/lcov/lcov.info', '.coverage/lcov.info'];

/** Cheap identity for a coverage map, to tell a real change from a re-stat. */
function signature(coverage: CoverageMap): string {
  const keys = Object.keys(coverage).sort();
  return `${keys.length}:${keys.map((k) => `${k}=${coverage[k].hit}/${coverage[k].found}`).join(',')}`;
}

/** One open project: graph state, watcher, git, shadow history, persistence. */
export class ProjectSession {
  readonly root: string;
  readonly git: GitService;
  readonly shadow: ShadowService;
  readonly store: ProjectStore;
  private builder: GraphBuilder;
  private watcher: WatcherService | null = null;
  private fileTree: FileTreeNode;
  /** path -> last change epoch ms (for review/heat). */
  readonly changedAt: Record<string, number> = {};
  /** path -> who made the last change ('you' or an agent name). */
  readonly changedBy: Record<string, string> = {};
  /** Injected by the agent monitor: who is active right now. */
  /**
   * Who is running, and where — the raw material for attributing a write.
   *
   * It reports candidates rather than an answer: with two agents live, only
   * the board can say which of them a given file belongs to. See
   * `attributeWrite` and shared/attribution.ts.
   */
  attributionProvider: (() => { agent: string; live: readonly LiveAgentInfo[] }) | null = null;
  /** Shell commands observed in the app's terminals (newest last). */
  readonly commands: CommandLogEntry[] = [];
  private commandsFile: string;
  /** Latest ingested line coverage (lcov), keyed by project-relative path. */
  coverage: CoverageMap = {};
  private watchedCoverageFiles: string[] = [];
  private knownFiles = new Set<string>();
  private gitTimer: NodeJS.Timeout | null = null;
  private shadowTimer: NodeJS.Timeout | null = null;
  private pendingSnapshotFiles = new Set<string>();
  private disposed = false;

  // ---- activity log: bursts, their evidence and their smells ----
  private bursts: ChangeBurst[] = [];
  /** burstId -> path -> before/after content, for the smell rules */
  private burstStates = new Map<string, Map<string, FileState>>();
  /** burstId -> path -> importer count before the burst touched it */
  private burstDegree = new Map<string, Map<string, number>>();
  /** last content we saw for a file, so the next change has a "before" */
  private lastKnown = new Map<string, { text: string | null; parsed: import('../shared/types').ParsedFile | null }>();
  /** terminalId -> recent output, for reading test verdicts */
  private termBuffers = new Map<string, { text: string; dropped: number }>();
  /** pid -> where in its terminal's output the command started */
  private commandStarts = new Map<number, { terminalId: string; offset: number }>();
  private pendingIntent: BurstIntent | null = null;
  /**
   * What each agent announced it was about to do, one entry per MCP session.
   *
   * Per session rather than one global "latest": with two agents running, a
   * single slot means whichever of them called `record_intent` last owns every
   * write for the next ten minutes, including the other's. Keeping them apart
   * is what lets attribution say "several announced, and the claims separate
   * them" instead of confidently naming the wrong one.
   */
  private activeIntents = new Map<string, RecordedIntent>();
  private callerLabels = new Map<string, string>();
  /**
   * Who is connected over MCP, and the room they talk in.
   *
   * The identity layer everything multi-agent rests on: the roster turns a
   * session id into "Claude 2", and the channel turns "I am taking these
   * files" into something the other agents, the graph and the review can all
   * read. See shared/roster.ts and shared/channel.ts.
   */
  readonly agents: AgentRegistry;

  constructor(
    root: string,
    storageRoot: string,
    private events: SessionEvents,
  ) {
    // normalize separators so path-prefix checks work regardless of input form
    this.root = path.resolve(root);
    this.git = new GitService(this.root);
    this.shadow = new ShadowService(this.root, storageRoot);
    this.store = new ProjectStore(this.root, storageRoot);
    const hash = crypto.createHash('sha1').update(this.root.toLowerCase()).digest('hex').slice(0, 16);
    this.commandsFile = path.join(storageRoot, 'projects', `${hash}-commands.jsonl`);
    this.loadCommandHistory();
    this.builder = new GraphBuilder(this.loadResolverOptions());
    this.fileTree = { name: path.basename(root), path: '', type: 'dir', children: [] };
    this.agents = new AgentRegistry(
      (snapshot) => {
        if (!this.disposed) this.events.onAgents(snapshot);
      },
      () => [...new Set((this.attributionProvider?.().live ?? []).map((a) => a.agent))],
    );
    this.agents.start();
  }

  private loadResolverOptions(allFiles?: string[]): ResolverOptions {
    const opts: ResolverOptions = {};
    for (const name of ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json']) {
      const tsPaths = this.tsPathsFrom(name, 0);
      if (tsPaths.length > 0) {
        opts.tsPaths = tsPaths;
        break;
      }
    }
    if (allFiles) {
      const manifests: { path: string; json: unknown }[] = [];
      for (const rel of allFiles) {
        if (!rel.endsWith('package.json')) continue;
        try {
          manifests.push({ path: rel, json: parseJsonc(fs.readFileSync(path.join(this.root, rel), 'utf8')) });
        } catch {
          // unreadable or malformed manifest — skip it
        }
      }
      const workspaces = workspacePackagesFrom(manifests);
      if (workspaces.length > 0) opts.workspaces = workspaces;
    }
    return opts;
  }

  /**
   * Path mappings from a config and everything it extends.
   *
   * Monorepos routinely keep `paths` in a `tsconfig.base.json` that each
   * package's own config extends; reading only the entry file finds nothing
   * and every cross-package import silently becomes "external".
   */
  private tsPathsFrom(relPath: string, depth: number): TsPathMapping[] {
    if (depth > 5) return [];
    let config: unknown;
    try {
      config = parseJsonc(fs.readFileSync(path.join(this.root, relPath), 'utf8'));
    } catch {
      return []; // missing/broken config — fine
    }
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    const own = tsPathsFromConfig(config, dir);
    const extend = (config as { extends?: unknown }).extends;
    if (typeof extend !== 'string' || !extend.startsWith('.')) return own;
    const parentRel = path.posix.normalize(path.posix.join(dir, extend));
    // nearest config wins, so its mappings are tried first
    return [...own, ...this.tsPathsFrom(/\.json$/.test(parentRel) ? parentRel : `${parentRel}.json`, depth + 1)];
  }

  /** Files git knew about when the project opened — used to tell "added" from "edited". */
  private gitTrackedAtOpen = new Set<string>();

  /** Initial scan + watcher + shadow init. Returns full project info. */
  async open(): Promise<ProjectInfo> {
    const scan = scanProject(this.root);
    for (const f of scan.allFiles) this.gitTrackedAtOpen.add(f);
    this.fileTree = scan.fileTree;
    // workspace packages can only be found once the tree has been walked, and
    // they change which imports resolve — so settle the options before building
    this.builder.setResolverOptions(this.loadResolverOptions(scan.allFiles));
    const graph = this.builder.setAll(scan.parsed);
    const gitStatus = await this.git.status();
    const now = Date.now();
    for (const p of Object.keys(gitStatus.files)) this.changedAt[p] = now;

    await this.shadow.init().catch(() => {
      // shadow history is best-effort
    });
    void this.shadow.snapshot('session start');

    const ig = buildIgnore(this.root);
    this.watcher = new WatcherService(this.root, ig, (batch) => this.handleBatch(batch));
    this.watcher.start();

    this.knownFiles = new Set(scan.allFiles);
    for (const f of scan.parsed) this.knownFiles.add(f.path);
    this.loadCoverage();
    // fs.watchFile stat-polls, so it works even before coverage/ exists
    // Four candidate paths are watched and each fires on its first stat, even
    // for files that do not exist — so only announce a reload when the numbers
    // actually moved, or opening a project emits a burst of identical toasts.
    let coverageSignature = signature(this.coverage);
    const reload = () => {
      this.loadCoverage();
      const next = signature(this.coverage);
      if (next === coverageSignature) return;
      coverageSignature = next;
      if (!this.disposed) this.events.onCoverage(this.coverage);
    };
    for (const candidate of LCOV_CANDIDATES) {
      const abs = path.join(this.root, candidate);
      fs.watchFile(abs, { interval: 2000 }, reload);
      this.watchedCoverageFiles.push(abs);
    }

    return {
      root: this.root,
      name: path.basename(this.root),
      fileTree: this.fileTree,
      graph,
      git: gitStatus,
    };
  }

  /**
   * Attribute one write, board first.
   *
   * The claim beats the process list: two `claude` sessions are equally
   * "running" in every sample, but only one of them claimed the card that
   * names this file.
   */
  private attributeWrite(paths: string[]): Attributed {
    const status = this.attributionProvider?.();
    const working = this.agents.working();
    if (!status && this.activeIntents.size === 0 && working.size === 0) {
      return { agent: 'you', basis: 'unknown' };
    }
    const claims: TaskClaim[] = claimedTasks(this.store.board).map((t) => ({
      id: t.id,
      title: t.title,
      paths: t.paths,
      by: t.notes[t.notes.length - 1]?.by ?? 'you',
    }));
    return attribute({
      paths,
      live: status?.live ?? [],
      claims,
      working,
      // a label or a name settled after the intent was recorded still applies
      // to it: claiming a card, naming yourself and announcing an edit are
      // three separate acts by one agent, in whatever order it makes them
      intents: [...this.activeIntents.values()].map((intent) => ({
        ...intent,
        label: this.callerLabels.get(intent.id) ?? intent.label,
        name: this.agents.get(intent.id)?.name ?? intent.name ?? null,
      })),
    });
  }

  /**
   * An MCP caller moved a card — that is how it tells us what to call it.
   *
   * Claiming work and announcing an edit are separate acts by the same agent,
   * so the name is remembered against the session rather than against the
   * intent: claim first and record intent later, or the other way round, and
   * the ring on the graph reads the same either way.
   */
  noteClaim(callerId: string | null, title: string): void {
    if (!callerId) return;
    this.callerLabels.set(callerId, title);
    this.agents.noteCall(callerId, { task: title });
  }

  private handleBatch(batch: { changed: string[]; removed: string[] }): void {
    if (this.disposed) return;
    const now = Date.now();
    const attributed = this.attributeWrite([...batch.changed, ...batch.removed]);
    const agent = attributed.agent;
    const burst = this.openBurst(attributed, now);
    const states = this.burstStates.get(burst.id)!;

    const parsedChanges = [];
    let treeDirty = batch.removed.length > 0;
    /* files this agent had not already written in this burst — the roster
       counts files touched, not writes, so saving one file twice is one file */
    let firstWrites = 0;
    for (const rel of batch.changed) {
      this.changedAt[rel] = now;
      this.knownFiles.add(rel);
      const parsed = parseFileFromDisk(this.root, rel);
      if (parsed) parsedChanges.push(parsed);
      this.trackFileState(states, rel, parsed, false);
      if (!burst.changed.includes(rel)) {
        burst.changed.push(rel);
        firstWrites++;
      }
      treeDirty = true;
      this.pendingSnapshotFiles.add(rel);
    }
    this.agents.noteWrites(attributed.agentId, firstWrites);
    for (const rel of batch.removed) {
      this.changedAt[rel] = now;
      this.knownFiles.delete(rel);
      this.trackFileState(states, rel, null, true);
      if (!burst.removed.includes(rel)) burst.removed.push(rel);
      this.pendingSnapshotFiles.add(rel);
    }
    burst.endedAt = now;

    const degreeBefore = new Map<string, number>();
    for (const n of this.builder.getGraph().nodes) degreeBefore.set(n.id, n.inDegree);

    const removedCode = batch.removed.filter((r) => CODE_EXTENSIONS.has(extname(r).toLowerCase()));
    const patch = this.builder.apply(parsedChanges, removedCode);
    this.recordDegreeDelta(burst.id, degreeBefore);
    if (
      patch.addedNodes.length ||
      patch.updatedNodes.length ||
      patch.removedNodeIds.length ||
      patch.addedEdges.length ||
      patch.removedEdges.length
    ) {
      this.events.onGraphPatch(patch);
    }
    for (const rel of [...batch.changed, ...batch.removed]) this.changedBy[rel] = agent;
    this.events.onFilesChanged({ changed: batch.changed, removed: batch.removed, time: now, agent });

    if (treeDirty) this.refreshTree();

    if (this.gitTimer) clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(() => {
      void this.git.status().then((s) => {
        if (!this.disposed) this.events.onGitStatus(s);
      });
    }, 400);

    if (this.shadowTimer) clearTimeout(this.shadowTimer);
    this.shadowTimer = setTimeout(() => void this.takeSnapshot(), 1500);
  }

  private async takeSnapshot(): Promise<void> {
    const files = [...this.pendingSnapshotFiles];
    this.pendingSnapshotFiles.clear();
    if (files.length === 0) return;
    const label = files.length <= 3 ? files.join(', ') : `${files.slice(0, 3).join(', ')} +${files.length - 3} more`;
    const hash = await this.shadow.snapshot(label);
    if (hash && !this.disposed) this.events.onShadowSnapshot(hash);
    const burst = this.bursts[this.bursts.length - 1];
    if (burst) {
      if (hash) burst.snapshotHash = hash;
      await this.finalizeBurst(burst);
    }
  }

  // ------------------------------------------------------------------
  // activity log
  // ------------------------------------------------------------------

  /**
   * Extend the open burst, or start one. Same author + close in time = same burst.
   *
   * "Same author" is the *identity* where we have one: two agents writing
   * alternate files a second apart are two bursts, and merging them would
   * hide the very crossing the review panel is there to draw.
   */
  private openBurst(attributed: Attributed, now: number): ChangeBurst {
    const agent = attributed.agent;
    const last = this.bursts[this.bursts.length - 1];
    const sameAuthor = attributed.agentId
      ? last?.agentId === attributed.agentId
      : last?.agent === agent && !last?.agentId;
    if (last && sameAuthor && now - last.endedAt < BURST_GAP_MS) {
      if (this.pendingIntent && !last.intent) {
        last.intent = this.pendingIntent;
        this.pendingIntent = null;
      }
      return last;
    }
    const burst: ChangeBurst = {
      id: `b${now.toString(36)}${this.bursts.length}`,
      startedAt: now,
      endedAt: now,
      agent,
      agentId: attributed.agentId,
      agentName: attributed.agentName,
      agentLabel: attributed.agentLabel,
      changed: [],
      removed: [],
      smells: [],
      verification: 'not-run',
      verifiedBy: null,
      checks: [],
      intent: this.pendingIntent,
      snapshotHash: null,
    };
    this.pendingIntent = null;
    this.bursts.push(burst);
    this.burstStates.set(burst.id, new Map());
    this.burstDegree.set(burst.id, new Map());
    while (this.bursts.length > MAX_BURSTS) {
      const dropped = this.bursts.shift()!;
      this.burstStates.delete(dropped.id);
      this.burstDegree.delete(dropped.id);
    }
    return burst;
  }

  private trackFileState(
    states: Map<string, FileState>,
    rel: string,
    parsed: import('../shared/types').ParsedFile | null,
    removed: boolean,
  ): void {
    const text = removed ? null : this.readFileForDiff(rel);
    const previous = this.lastKnown.get(rel);
    const existing = states.get(rel);
    if (existing) {
      existing.afterText = text;
      existing.afterParsed = parsed;
    } else {
      states.set(rel, {
        beforeText: previous ? previous.text : undefined,
        beforeParsed: previous ? previous.parsed : undefined,
        afterText: text,
        afterParsed: parsed,
        added: previous === undefined && !this.knownFilesHadBefore(rel),
      });
    }
    if (removed) this.lastKnown.delete(rel);
    else this.lastKnown.set(rel, { text, parsed });
  }

  /** A file counts as pre-existing if git knows about it. */
  private knownFilesHadBefore(rel: string): boolean {
    return this.gitTrackedAtOpen.has(rel);
  }

  private readFileForDiff(rel: string): string | null {
    try {
      const abs = this.resolveInRoot(rel);
      if (!abs) return null;
      const stat = fs.statSync(abs);
      if (stat.size > MAX_SMELL_BYTES) return null;
      return fs.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  }

  private recordDegreeDelta(burstId: string, before: Map<string, number>): void {
    const record = this.burstDegree.get(burstId);
    if (!record) return;
    for (const [path, value] of before) {
      if (!record.has(path)) record.set(path, value);
    }
  }

  /** Attach smells + verification once a burst's snapshot has landed. */
  private async finalizeBurst(burst: ChangeBurst): Promise<void> {
    const states = this.burstStates.get(burst.id);
    if (states && states.size > 0) {
      const files: FileChange[] = [];
      for (const [path, st] of states) {
        let beforeText = st.beforeText;
        if (beforeText === undefined) {
          // first time we have seen this file change — ask git what it was
          beforeText = await this.git.showHead(path).catch(() => null);
        }
        files.push({
          path,
          beforeText: beforeText ?? null,
          afterText: st.afterText,
          beforeParsed: st.beforeParsed ?? null,
          afterParsed: st.afterParsed,
          removed: burst.removed.includes(path),
          added: st.added && beforeText === null,
        });
      }
      const graph = this.builder.getGraph();
      const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
      const degreeBefore = this.burstDegree.get(burst.id) ?? new Map<string, number>();
      const degreeDelta: { path: string; before: number; after: number }[] = [];
      for (const n of graph.nodes) {
        const before = degreeBefore.get(n.id);
        if (before !== undefined && before !== n.inDegree) {
          degreeDelta.push({ path: n.id, before, after: n.inDegree });
        }
      }
      burst.smells = detectSmells({
        files,
        nodes,
        importersOf: (p) => this.builder.importersOf(p).map((i) => i.importer),
        degreeDelta,
        hasTests: graph.nodes.some((n) => n.isTest),
      });
    }
    this.recomputeVerification();
    if (!this.disposed) this.events.onActivity(this.bursts);
  }

  private recomputeVerification(): void {
    for (let i = 0; i < this.bursts.length; i++) {
      const next = this.bursts[i + 1];
      const result = verificationFor(this.bursts[i], this.commands, next ? next.startedAt : Infinity);
      this.bursts[i].verification = result.state;
      this.bursts[i].verifiedBy = result.by;
      this.bursts[i].checks = result.checks;
    }
  }

  getBursts(): ChangeBurst[] {
    return this.bursts;
  }

  // ------------------------------------------------------------------
  // what an agent says it did
  // ------------------------------------------------------------------

  /**
   * One summary per author, newest kept.
   *
   * Per author rather than per session: with three agents there are three
   * stories, each answerable only for its own writes. And the newest replaces
   * the older one, because the usual reason an agent writes a second is that
   * Flare's audit told it the first was wrong — keeping both would leave the
   * corrected version sitting under the mistake it fixed.
   */
  private summaries: SessionSummary[] = [];

  getSummaries(): SessionSummary[] {
    return this.summaries;
  }

  /**
   * Record what an agent says it did, and hand back what actually happened.
   *
   * The window is derived here rather than asked for: it runs from the
   * author's first write of the session to its last, which is a fact Flare
   * has and the agent would have to guess. A summary audited against the
   * wrong window is worse than none.
   */
  recordSummary(
    by: string,
    byName: string,
    headline: string,
    chapters: Chapter[],
  ): { summary: SessionSummary; audit: SummaryAudit } {
    const now = Date.now();
    const mine = this.bursts.filter((b) => (b.agentId ? b.agentId === by : b.agent === by));
    const summary: SessionSummary = {
      id: `s${now.toString(36)}`,
      by,
      byName,
      at: now,
      from: mine.length > 0 ? mine[0].startedAt : now,
      to: now,
      headline,
      chapters,
    };
    this.summaries = [...this.summaries.filter((s) => s.by !== by), summary];
    if (!this.disposed) this.events.onSummaries(this.summaries);
    return { summary, audit: auditSummary(summary, this.bursts) };
  }

  /**
   * Which lines each burst wrote, per file.
   *
   * The renderer has the bursts but not the text behind them, and without the
   * lines a conflict can only say "two agents wrote this file" — not whether
   * the second one wrote *over* the first. That difference is the whole
   * severity gap between a note and an alarm, so it is worth an extra channel.
   */
  getBurstEdits(): BurstEdit[] {
    const out: BurstEdit[] = [];
    for (const burst of this.bursts) {
      const states = this.burstStates.get(burst.id);
      if (!states) continue;
      for (const [path, state] of states) {
        const before = state.beforeText === undefined ? null : state.beforeText;
        const ranges = changedRanges(before, state.afterText);
        // `added` the same way finalizeBurst reads it: the flag alone is true
        // for a file we simply had not seen yet, which is not the same as one
        // that did not exist
        if (ranges.length > 0) {
          out.push({ burstId: burst.id, path, ranges, added: state.added && before === null });
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // task board
  // ------------------------------------------------------------------

  getBoard(): Board {
    return this.store.board;
  }

  /**
   * Recent revisions, so a writer that is behind can be caught up rather than
   * believed.
   *
   * Short on purpose: it exists to cover the seconds between a panel being
   * rendered and a button in it being clicked, not to be a history. Anything
   * older falls back to the union merge, which loses nothing either.
   */
  private boardHistory: Board[] = [];

  /**
   * Accept a board, from whoever is writing it.
   *
   * Every writer goes through here — the panel, the MCP tools, the web client
   * — and they do not take turns. The MCP tools read and write in the same
   * tick so they are always current; the UI holds a snapshot for as long as
   * someone is looking at it, and with agents running that snapshot goes stale
   * in seconds. Rebasing it here means the panel does not need to know that.
   */
  setBoard(board: Board): void {
    const current = this.store.board;
    const from = typeof board.rev === 'number' ? board.rev : current.rev;
    const rebased =
      from === current.rev
        ? board
        : mergeBoards(this.boardHistory.find((b) => b.rev === from) ?? null, current, board);
    const next = { ...rebased, rev: current.rev + 1 };

    this.boardHistory.push(current);
    if (this.boardHistory.length > 16) this.boardHistory.shift();
    this.store.setBoard(next);
    if (!this.disposed) this.events.onBoard(next);
  }

  /** What the graph knows about a set of paths — travels with a task's brief. */
  pathContext(paths: string[]): Record<string, PathContext> {
    const graph = this.builder.getGraph();
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const out: Record<string, PathContext> = {};
    for (const path of paths) {
      const node = byId.get(path);
      if (!node) continue;
      out[path] = {
        blastRadius: this.builder.blastRadius(path),
        fanIn: node.inDegree,
        coveragePct: this.coverage[path]?.pct ?? null,
        testedBy: node.testedBy,
        inCycle: node.cycleId !== null,
      };
    }
    return out;
  }

  /**
   * The exact text a human would paste. The UI's copy button and the MCP
   * `task_get` tool both call this, so an agent that pulls its own task reads
   * what a human would have handed it.
   */
  formatTask(taskId: string): string | null {
    const board = this.store.board;
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    return formatTaskForAgent(task, this.pathContext(task.paths), board.lanes.find((l) => l.id === task.laneId));
  }

  /**
   * Record what the agent said it was doing. Attaches to the open burst if
   * there is one, otherwise waits for the next — agents usually announce
   * intent just before they start editing.
   */
  /**
   * What an agent says it is about to do — and, now, which agent said it.
   *
   * The caller id is the MCP session, and it is the strongest attribution
   * signal Flare has: the writes that follow belong to whoever announced them,
   * whatever card the files happen to be listed on. Anonymous callers (a
   * client that never echoed the session header) behave exactly as before.
   */
  setIntent(
    goal: string,
    ruledOut: string | undefined,
    source: 'agent' | 'you',
    callerId?: string | null,
  ): void {
    if (callerId) {
      const agent = this.agents.noteCall(callerId, { doing: goal });
      this.activeIntents.set(callerId, {
        id: callerId,
        label: this.callerLabels.get(callerId) ?? null,
        // the roster's answer first: it comes from what the client called
        // itself, while the process list can only say what is running
        tool: agent?.tool ?? this.attributionProvider?.().live[0]?.agent ?? null,
        name: agent?.name ?? null,
        at: Date.now(),
      });
      // an intent that has lapsed is not evidence about anything, and holding
      // one per session for a whole day is how this map becomes a leak
      for (const [id, intent] of this.activeIntents) {
        if (Date.now() - intent.at >= INTENT_TTL_MS) this.activeIntents.delete(id);
      }
    }
    const intent: BurstIntent = { goal, ruledOut, at: Date.now(), source };
    const last = this.bursts[this.bursts.length - 1];
    if (last && Date.now() - last.endedAt < BURST_GAP_MS) {
      last.intent = intent;
      if (!this.disposed) this.events.onActivity(this.bursts);
    } else {
      this.pendingIntent = intent;
    }
  }

  /** The newest snapshot whose burst was verified green. */
  lastGreenSnapshot(): { hash: string; at: number } | null {
    const green = lastGreen(this.bursts);
    return green?.snapshotHash ? { hash: green.snapshotHash, at: green.endedAt } : null;
  }

  // ------------------------------------------------------------------
  // terminal output + command lifecycle
  // ------------------------------------------------------------------

  /** Feed terminal output in so verification verdicts can be read from it. */
  noteTerminalOutput(terminalId: string, data: string): void {
    const buf = this.termBuffers.get(terminalId) ?? { text: '', dropped: 0 };
    buf.text += data;
    if (buf.text.length > TERM_BUFFER_MAX) {
      const cut = buf.text.length - TERM_BUFFER_MAX;
      buf.text = buf.text.slice(cut);
      buf.dropped += cut;
    }
    this.termBuffers.set(terminalId, buf);
  }

  /** A command's process exited: read its verdict and re-verify the bursts. */
  endCommand(pid: number): void {
    const entry = [...this.commands].reverse().find((c) => c.pid === pid && c.endedAt === undefined);
    if (!entry) return;
    entry.endedAt = Date.now();
    const start = this.commandStarts.get(pid);
    if (entry.kind === 'verify' && start) {
      const buf = this.termBuffers.get(start.terminalId);
      if (buf) {
        const from = Math.max(0, start.offset - buf.dropped);
        const { outcome, evidence } = detectOutcome(buf.text.slice(from));
        entry.outcome = outcome;
        entry.evidence = evidence;
      }
    }
    this.commandStarts.delete(pid);
    this.recomputeVerification();
    if (!this.disposed) {
      this.events.onCommandUpdate(entry);
      this.events.onActivity(this.bursts);
    }
  }

  /** Mark a file as actually read by a human (not just approved). */
  markRead(paths: string[]): void {
    this.store.markRead(paths);
  }

  getProjectInfo(): Omit<ProjectInfo, 'git'> {
    return {
      root: this.root,
      name: path.basename(this.root),
      fileTree: this.fileTree,
      graph: this.builder.getGraph(),
    };
  }

  nodeDetails(id: string): NodeDetails | null {
    const node = this.builder.getGraph().nodes.find((n) => n.id === id);
    if (!node) return null;
    const { dependents, dependencies } = this.builder.neighbors(id);
    return { node, dependents, dependencies, blastRadius: this.builder.blastRadius(id) };
  }

  getGraphData() {
    return this.builder.getGraph();
  }

  private insightsCache: { at: number; value: Insights } | null = null;
  private churnCache: Record<string, number> | null = null;

  /** Full insights (metrics + issues), cached briefly — used by the MCP server. */
  async getInsights(): Promise<Insights> {
    if (this.insightsCache && Date.now() - this.insightsCache.at < 5000) {
      return this.insightsCache.value;
    }
    if (!this.churnCache) this.churnCache = await this.git.churn();
    const snapshots = await this.shadow.timeline(300);
    const graph = this.builder.getGraph();
    const value = computeInsights({
      nodes: graph.nodes,
      edges: graph.edges,
      churn: this.churnCache,
      coverage: this.coverage,
      changedAt: this.changedAt,
      changedBy: this.changedBy,
      review: this.store.review,
      snapshots,
    });
    this.insightsCache = { at: Date.now(), value };
    return value;
  }

  symbolGraph(id: string): SymbolGraph | null {
    const parsed = this.builder.getFile(id);
    if (!parsed) return null;
    const content = this.readFile(id);
    if (content === null) return null;
    return buildSymbolGraph(parsed, content, this.builder.importersOf(id));
  }

  private resolveInRoot(rel: string): string | null {
    const abs = path.resolve(this.root, toPosix(rel));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) return null;
    return abs;
  }

  readFile(rel: string): string | null {
    try {
      const abs = this.resolveInRoot(rel);
      return abs ? fs.readFileSync(abs, 'utf8') : null;
    } catch {
      return null;
    }
  }

  /**
   * A file as a data: URL, for the things the preview shows rather than reads.
   *
   * Images are bytes, so they cannot come back through readFile's utf8 path,
   * and a custom protocol would be a second surface to get path-escaping wrong
   * on. resolveInRoot already guards this one, and a data URL cannot reach
   * outside the string it is in.
   */
  readFileDataUrl(rel: string): string | null {
    try {
      const abs = this.resolveInRoot(rel);
      if (!abs) return null;
      const mime = imageMime(rel);
      if (!mime) return null;
      const stat = fs.statSync(abs);
      // a preview is not worth holding tens of megabytes of base64 in the
      // renderer; past this the pane says so instead
      if (stat.size > 12 * 1024 * 1024) return null;
      return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
    } catch {
      return null;
    }
  }

  writeFile(rel: string, content: string): boolean {
    try {
      const abs = this.resolveInRoot(rel);
      if (!abs) return false;
      fs.writeFileSync(abs, content, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find text across the project.
   *
   * Walks every scanned file — the same set the graph and the tree know, so
   * .gitignore and the default ignores already apply — skipping obvious
   * binaries by name and anything too large to be source. Synchronous reads
   * on purpose: a project of a few thousand files answers in tens of
   * milliseconds, and streaming results would be machinery for a delay
   * nobody notices.
   */
  searchText(query: string, options: SearchOptions = {}): SearchHit[] {
    const pattern = compileQuery(query, options);
    if (!pattern) return [];
    const hits: SearchHit[] = [];
    for (const rel of [...this.knownFiles].sort()) {
      if (!isSearchableFile(rel)) continue;
      const abs = this.resolveInRoot(rel);
      if (!abs) continue;
      let text: string;
      try {
        if (fs.statSync(abs).size > MAX_SEARCH_FILE_BYTES) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue;
      for (const hit of searchText(rel, text, pattern)) {
        hits.push(hit);
        if (hits.length >= MAX_SEARCH_HITS) return hits;
      }
    }
    return hits;
  }

  /**
   * Replace across files — the same pattern the search used, applied to the
   * files it hit (or the subset asked for). Every write goes through
   * writeFile, so the watcher sees it like any other edit: it lands in the
   * activity, the review and the local history the same way an agent's
   * write would.
   */
  replaceText(
    query: string,
    replacement: string,
    options: SearchOptions = {},
    onlyPaths?: readonly string[],
  ): { files: number; replacements: number } {
    const pattern = compileQuery(query, options);
    if (!pattern) return { files: 0, replacements: 0 };
    const wanted = onlyPaths ? new Set(onlyPaths) : null;
    let files = 0;
    let replacements = 0;
    for (const rel of this.knownFiles) {
      if (wanted && !wanted.has(rel)) continue;
      if (!isSearchableFile(rel)) continue;
      const abs = this.resolveInRoot(rel);
      if (!abs) continue;
      let text: string;
      try {
        if (fs.statSync(abs).size > MAX_SEARCH_FILE_BYTES) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue;
      const result = replaceText(text, pattern, replacement);
      if (result.count === 0) continue;
      if (this.writeFile(rel, result.text)) {
        files++;
        replacements += result.count;
      }
    }
    return { files, replacements };
  }

  private loadCoverage(): void {
    for (const candidate of LCOV_CANDIDATES) {
      try {
        const text = fs.readFileSync(path.join(this.root, candidate), 'utf8');
        this.coverage = resolveCoverage(parseLcov(text), this.knownFiles, this.root);
        return;
      } catch {
        // try the next candidate
      }
    }
    this.coverage = {};
  }

  private loadCommandHistory(): void {
    try {
      const lines = fs.readFileSync(this.commandsFile, 'utf8').trim().split('\n').slice(-200);
      for (const line of lines) {
        try {
          this.commands.push(JSON.parse(line) as LoggedCommand);
        } catch {
          // skip corrupt line
        }
      }
    } catch {
      // no history yet
    }
  }

  recordCommand(command: LoggedCommand): void {
    const kind = classifyCommand(command.command);
    const entry: CommandLogEntry = { ...command, kind };
    if (kind === 'verify') {
      const buf = this.termBuffers.get(entry.terminalId);
      this.commandStarts.set(entry.pid, {
        terminalId: entry.terminalId,
        offset: buf ? buf.dropped + buf.text.length : 0,
      });
    }
    this.commands.push(entry);
    if (this.commands.length > 500) this.commands.splice(0, this.commands.length - 500);
    fs.appendFile(this.commandsFile, `${JSON.stringify(entry)}\n`, () => {
      // best-effort persistence
    });
    if (kind === 'destructive' && !this.disposed) {
      // we notice ~a second in, so this is a best-effort floor rather than a
      // true "before" — the burst snapshots are the real safety net
      void this.shadow.snapshot(`before: ${entry.command.slice(0, 80)}`).then((hash) => {
        if (hash && !this.disposed) this.events.onShadowSnapshot(hash);
      });
      this.events.onDangerousCommand(entry);
    }
    this.recomputeVerification();
    if (kind === 'verify' && !this.disposed) this.events.onActivity(this.bursts);
  }

  /**
   * Re-scan the tree and push it to the renderer. Explicit file operations call
   * this directly instead of waiting for the watcher: chokidar batches can be
   * delayed (or coalesced away) under load, and a stale tree after the user
   * just created or deleted something reads as a broken app.
   */
  private refreshTree(): void {
    if (this.disposed) return;
    const scan = scanProject(this.root, { parse: false });
    this.fileTree = scan.fileTree;
    this.events.onTreeChanged(this.fileTree);
  }

  /**
   * Re-read the folder tree and git state from disk.
   *
   * The watcher keeps both live on its own, so this is the escape hatch for
   * when it misses something — a network share, a bulk checkout, an editor
   * that writes through a temp file. It deliberately does not rebuild the
   * graph: the parse is incremental and driven by the same watcher, and a
   * full re-parse here would fight it.
   */
  async refreshFromDisk(): Promise<void> {
    this.refreshTree();
    const status = await this.git.status();
    if (!this.disposed) this.events.onGitStatus(status);
  }

  /** Create an empty file (parent dirs included). Fails if it already exists. */
  createFile(rel: string): boolean {
    try {
      const abs = this.resolveInRoot(rel);
      if (!abs || fs.existsSync(abs)) return false;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '');
      this.refreshTree();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a directory (parents included). Fails if the path already exists.
   *
   * An empty directory holds no files, so the graph does not change and the
   * scanner has nothing to report — the tree refresh is what makes it appear.
   */
  createDir(rel: string): boolean {
    try {
      const abs = this.resolveInRoot(rel);
      if (!abs || fs.existsSync(abs)) return false;
      fs.mkdirSync(abs, { recursive: true });
      this.refreshTree();
      return true;
    } catch {
      return false;
    }
  }

  renameFile(fromRel: string, toRel: string): boolean {
    try {
      const from = this.resolveInRoot(fromRel);
      const to = this.resolveInRoot(toRel);
      if (!from || !to || !fs.existsSync(from) || fs.existsSync(to)) return false;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      this.refreshTree();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete files and/or folders. A shadow snapshot is taken FIRST so the
   * deletion is always restorable from the timeline.
   */
  async deleteFiles(rels: string[]): Promise<boolean> {
    await this.shadow.snapshot(`before deleting ${rels.slice(0, 3).join(', ')}${rels.length > 3 ? ` +${rels.length - 3}` : ''}`);
    let ok = true;
    for (const rel of rels) {
      try {
        const abs = this.resolveInRoot(rel);
        if (!abs) {
          ok = false;
          continue;
        }
        fs.rmSync(abs, { recursive: true, force: true });
      } catch {
        ok = false;
      }
    }
    this.refreshTree();
    return ok;
  }

  getReviewInfo(): {
    review: ReviewState;
    changedAt: Record<string, number>;
    changedBy: Record<string, string>;
  } {
    return { review: this.store.review, changedAt: this.changedAt, changedBy: this.changedBy };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.agents.stop();
    if (this.gitTimer) clearTimeout(this.gitTimer);
    if (this.shadowTimer) clearTimeout(this.shadowTimer);
    this.store.saveNow();
    for (const abs of this.watchedCoverageFiles) fs.unwatchFile(abs);
    await this.watcher?.dispose();
  }
}
