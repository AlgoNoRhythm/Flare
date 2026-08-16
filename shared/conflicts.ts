import type { ChangeBurst } from './activity';
import type { TierInput } from './review';
import type { Decision } from './tasks';

/**
 * Where two agents got in each other's way.
 *
 * One agent editing a repo is a diff. Several agents editing the same repo at
 * the same time is something a diff cannot show you: the file one of them
 * rewrote out from under another, the module three of them share, the two
 * proposals for the same decision. Nothing in a per-file view of the change
 * says "these two edits are about each other" — that fact only exists in the
 * *pairing*, and the pairing is exactly what gets lost when work is presented
 * one burst at a time.
 *
 * So this is the missing join: bursts crossed with each other, filtered to the
 * crossings a person would want to know about. Its output is drawn rather than
 * listed — a contested file is a two-tone ring on the graph and a collision is
 * an edge painted amber — so the bar for reporting one is the bar for putting
 * a mark on the map.
 *
 * Two rules keep it honest:
 *
 * - **Agent identity is the terminal, not the tool name.** Two `claude`
 *   sessions are two agents; `agentIdOf` is the only thing that decides who
 *   is who, and it prefers the terminal-scoped id when the session supplied
 *   one. Without that, every detector here is comparing an agent to itself.
 * - **A crossing is not a conflict.** Two agents touching `index.ts` an hour
 *   apart is ordinary work. What earns a mark is overlap in *lines*, overlap
 *   in *dependencies*, or overlap in *time* — and each detector says which.
 *
 * Pure, so the whole thing is unit-testable without a session.
 */

export type ConflictKind =
  /** two agents wrote the same file, and we cannot show the lines overlap */
  | 'contested-file'
  /** …and we can: the later agent replaced lines the earlier one had just written */
  | 'overwritten'
  /** one agent changed a file another agent's in-flight work depends on */
  | 'blast-collision'
  /** two agents each wrote a new file doing the same job */
  | 'divergent-duplicate'
  /** two agents proposed different decisions about the same files */
  | 'contradictory-decision';

export type ConflictSeverity = 'critical' | 'warning';

/** One side of a conflict — the terminal-scoped id, plus what to call it. */
export interface ConflictParty {
  id: string;
  label: string;
}

export interface Conflict {
  /** stable for a given pair + file, so a dismissal survives a re-compute */
  id: string;
  kind: ConflictKind;
  severity: ConflictSeverity;
  /** when the crossing became true — the later of the two events */
  at: number;
  /** the agent that acted last, then the one it acted on top of */
  agents: [ConflictParty, ConflictParty];
  /** files this is about, worst first */
  paths: string[];
  /** one quantified line — the words the briefing, the tick tooltip and the graph use */
  summary: string;
  /** the sentence under it, when there is more to say */
  detail: string;
  /** the bursts involved, later first */
  burstIds: string[];
}

/** The lines one burst wrote in one file: 1-based, inclusive, non-overlapping, ascending. */
export interface BurstEdit {
  burstId: string;
  path: string;
  ranges: readonly (readonly [number, number])[];
  /** the file did not exist before this burst — it was created, not edited */
  added?: boolean;
}

/**
 * What the graph knows about a file's shape.
 *
 * Only what the duplicate detector needs: two files doing the same job say so
 * through the names they export, and a file nothing imports yet is one nobody
 * has committed to.
 */
export interface FileShape {
  /** names of the top-level exported symbols */
  exports: readonly string[];
  /** direct importers */
  fanIn: number;
}

export interface ConflictInput {
  /** oldest first, as the activity service reports them */
  bursts: readonly ChangeBurst[];
  /** tiering inputs by path — supplies blast radius and whether anything covers it */
  metrics?: ReadonlyMap<string, TierInput>;
  /** path -> everything that transitively imports it, i.e. what breaks when it changes */
  dependents?: ReadonlyMap<string, readonly string[]>;
  /** per burst per file, the lines it wrote — lets `overwritten` quantify itself */
  edits?: readonly BurstEdit[];
  /** what the graph knows about each file's shape, for the duplicate detector */
  nodes?: ReadonlyMap<string, FileShape>;
  /** the board's design decisions, for the contradictory-proposal detector */
  decisions?: readonly Decision[];
  /** conflict ids already dismissed */
  dismissed?: ReadonlySet<string>;
  /** the human counts as an agent too — off, because you editing after an agent is the normal case */
  includeHuman?: boolean;
  limit?: number;
}

/**
 * Enough to read as "several". Past this the oldest fall off: a crossing
 * nobody has looked at in twenty changes has been answered by reviewing the
 * code, not by another mark on the map.
 */
export const CONFLICT_LIMIT = 20;

/**
 * How close two bursts have to be for one to count as *in flight* while the
 * other landed. Long enough to span an agent thinking between edits, short
 * enough that this morning's work is not "concurrent with" last night's.
 */
export const CONCURRENT_MS = 15 * 60_000;

/** A file has to matter to something before a collision on it is worth a mark. */
const COLLISION_MIN_DEPENDENTS = 1;

/**
 * How much two new files have to overlap before they are the same file twice.
 *
 * A share of the *smaller* file's exports, not of the union: a four-line
 * helper duplicated inside a thirty-export module is still a duplicated
 * helper, and dividing by the union would bury it.
 */
const DUPLICATE_MIN_SHARE = 0.5;

export function conflictId(kind: ConflictKind, a: string, b: string, subject: string): string {
  // the pair is unordered: A-then-B and B-then-A are the same standing fact
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${kind}::${x}|${y}::${subject}`;
}

/**
 * Who a burst belongs to.
 *
 * `agent` is the *tool* ('claude', 'you', 'mixed'); `agentId` is the terminal
 * it ran in. Only the second one tells two concurrent claudes apart, so it
 * wins wherever the session was able to supply it.
 */
export function agentIdOf(burst: ChangeBurst): string {
  return burst.agentId ?? burst.agent;
}

/** What to call that agent on screen — the task it claimed, else the tool. */
export function agentLabelOf(burst: ChangeBurst): string {
  return burst.agentLabel ?? burst.agent;
}

function partyOf(burst: ChangeBurst): ConflictParty {
  return { id: agentIdOf(burst), label: agentLabelOf(burst) };
}

/** An identity we cannot reason about: 'mixed' is "we could not tell", not an agent. */
function unattributed(id: string): boolean {
  return id === 'mixed' || id === '';
}

// ---------------------------------------------------------------------------
// line overlap
// ---------------------------------------------------------------------------

/**
 * The region of a file a write touched, as line ranges.
 *
 * Deliberately not a real diff: trim the common prefix and suffix and call
 * everything between them changed. That over-approximates a scattered edit
 * into one range, which is the right way to be wrong here — the question is
 * "did the second agent write over the first one's work", and a claim of
 * overlap that is slightly too eager is a mark on a file two agents really did
 * both edit. A real Myers diff would sharpen the *number* in the sentence
 * without changing which files get flagged.
 */
export function changedRanges(before: string | null, after: string | null): [number, number][] {
  if (after === null) return before === null ? [] : [[1, Math.max(1, before.split('\n').length)]];
  const next = after.split('\n');
  if (before === null) return next.length > 0 ? [[1, next.length]] : [];
  const prev = before.split('\n');

  let head = 0;
  while (head < prev.length && head < next.length && prev[head] === next[head]) head++;

  let tail = 0;
  while (
    tail < prev.length - head &&
    tail < next.length - head &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail++;
  }

  // identical files touch nothing
  if (head === prev.length && head === next.length) return [];

  const start = head + 1;
  const end = next.length - tail;
  // a pure deletion leaves no new lines: mark the seam so it still counts as a write
  return end < start ? [[start, start]] : [[start, end]];
}

function rangeLines(ranges: readonly (readonly [number, number])[]): number {
  let n = 0;
  for (const [a, b] of ranges) n += Math.max(0, b - a + 1);
  return n;
}

/** How many lines of `a` fall inside `b`. Both are ascending and non-overlapping. */
export function overlapLines(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[],
): number {
  let n = 0;
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      if (hi >= lo) n += hi - lo + 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// detectors
// ---------------------------------------------------------------------------

interface Write {
  burst: ChangeBurst;
  ranges: readonly (readonly [number, number])[];
}

/**
 * Every crossing worth a mark, worst first.
 *
 * One conflict per pair per subject: an agent that overwrites the same file
 * four times is one standing fact about that file, not four, and reporting it
 * four times would push the other three files off the screen.
 */
export function conflicts(input: ConflictInput): Conflict[] {
  const {
    bursts,
    metrics,
    dependents,
    edits,
    nodes,
    decisions,
    dismissed,
    includeHuman = false,
    limit = CONFLICT_LIMIT,
  } = input;

  const editIndex = new Map<string, readonly (readonly [number, number])[]>();
  const addedIndex = new Set<string>();
  for (const e of edits ?? []) {
    editIndex.set(`${e.burstId}::${e.path}`, e.ranges);
    if (e.added) addedIndex.add(`${e.burstId}::${e.path}`);
  }

  const found = new Map<string, Conflict>();
  const keep = (c: Conflict): void => {
    if (dismissed?.has(c.id)) return;
    const existing = found.get(c.id);
    // the newest crossing wins: it is the one whose lines are still on disk
    if (!existing || c.at >= existing.at) found.set(c.id, c);
  };

  const eligible = bursts.filter((b) => {
    const id = agentIdOf(b);
    if (unattributed(id)) return false;
    return includeHuman || b.agent !== 'you';
  });

  // --- contested file / overwritten -------------------------------------
  const lastWrite = new Map<string, Write>();
  for (const burst of eligible) {
    for (const path of burst.changed) {
      const ranges = editIndex.get(`${burst.id}::${path}`) ?? [];
      const previous = lastWrite.get(path);
      lastWrite.set(path, { burst, ranges });
      if (!previous) continue;
      if (agentIdOf(previous.burst) === agentIdOf(burst)) continue;

      const later = partyOf(burst);
      const earlier = partyOf(previous.burst);
      const shared = overlapLines(previous.ranges, ranges);
      const had = rangeLines(previous.ranges);

      if (shared > 0 && had > 0) {
        keep({
          id: conflictId('overwritten', later.id, earlier.id, path),
          kind: 'overwritten',
          severity: 'critical',
          at: burst.endedAt,
          agents: [later, earlier],
          paths: [path],
          summary: `${later.label} replaced ${shared} of the ${had} lines ${earlier.label} wrote in ${path}`,
          detail:
            `${earlier.label} wrote ${path}, then ${later.label} rewrote the same lines. ` +
            `Only the second version is on disk — the first agent's work is gone unless it was folded in.`,
          burstIds: [burst.id, previous.burst.id],
        });
      } else {
        keep({
          id: conflictId('contested-file', later.id, earlier.id, path),
          kind: 'contested-file',
          severity: 'warning',
          at: burst.endedAt,
          agents: [later, earlier],
          paths: [path],
          summary: `${later.label} and ${earlier.label} both wrote ${path}`,
          detail:
            `Two agents edited the same file this session. They may have been working on different parts ` +
            `of it — the diff is the only way to tell.`,
          burstIds: [burst.id, previous.burst.id],
        });
      }
    }
  }

  // --- blast collision ---------------------------------------------------
  // one agent changed something another agent's in-flight files import
  if (dependents) {
    for (let i = 0; i < eligible.length; i++) {
      const source = eligible[i];
      for (let j = i + 1; j < eligible.length; j++) {
        const affected = eligible[j];
        if (agentIdOf(source) === agentIdOf(affected)) continue;
        // "in flight while it landed": the second burst was already running, or
        // started close enough behind that it was built on the old version
        if (affected.startedAt - source.endedAt > CONCURRENT_MS) break;

        for (const path of source.changed) {
          if (affected.changed.includes(path)) continue; // that is a contested file, above
          const downstream = dependents.get(path);
          if (!downstream || downstream.length < COLLISION_MIN_DEPENDENTS) continue;
          const hit = affected.changed.filter((p) => downstream.includes(p));
          if (hit.length === 0) continue;

          const later = partyOf(affected);
          const earlier = partyOf(source);
          const radius = metrics?.get(path)?.blastRadius ?? downstream.length;
          keep({
            id: conflictId('blast-collision', later.id, earlier.id, path),
            kind: 'blast-collision',
            severity: radius >= 10 ? 'critical' : 'warning',
            at: Math.max(affected.endedAt, source.endedAt),
            agents: [later, earlier],
            paths: [path, ...hit],
            summary: `${earlier.label} changed ${path}, which ${later.label}'s work imports`,
            detail:
              `${hit.length} file${hit.length === 1 ? '' : 's'} ${later.label} was editing depend${
                hit.length === 1 ? 's' : ''
              } on ${path}, and ${earlier.label} changed it underneath them` +
              `${radius >= 3 ? ` — ${radius} files break if it is wrong` : ''}.`,
            burstIds: [affected.id, source.id],
          });
        }
      }
    }
  }

  // --- divergent duplicates ----------------------------------------------
  /*
   * Two agents each wrote a new file doing the same job.
   *
   * The one crossing that leaves no trace anywhere else: nothing was
   * overwritten, no shared file was touched, no dependency was disturbed — so
   * every other detector here is silent, the tests pass on both, and the
   * duplicate is only ever found by a human who happens to open both files.
   * It is also the crossing several agents on one board produce most easily,
   * because "write a token refresher" is a reasonable step in two different
   * tasks.
   *
   * Three gates, all necessary. **Created, not edited** — two agents editing
   * one file is a contested file, above. **Nothing imports either of them** —
   * once the rest of the code has picked one, the other is dead code, which
   * is a different (and already reported) problem. And **their exported names
   * overlap**, which is the only evidence available here that they do the
   * same thing: comparing bodies would be a similarity metric with a
   * threshold nobody can defend, while two files both exporting
   * `refreshToken` is a fact.
   */
  if (nodes) {
    const created: { path: string; burst: ChangeBurst; shape: FileShape }[] = [];
    for (const burst of eligible) {
      for (const path of burst.changed) {
        if (!addedIndex.has(`${burst.id}::${path}`)) continue;
        const shape = nodes.get(path);
        if (!shape || shape.fanIn > 0 || shape.exports.length === 0) continue;
        created.push({ path, burst, shape });
      }
    }

    for (let i = 0; i < created.length; i++) {
      for (let j = i + 1; j < created.length; j++) {
        const a = created[i];
        const b = created[j];
        if (a.path === b.path) continue;
        if (agentIdOf(a.burst) === agentIdOf(b.burst)) continue;

        const bExports = new Set(b.shape.exports);
        const shared = a.shape.exports.filter((name) => bExports.has(name));
        const smaller = Math.min(a.shape.exports.length, b.shape.exports.length);
        if (shared.length === 0 || shared.length / smaller < DUPLICATE_MIN_SHARE) continue;

        const later = a.burst.endedAt >= b.burst.endedAt ? a : b;
        const earlier = later === a ? b : a;
        const paths = [later.path, earlier.path];
        keep({
          id: conflictId(
            'divergent-duplicate',
            agentIdOf(later.burst),
            agentIdOf(earlier.burst),
            [...paths].sort().join('|'),
          ),
          kind: 'divergent-duplicate',
          severity: 'warning',
          at: later.burst.endedAt,
          agents: [partyOf(later.burst), partyOf(earlier.burst)],
          paths,
          summary: `${agentLabelOf(later.burst)} and ${agentLabelOf(earlier.burst)} each wrote a new ${
            shared[0]
          }`,
          detail:
            `${later.path} and ${earlier.path} were both created this session, by different agents, and both export ${
              shared.length === 1 ? shared[0] : `${shared.slice(0, 3).join(', ')}`
            }. Nothing imports either yet, so neither has won — deciding now is cheaper than deciding after the rest of the code has picked a side.`,
          burstIds: [later.burst.id, earlier.burst.id],
        });
      }
    }
  }

  // --- contradictory decisions -------------------------------------------
  if (decisions) {
    const open = decisions.filter((d) => d.status === 'proposed' && d.paths.length > 0);
    for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        const a = open[i];
        const b = open[j];
        if (a.by === b.by || a.by === 'you' || b.by === 'you') continue;
        const shared = a.paths.filter((p) => b.paths.includes(p));
        if (shared.length === 0) continue;

        const later = a.at >= b.at ? a : b;
        const earlier = later === a ? b : a;
        keep({
          id: conflictId('contradictory-decision', later.by, earlier.by, shared[0]),
          kind: 'contradictory-decision',
          severity: 'warning',
          at: later.at,
          agents: [
            { id: later.by, label: later.by },
            { id: earlier.by, label: earlier.by },
          ],
          paths: shared,
          summary: `Two agents proposed different calls on ${shared[0]}`,
          detail: `“${later.title}” and “${earlier.title}” both land on ${
            shared.length === 1 ? 'this file' : `${shared.length} of the same files`
          }, and neither has been agreed. Agreeing to one should decline the other.`,
          burstIds: [],
        });
      }
    }
  }

  const SEVERITY_ORDER: Record<ConflictSeverity, number> = { critical: 0, warning: 1 };
  return [...found.values()]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.at - a.at)
    .slice(0, limit);
}

/**
 * Everything that transitively imports each of `roots`.
 *
 * Built only for the files a burst touched, which is a handful even in a big
 * session — the whole-repo version of this is what `blastRadius` already is,
 * and that answers "how many", not "which ones".
 */
export function dependentsMap(
  edges: readonly { source: string; target: string }[],
  roots: Iterable<string>,
): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const e of edges) {
    const list = importers.get(e.target);
    if (list) list.push(e.source);
    else importers.set(e.target, [e.source]);
  }

  const out = new Map<string, string[]>();
  for (const root of roots) {
    if (out.has(root)) continue;
    const seen = new Set<string>();
    const queue = [...(importers.get(root) ?? [])];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (next === root || seen.has(next)) continue;
      seen.add(next);
      queue.push(...(importers.get(next) ?? []));
    }
    out.set(root, [...seen]);
  }
  return out;
}

/** Conflicts touching a given file — what the graph asks when it draws a node. */
export function conflictsFor(all: readonly Conflict[], path: string): Conflict[] {
  return all.filter((c) => c.paths.includes(path));
}

/**
 * The agents that both wrote a file, for the two-tone ring on the graph.
 * Empty unless more than one did.
 */
export function contestedBy(all: readonly Conflict[], path: string): ConflictParty[] {
  const out = new Map<string, ConflictParty>();
  for (const c of all) {
    if (c.kind !== 'contested-file' && c.kind !== 'overwritten') continue;
    if (c.paths[0] !== path) continue;
    for (const p of c.agents) out.set(p.id, p);
  }
  return out.size > 1 ? [...out.values()] : [];
}

/**
 * The crossings, indexed the two ways a graph view draws them.
 *
 * Here rather than in each view because all three of them — canvas, wheel and
 * districts — answer the same two questions of every node and every edge, and
 * three copies of this is three chances for the wheel to disagree with the
 * canvas about who wrote a file.
 *
 * `contested` is per file: the agent mark becomes two-toned, naming both.
 * `collisions` is per *edge*, keyed `importer\nimported`, because "one agent
 * changed what another one's work imports" is a fact about a dependency, and
 * that dependency is already a line on the canvas.
 *
 * Only direct imports land in `collisions`. The detector works transitively,
 * so the affected file can be several hops downstream with no single edge to
 * colour — the mark on the changed file carries that case. Drawing a line
 * that is not an import, to stand for a path of imports, would say something
 * false about the graph.
 */
export function conflictMarks(all: readonly Conflict[]): {
  contested: Map<string, ConflictParty[]>;
  collisions: Map<string, string>;
} {
  const contested = new Map<string, ConflictParty[]>();
  const collisions = new Map<string, string>();
  for (const conflict of all) {
    if (conflict.kind === 'blast-collision') {
      const [changed, ...affected] = conflict.paths;
      for (const importer of affected) collisions.set(`${importer}\n${changed}`, conflict.summary);
      continue;
    }
    const parties = contestedBy(all, conflict.paths[0]);
    if (parties.length > 1) contested.set(conflict.paths[0], parties);
  }
  return { contested, collisions };
}
