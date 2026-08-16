import { formatPathsTree } from './pathFormat';

/**
 * The board: work you intend to hand to an agent, and where each piece got to.
 *
 * Two things make this different from a generic kanban. A task's brief is
 * written to be *pasted into an agent's context*, so it carries the files it
 * concerns along with what the graph knows about them — an agent that is told
 * "these four files, and nine others import them, and two have no test" starts
 * from the map instead of rediscovering it. And the lanes are queryable over
 * MCP, so an agent can ask for its next task and report back without a human
 * relaying it.
 */

export interface Lane {
  id: string;
  title: string;
}

export interface TaskNote {
  at: number;
  /** 'you' or an agent name */
  by: string;
  text: string;
}

export interface Task {
  id: string;
  title: string;
  /** the body handed to the agent; plain text/markdown */
  brief: string;
  laneId: string;
  /** project-relative paths this task concerns */
  paths: string[];
  createdAt: number;
  updatedAt: number;
  /** ordering within a lane, ascending */
  position: number;
  /** progress log — appended by you or by an agent over MCP */
  notes: TaskNote[];
}

export type DecisionStatus = 'proposed' | 'agreed' | 'declined';

/**
 * A design decision, and whether anyone has agreed to it.
 *
 * An agent makes dozens of these an hour — a shape, a name, a place to put
 * something — and they arrive invisibly, inside a diff, long after the point
 * where disagreeing would have been cheap. Recording them separately makes the
 * choice reviewable *before* the code that assumes it exists.
 */
export interface Decision {
  id: string;
  title: string;
  /** the reasoning, and what it commits the codebase to */
  detail: string;
  /** alternatives considered and dropped, if any were */
  alternatives: string;
  status: DecisionStatus;
  /** 'you' or an agent name */
  by: string;
  at: number;
  paths: string[];
  /** what the human said when agreeing or declining */
  verdict: string;
  decidedAt: number | null;
}

/**
 * Something the agent needs answered — parked, not blocking.
 *
 * A question asked in a chat window stops everything until someone reads it.
 * Asked here it names the work it blocks, so the agent can leave that aside
 * and pick up something else, and the human answers when they get to it.
 */
export interface Question {
  id: string;
  text: string;
  /** why it matters, what the agent will do with either answer */
  detail: string;
  by: string;
  at: number;
  answer: string;
  answeredAt: number | null;
  /** task ids this holds up — everything else stays workable */
  blocks: string[];
}

/**
 * The working agreement: what the assistant does when it runs out of work.
 *
 * Set by the wizard in the Control panel and read back over MCP, so the rules
 * live with the project rather than in whichever chat window happened to be
 * open when they were agreed.
 */
/**
 * What the agent does about an architectural call you have not agreed to.
 *
 * The choice is not whether to record it — it is whether the work stops. Both
 * of these put the decision in front of you; they differ in what happens in the
 * meantime, and that is a real trade rather than a preference. `flag` keeps the
 * session moving and accepts that agreeing late may mean unwinding something.
 * `park` refuses to build on a guess and accepts that the queue may empty early.
 */
export type DecisionPolicy = 'off' | 'flag' | 'park';

/** See `Routine.heartbeat` — one setting, so "both on" is unrepresentable. */
export type HeartbeatMode = 'off' | 'stop-hook' | 'timer';

export interface Routine {
  /** look at the board again instead of stopping when the queue empties */
  recheckBoard: boolean;
  /** what to do about a design decision it has not agreed with you */
  decisions: DecisionPolicy;
  /** park questions and carry on with work they do not block */
  parkQuestions: boolean;
  /**
   * What keeps an agent working after it would have stopped.
   *
   * The rules above are things an agent has to remember to do; this is the one
   * that does not depend on it remembering. One setting with three values
   * rather than two independent switches, because the two mechanisms must
   * never both run — an agent answered by its hook *and* typed at by a timer
   * is told to pick up work twice — and an enum cannot express that state at
   * all, where two booleans can.
   *
   * - `stop-hook` — Flare answers the assistant's stop hook with the board.
   *   The better mechanism: it fires at the moment that matters, polls
   *   nothing, and never types into a shell you might be using.
   * - `timer` — for agents with no such hook: a terminal that was running one
   *   and has gone quiet gets `heartbeatCommand` typed into it.
   */
  heartbeat: HeartbeatMode;
  /** timer mode: how long a terminal must be quiet first */
  heartbeatEvery: number;
  /** timer mode: the line typed into it, without the newline */
  heartbeatCommand: string;
  /** house rules typed into the wizard, verbatim */
  notes: string;
  /**
   * The agreement, rewritten by hand.
   *
   * Empty means "generate it from the switches", which is the right default and
   * the wrong ceiling: the switches cover what every project wants and nothing
   * of what yours wants said in your words. When this has something in it, it
   * is what the agent reads — the switches still mean what they mean, they just
   * stop writing the prose.
   */
  text: string;
  setAt: number;
}

export interface Board {
  lanes: Lane[];
  tasks: Task[];
  decisions: Decision[];
  questions: Question[];
  routine: Routine | null;
  /**
   * Bumped on every accepted write, so a writer can be told it is behind.
   *
   * The UI edits a board by sending the whole thing back, which is fine when it
   * is the only writer and silently destructive when it is not: an agent files
   * a card over MCP, and the next click in the panel — made against the board
   * as it was a moment ago — writes the card back out of existence. The number
   * is what lets `mergeBoards` tell "the human deleted this" from "the human
   * never saw this".
   */
  rev: number;
}

export const DEFAULT_LANES: Lane[] = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'In progress' },
  { id: 'review', title: 'To review' },
  { id: 'done', title: 'Done' },
];

export function emptyBoard(): Board {
  return {
    lanes: structuredClone(DEFAULT_LANES),
    tasks: [],
    decisions: [],
    questions: [],
    routine: null,
    rev: 0,
  };
}

/**
 * A board read back from disk, with everything a newer field expects.
 *
 * State files written before decisions, questions or the routine existed are
 * still perfectly good boards — they just stop one `.map()` short of working,
 * so filling the gaps is the loader's job rather than every reader's.
 */
export function normalizeBoard(raw: unknown): Board {
  const board = (raw ?? {}) as Partial<Board>;
  if (!Array.isArray(board.lanes) || board.lanes.length === 0) return emptyBoard();
  return {
    lanes: board.lanes,
    tasks: Array.isArray(board.tasks) ? board.tasks : [],
    decisions: Array.isArray(board.decisions) ? board.decisions : [],
    questions: Array.isArray(board.questions) ? board.questions : [],
    routine: normalizeRoutine(board.routine),
    rev: typeof board.rev === 'number' ? board.rev : 0,
  };
}

/**
 * A routine written by an older build.
 *
 * The decision rule used to be a switch, and a switch cannot say *what* to do
 * about a decision nobody has agreed to yet — only whether to write it down. A
 * board saved with it on is migrated to `park`, because that is what the switch
 * actually did: record it and build nothing expensive on it.
 */
function normalizeRoutine(raw: unknown): Routine | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Omit<Partial<Routine>, 'heartbeat'> & { flagDecisions?: boolean; heartbeat?: unknown };
  const decisions: DecisionPolicy =
    r.decisions === 'off' || r.decisions === 'flag' || r.decisions === 'park'
      ? r.decisions
      : r.flagDecisions === false
        ? 'off'
        : 'park';
  return {
    recheckBoard: r.recheckBoard !== false,
    decisions,
    parkQuestions: r.parkQuestions !== false,
    // opt-in, unlike the rest: the hook writes a file into the project and the
    // timer types into a shell, so neither is ever on because a board was
    // loaded from an older build. `true` was the stop hook before this was an
    // enum, which is the only value an older board can carry.
    heartbeat:
      r.heartbeat === true || r.heartbeat === 'stop-hook'
        ? 'stop-hook'
        : r.heartbeat === 'timer'
          ? 'timer'
          : 'off',
    heartbeatEvery: typeof r.heartbeatEvery === 'number' && r.heartbeatEvery > 0 ? r.heartbeatEvery : 600_000,
    heartbeatCommand: typeof r.heartbeatCommand === 'string' ? r.heartbeatCommand : '',
    notes: typeof r.notes === 'string' ? r.notes : '',
    text: typeof r.text === 'string' ? r.text : '',
    setAt: typeof r.setAt === 'number' ? r.setAt : 0,
  };
}

// ---------------------------------------------------------------- merging

/**
 * Reconcile a write made against an older board with the board as it is now.
 *
 * The UI edits by sending the whole board back, and it is no longer the only
 * writer: with a routine running, agents file cards, record decisions, ask
 * questions and move things between lanes continuously. So a panel that was
 * opened ten seconds ago and clicked once carries a board that never had any
 * of that in it — and taking it at face value deletes the lot.
 *
 * Three-way, because two-way cannot tell the difference that matters: an id in
 * `current` but not in `incoming` is *deleted* if the writer had it in `base`,
 * and *unseen* if it did not. Everything else follows from that:
 *
 * - present in base, gone from incoming → the writer deleted it, so delete it
 * - added in incoming → keep it
 * - added in current, unknown to incoming → keep it (this is the lost update)
 * - changed in incoming → the writer's version wins; it is the one someone
 *   just made a decision about
 * - untouched in incoming → whatever current has, which may be newer
 *
 * With no base — a writer so far behind that its revision is no longer
 * remembered — it degrades to a union: nothing is deleted, and nothing is
 * lost. Resurrecting a card someone deleted is a nuisance; silently dropping
 * an agent's work is not.
 */
function mergeById<T extends { id: string }>(base: readonly T[] | null, current: readonly T[], incoming: readonly T[]): T[] {
  const baseById = new Map((base ?? []).map((item) => [item.id, item]));
  const currentById = new Map(current.map((item) => [item.id, item]));
  const out: T[] = [];
  const taken = new Set<string>();

  for (const item of incoming) {
    const wasKnown = baseById.get(item.id);
    const now = currentById.get(item.id);
    // deleted by somebody else while this writer was holding it
    if (now === undefined && wasKnown !== undefined) continue;
    const edited = wasKnown === undefined || JSON.stringify(wasKnown) !== JSON.stringify(item);
    out.push(edited ? withNotesOf(item, now) : (now ?? item));
    taken.add(item.id);
  }
  for (const item of current) {
    if (taken.has(item.id)) continue;
    // the writer had it and dropped it: that is a deletion, not an omission
    if (baseById.has(item.id)) continue;
    out.push(item);
  }
  return out;
}

/**
 * The one field where the writer's version is not the whole truth.
 *
 * Notes are only ever appended, and the realistic collision on a card is
 * exactly this: an agent logs what it did while a human, looking at the card
 * as it was a moment earlier, renames it or moves it to another lane. Taking
 * the human's copy wholesale is right for the title and the lane and wrong for
 * the note explaining the work — so the notes are unioned back in, in time
 * order, whichever side wrote them.
 */
function withNotesOf<T extends { id: string }>(chosen: T, other: T | undefined): T {
  const mine = (chosen as { notes?: TaskNote[] }).notes;
  const theirs = (other as { notes?: TaskNote[] } | undefined)?.notes;
  if (!Array.isArray(mine) || !Array.isArray(theirs)) return chosen;
  const seen = new Set(mine.map((n) => `${n.at}\n${n.by}\n${n.text}`));
  const extra = theirs.filter((n) => !seen.has(`${n.at}\n${n.by}\n${n.text}`));
  if (extra.length === 0) return chosen;
  return { ...chosen, notes: [...mine, ...extra].sort((a, b) => a.at - b.at) };
}

/** Did this writer touch a field at all, or is it just carrying an old copy? */
function pick<T>(base: T | undefined, current: T, incoming: T): T {
  if (base === undefined) return incoming;
  return JSON.stringify(base) === JSON.stringify(incoming) ? current : incoming;
}

export function mergeBoards(base: Board | null, current: Board, incoming: Board): Board {
  return {
    lanes: mergeById(base?.lanes ?? null, current.lanes, incoming.lanes),
    tasks: mergeById(base?.tasks ?? null, current.tasks, incoming.tasks),
    decisions: mergeById(base?.decisions ?? null, current.decisions, incoming.decisions),
    questions: mergeById(base?.questions ?? null, current.questions, incoming.questions),
    routine: pick(base?.routine, current.routine, incoming.routine),
    rev: current.rev,
  };
}

/** Stable, readable id from a title, unique within `taken`. */
export function slugify(text: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'lane';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function nextPosition(board: Board, laneId: string): number {
  const inLane = board.tasks.filter((t) => t.laneId === laneId);
  return inLane.length === 0 ? 0 : Math.max(...inLane.map((t) => t.position)) + 1;
}

export interface NewTask {
  title: string;
  brief?: string;
  paths?: string[];
  laneId?: string;
}

export function createTask(board: Board, input: NewTask, now = Date.now()): { board: Board; task: Task } {
  const laneId = board.lanes.some((l) => l.id === input.laneId)
    ? input.laneId!
    : (board.lanes[0]?.id ?? 'todo');
  const taken = new Set(board.tasks.map((t) => t.id));
  const task: Task = {
    id: slugify(input.title || 'task', taken),
    title: input.title.trim() || 'Untitled task',
    brief: (input.brief ?? '').trim(),
    laneId,
    paths: [...new Set(input.paths ?? [])],
    createdAt: now,
    updatedAt: now,
    position: nextPosition(board, laneId),
    notes: [],
  };
  return { board: { ...board, tasks: [...board.tasks, task] }, task };
}

export function updateTask(
  board: Board,
  id: string,
  patch: Partial<Pick<Task, 'title' | 'brief' | 'paths' | 'laneId'>>,
  now = Date.now(),
): Board {
  return {
    ...board,
    tasks: board.tasks.map((t) => {
      if (t.id !== id) return t;
      const laneChanged = patch.laneId !== undefined && patch.laneId !== t.laneId;
      const laneId = laneChanged && board.lanes.some((l) => l.id === patch.laneId) ? patch.laneId! : t.laneId;
      return {
        ...t,
        ...patch,
        laneId,
        paths: patch.paths ? [...new Set(patch.paths)] : t.paths,
        // moving to a lane puts it at that lane's end unless reordered after
        position: laneId !== t.laneId ? nextPosition(board, laneId) : t.position,
        updatedAt: now,
      };
    }),
  };
}

export function addNote(board: Board, id: string, by: string, text: string, now = Date.now()): Board {
  const trimmed = text.trim();
  if (trimmed === '') return board;
  return {
    ...board,
    tasks: board.tasks.map((t) =>
      t.id === id ? { ...t, notes: [...t.notes, { at: now, by, text: trimmed }], updatedAt: now } : t,
    ),
  };
}

export function deleteTask(board: Board, id: string): Board {
  return { ...board, tasks: board.tasks.filter((t) => t.id !== id) };
}

/** Move a task into a lane at a given index, renumbering that lane. */
export function moveTask(board: Board, id: string, laneId: string, index: number, now = Date.now()): Board {
  const task = board.tasks.find((t) => t.id === id);
  if (!task || !board.lanes.some((l) => l.id === laneId)) return board;
  const others = board.tasks
    .filter((t) => t.laneId === laneId && t.id !== id)
    .sort((a, b) => a.position - b.position);
  const at = Math.max(0, Math.min(others.length, index));
  const ordered = [...others.slice(0, at), task, ...others.slice(at)];
  const positions = new Map(ordered.map((t, i) => [t.id, i]));
  return {
    ...board,
    tasks: board.tasks.map((t) => {
      if (t.id === id) return { ...t, laneId, position: positions.get(id)!, updatedAt: now };
      return positions.has(t.id) ? { ...t, position: positions.get(t.id)! } : t;
    }),
  };
}

export function tasksInLane(board: Board, laneId: string): Task[] {
  return board.tasks
    .filter((t) => t.laneId === laneId)
    .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------- lanes

export function addLane(board: Board, title: string): Board {
  const id = slugify(title, new Set(board.lanes.map((l) => l.id)));
  return { ...board, lanes: [...board.lanes, { id, title: title.trim() || id }] };
}

export function renameLane(board: Board, id: string, title: string): Board {
  return {
    ...board,
    lanes: board.lanes.map((l) => (l.id === id ? { ...l, title: title.trim() || l.title } : l)),
  };
}

/**
 * Remove a lane, moving anything in it to `fallbackLaneId` (or the first
 * remaining lane). The last lane cannot be removed — a board with nowhere to
 * put a task is not a board.
 */
export function removeLane(board: Board, id: string, fallbackLaneId?: string): Board {
  if (board.lanes.length <= 1) return board;
  const lanes = board.lanes.filter((l) => l.id !== id);
  const fallback = lanes.find((l) => l.id === fallbackLaneId)?.id ?? lanes[0].id;
  let next: Board = { ...board, lanes };
  for (const task of board.tasks.filter((t) => t.laneId === id)) {
    next = moveTask(next, task.id, fallback, Number.MAX_SAFE_INTEGER);
  }
  return next;
}

export function moveLane(board: Board, id: string, toIndex: number): Board {
  const from = board.lanes.findIndex((l) => l.id === id);
  if (from === -1) return board;
  const lanes = [...board.lanes];
  const [lane] = lanes.splice(from, 1);
  lanes.splice(Math.max(0, Math.min(lanes.length, toIndex)), 0, lane);
  return { ...board, lanes };
}

// ------------------------------------------------------- design decisions

export interface NewDecision {
  title: string;
  detail?: string;
  alternatives?: string;
  paths?: string[];
  by?: string;
  /** a human writing one down has already agreed with themselves */
  status?: DecisionStatus;
}

export function recordDecision(
  board: Board,
  input: NewDecision,
  now = Date.now(),
): { board: Board; decision: Decision } {
  const taken = new Set(board.decisions.map((d) => d.id));
  const decision: Decision = {
    id: slugify(input.title || 'decision', taken),
    title: input.title.trim() || 'Untitled decision',
    detail: (input.detail ?? '').trim(),
    alternatives: (input.alternatives ?? '').trim(),
    status: input.status ?? 'proposed',
    by: input.by ?? 'agent',
    at: now,
    paths: [...new Set(input.paths ?? [])],
    verdict: '',
    decidedAt: input.status && input.status !== 'proposed' ? now : null,
  };
  return { board: { ...board, decisions: [...board.decisions, decision] }, decision };
}

/** Agree or decline — the one thing an agent must not do to its own proposal. */
export function decideDecision(
  board: Board,
  id: string,
  status: Exclude<DecisionStatus, 'proposed'>,
  verdict = '',
  now = Date.now(),
): Board {
  return {
    ...board,
    decisions: board.decisions.map((d) =>
      d.id === id ? { ...d, status, verdict: verdict.trim(), decidedAt: now } : d,
    ),
  };
}

export function deleteDecision(board: Board, id: string): Board {
  return { ...board, decisions: board.decisions.filter((d) => d.id !== id) };
}

/** Waiting on a human — the thing an agent must not build on yet. */
export function proposedDecisions(board: Board): Decision[] {
  return board.decisions.filter((d) => d.status === 'proposed');
}

// -------------------------------------------------------------- questions

export interface NewQuestion {
  text: string;
  detail?: string;
  blocks?: string[];
  by?: string;
}

export function askQuestion(
  board: Board,
  input: NewQuestion,
  now = Date.now(),
): { board: Board; question: Question } {
  const taken = new Set(board.questions.map((q) => q.id));
  const question: Question = {
    id: slugify(input.text || 'question', taken),
    text: input.text.trim() || 'Untitled question',
    detail: (input.detail ?? '').trim(),
    by: input.by ?? 'agent',
    at: now,
    answer: '',
    answeredAt: null,
    blocks: [...new Set(input.blocks ?? [])],
  };
  return { board: { ...board, questions: [...board.questions, question] }, question };
}

export function answerQuestion(board: Board, id: string, answer: string, now = Date.now()): Board {
  const trimmed = answer.trim();
  if (trimmed === '') return board;
  return {
    ...board,
    questions: board.questions.map((q) =>
      q.id === id ? { ...q, answer: trimmed, answeredAt: now } : q,
    ),
  };
}

export function deleteQuestion(board: Board, id: string): Board {
  return { ...board, questions: board.questions.filter((q) => q.id !== id) };
}

export function openQuestions(board: Board): Question[] {
  return board.questions.filter((q) => q.answeredAt === null);
}

/** Task ids an unanswered question is holding up. */
export function blockedTaskIds(board: Board): Set<string> {
  return new Set(openQuestions(board).flatMap((q) => q.blocks));
}

// ---------------------------------------------------------------- routine

export function setRoutine(board: Board, routine: Omit<Routine, 'setAt'>, now = Date.now()): Board {
  return { ...board, routine: { ...routine, setAt: now } };
}

export function clearRoutine(board: Board): Board {
  return { ...board, routine: null };
}

/**
 * What the assistant should do next, given the board as it stands.
 *
 * The point of computing it here rather than describing it in prose is that
 * the answer is the same whether it is read by the person looking at the panel
 * or by the agent calling `working_agreement` — and "keep going" has to be a
 * decision made from the actual state, not from a vibe.
 */
export interface NextStep {
  /** one line: what to do now */
  action: string;
  /** live and unblocked — `queued` and `claimed` together */
  workable: Task[];
  /**
   * Workable and nobody has started it: still in the first lane.
   *
   * This is the only set it is safe to hand out. A card someone moved into an
   * in-progress lane may have another agent on it, and two agents editing the
   * same files from the same brief is worse than one agent stopping early.
   */
  queued: Task[];
  /** workable, but already moved out of the queue by somebody */
  claimed: Task[];
  blocked: Task[];
  openQuestions: Question[];
  proposedDecisions: Decision[];
}

/**
 * Cards somebody has started: workable, out of the queue, not yet in review.
 *
 * Moving a card out of the first lane is how an agent claims it, so this is
 * the set of work currently owned by *someone* — which is also how a write to
 * one of their files gets attributed to them. See shared/attribution.ts.
 */
export function claimedTasks(board: Board): Task[] {
  const doneLane = board.lanes[board.lanes.length - 1]?.id;
  const reviewLane = board.lanes.length >= 2 ? board.lanes[board.lanes.length - 2]?.id : undefined;
  const queueLane = board.lanes[0]?.id;
  const blockedIds = blockedTaskIds(board);
  return board.tasks.filter(
    (t) =>
      t.laneId !== doneLane &&
      t.laneId !== reviewLane &&
      t.laneId !== queueLane &&
      !blockedIds.has(t.id),
  );
}

export function nextStep(board: Board): NextStep {
  const blockedIds = blockedTaskIds(board);
  const doneLane = board.lanes[board.lanes.length - 1]?.id;
  const reviewLane = board.lanes.length >= 2 ? board.lanes[board.lanes.length - 2]?.id : undefined;
  const queueLane = board.lanes[0]?.id;
  const live = board.tasks.filter((t) => t.laneId !== doneLane && t.laneId !== reviewLane);
  const workable = live.filter((t) => !blockedIds.has(t.id));
  const queued = workable.filter((t) => t.laneId === queueLane);
  const claimed = claimedTasks(board);
  const blocked = live.filter((t) => blockedIds.has(t.id));
  const questions = openQuestions(board);
  const proposed = proposedDecisions(board);

  /*
   * The order here is the answer to "what should I do", asked by something
   * that might be one of several agents on this board. Claimed cards are named
   * rather than handed over: if it is yours you know it, and if it is not, the
   * one thing you must not do is start it again.
   */
  const action =
    queued.length > 0
      ? `Take "${queued[0].title}" (${queued[0].id}) — task_get ${queued[0].id}.`
      : claimed.length > 0
        ? `Nothing unclaimed. ${claimed.length} card${claimed.length === 1 ? ' is' : 's are'} already in progress (${claimed.map((t) => t.id).join(', ')}) — finish yours if one of them is, and otherwise leave them alone: another agent may be on them.`
        : blocked.length > 0
          ? `Everything left is waiting on an answer: ${questions.map((q) => q.id).join(', ')}. Stop here and say so.`
          : questions.length > 0 || proposed.length > 0
            ? 'No work left on the board. Nothing to start, but there are open questions or undecided proposals — say what you are waiting on.'
            : 'No work left on the board, and nothing outstanding. Say so rather than inventing work.';

  return { action, workable, queued, claimed, blocked, openQuestions: questions, proposedDecisions: proposed };
}

/**
 * What counts as a design decision, in the agent's own terms.
 *
 * Said once, here, because it is the half of the rule that decides whether the
 * panel is useful: an agent told to record "anything a reasonable person could
 * disagree with" records the name of a local variable, and a panel with forty
 * cards on it is a panel nobody reads.
 */
const DECISION_SCOPE =
  'The ones that shape the codebase: a module boundary, a dependency taken on, the shape of data that will spread, a refactor across several files, a pattern the rest of the code will copy. Not a local name, not a helper only its caller sees, not anything one edit would undo — those are just work. Record it with `decision_record`, with the alternatives you rejected, and it lands in the Control panel as *proposed*.';

const DECISION_RULE: Record<Exclude<DecisionPolicy, 'off'>, string> = {
  flag: 'Then carry on and build on it — a proposed decision is not a blocked one. Say in the task note which decisions the work assumes, so that declining one later says what has to be unwound.',
  park: 'Then leave the work that rests on it and pick up something that does not. Nothing expensive gets built on a decision the human has not agreed to. If everything left depends on one, say so and stop.',
};

/**
 * The answer to "may I stop now?".
 *
 * An agent that has finished a card stops, and everything the routine says
 * about looking at the board again depends on it remembering to. This is the
 * same question asked from the other end — by the assistant's own stop hook,
 * at the moment it is about to end the session — so the answer does not depend
 * on anyone's memory.
 *
 * It says *why* in both directions on purpose: "keep going" without naming the
 * card is an instruction to guess, and a bare "fine" tells the human nothing
 * about what the board looked like when the session ended.
 */
export interface StopVerdict {
  /** true when there is workable board left */
  keepGoing: boolean;
  reason: string;
}

export function stopVerdict(board: Board): StopVerdict {
  const step = nextStep(board);
  /*
   * Only an *unclaimed* card keeps a session alive.
   *
   * The hook has no idea which agent it is answering, so anything else sends
   * whoever stops first back into work somebody else may already be doing —
   * and with several agents on one board, into it repeatedly. Being handed a
   * card nobody has started is unambiguous; everything else is a guess, and
   * the safe end of that guess is letting the session finish.
   */
  if (step.queued.length === 0) {
    const waiting = [
      step.claimed.length > 0 ? `${step.claimed.length} card${step.claimed.length === 1 ? '' : 's'} already in progress` : '',
      step.blocked.length > 0 ? `${step.blocked.length} card${step.blocked.length === 1 ? '' : 's'} blocked by an unanswered question` : '',
      step.openQuestions.length > 0 ? `${step.openQuestions.length} question${step.openQuestions.length === 1 ? '' : 's'} waiting on the human` : '',
      step.proposedDecisions.length > 0 ? `${step.proposedDecisions.length} design decision${step.proposedDecisions.length === 1 ? '' : 's'} waiting to be agreed` : '',
    ].filter(Boolean);
    return {
      keepGoing: false,
      reason: waiting.length > 0 ? `Nothing unclaimed left to start — ${waiting.join(', ')}.` : 'Nothing left on the board.',
    };
  }
  const also = [
    step.claimed.length > 0 ? `${step.claimed.length} in progress` : '',
    step.blocked.length > 0 ? `${step.blocked.length} blocked by a question` : '',
  ].filter(Boolean);
  return {
    keepGoing: true,
    reason: `The board is not empty: ${step.queued.length} card${step.queued.length === 1 ? '' : 's'} nobody has started${also.length > 0 ? ` (${also.join(', ')})` : ''}. ${step.action} Do that instead of stopping, and if you genuinely cannot, say why in a note on the card.`,
  };
}

/**
 * What to tell an agent that has just recorded a decision.
 *
 * The same sentence the routine gave it, repeated at the moment it matters:
 * whether the work that rests on this one carries on or waits. Defaults to the
 * cautious half when no routine has been set — an unagreed decision on a
 * project that never said otherwise is not a licence to build on it.
 */
export function decisionAdvice(board: Board): string {
  return board.routine?.decisions === 'flag' ? DECISION_RULE.flag : DECISION_RULE.park;
}

/**
 * The rules half of the agreement: what this project asks of an agent.
 *
 * Generated from the switches so that turning one off actually removes its
 * rule instead of leaving a sentence behind that no longer describes what
 * anyone wants — unless somebody has rewritten it by hand, in which case what
 * they wrote is the agreement and this is only what the editor started from.
 */
export function routineRules(routine: Routine): string {
  const out: string[] = ['# Working agreement'];
  out.push('', 'When you finish what is in front of you, do this instead of stopping:', '');
  let n = 0;
  if (routine.recheckBoard) {
    out.push(
      `${++n}. **Look at the board again.** Call \`tasks_list\`, take the next card that is not blocked *and that nobody has started*, and \`task_update\` it into the in-progress lane **before** you begin — that move is how anyone else working this board knows the card is taken. Never start one that is already in progress: you may not be the only agent here. Only stop when there is nothing left waiting to be picked up.`,
    );
  }
  if (routine.decisions !== 'off') {
    out.push(`${++n}. **Write architectural decisions down as you make them.** ${DECISION_SCOPE} ${DECISION_RULE[routine.decisions]}`);
  }
  if (routine.parkQuestions) {
    out.push(
      `${++n}. **Park questions instead of halting on them.** Call \`question_ask\` with the task ids it blocks, then pick up work it does not block. Halt and say so only when every remaining task is blocked.`,
    );
  }
  out.push(`${++n}. Call \`working_agreement\` whenever you are unsure what to pick up — it answers with the board as it stands.`);
  if (routine.heartbeat === 'stop-hook') {
    out.push(
      '',
      'This project also checks the board when you try to stop: if a card is sitting unstarted you will be handed it instead of being allowed to finish. Calling `tasks_list` yourself first is quicker than being sent back. Cards already in progress are never handed out this way, so if yours is one of them, move it on rather than leaving it parked there.',
    );
  }

  if (routine.notes.trim() !== '') {
    out.push('', '## House rules', '', routine.notes.trim());
  }
  return out.join('\n');
}

/**
 * The whole thing, as the agent receives it: the rules, then the board.
 *
 * The second half is never editable and never stored — it is counted from the
 * board at the moment of asking, and an agreement carrying a snapshot of what
 * was outstanding an hour ago would be worse than one carrying none.
 */
export function formatRoutineForAgent(board: Board): string {
  const routine = board.routine;
  if (!routine) {
    return [
      '# Working agreement',
      '',
      'No routine has been set for this project. Ask the human to set one up in the Control panel, or just work the board: tasks_list → task_get → task_update.',
    ].join('\n');
  }

  const out: string[] = [routine.text.trim() === '' ? routineRules(routine) : routine.text.trim()];
  const step = nextStep(board);
  out.push(
    '',
    '## Right now',
    '',
    `- ${step.queued.length} card${step.queued.length === 1 ? '' : 's'} waiting to be picked up`,
    `- ${step.claimed.length} already in progress (possibly by another agent)`,
    `- ${step.blocked.length} blocked by an unanswered question`,
    `- ${step.openQuestions.length} question${step.openQuestions.length === 1 ? '' : 's'} waiting on the human`,
    `- ${step.proposedDecisions.length} design decision${step.proposedDecisions.length === 1 ? '' : 's'} waiting to be agreed`,
    '',
    step.action,
  );
  return out.join('\n');
}

// ---------------------------------------------------------------- output

export interface PathContext {
  /** how many files import this one, transitively */
  blastRadius?: number;
  /** direct importers */
  fanIn?: number;
  coveragePct?: number | null;
  testedBy?: number;
  inCycle?: boolean;
}

/**
 * Render a task as something you can paste straight into an agent.
 *
 * The point of doing this here rather than in the UI is that the same text
 * goes out over MCP, so an agent that pulls its own task sees exactly what a
 * human would have pasted.
 */
export function formatTaskForAgent(
  task: Task,
  context: Record<string, PathContext> = {},
  lane?: Lane,
): string {
  const out: string[] = [`# ${task.title}`];
  if (lane) out.push(`_lane: ${lane.title}_`);
  if (task.brief) out.push('', task.brief);

  if (task.paths.length > 0) {
    out.push('', '## Files', '', formatPathsTree(task.paths));
    const notes = task.paths
      .map((p) => {
        const c = context[p];
        if (!c) return null;
        const bits: string[] = [];
        if (c.blastRadius) bits.push(`${c.blastRadius} file${c.blastRadius === 1 ? '' : 's'} downstream`);
        else if (c.fanIn) bits.push(`${c.fanIn} importer${c.fanIn === 1 ? '' : 's'}`);
        if (c.coveragePct !== undefined && c.coveragePct !== null) bits.push(`${Math.round(c.coveragePct)}% covered`);
        else if (c.testedBy === 0) bits.push('no test covers it');
        if (c.inCycle) bits.push('in an import cycle');
        return bits.length > 0 ? `- ${p}: ${bits.join(', ')}` : null;
      })
      .filter((line): line is string => line !== null);
    if (notes.length > 0) out.push('', '## What depends on them', '', ...notes);
  }

  if (task.notes.length > 0) {
    out.push('', '## Progress so far', '');
    for (const note of task.notes) {
      out.push(`- [${new Date(note.at).toISOString().slice(0, 16).replace('T', ' ')}] ${note.by}: ${note.text}`);
    }
  }
  return out.join('\n');
}

/** "3 to do · 1 in progress · 2 done" */
export function boardSummary(board: Board): string {
  return board.lanes
    .map((lane) => ({ lane, count: board.tasks.filter((t) => t.laneId === lane.id).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.lane.title.toLowerCase()}`)
    .join(' · ');
}

/** Accepts a lane id or a title, case-insensitively — agents pass either. */
export function resolveLane(board: Board, nameOrId: string): Lane | null {
  const needle = nameOrId.trim().toLowerCase();
  return (
    board.lanes.find((l) => l.id.toLowerCase() === needle) ??
    board.lanes.find((l) => l.title.toLowerCase() === needle) ??
    board.lanes.find((l) => l.title.toLowerCase().replace(/\s+/g, '-') === needle) ??
    null
  );
}
