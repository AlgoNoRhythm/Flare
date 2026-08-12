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
export interface Routine {
  /** look at the board again instead of stopping when the queue empties */
  recheckBoard: boolean;
  /** record design decisions and wait for agreement before building on them */
  flagDecisions: boolean;
  /** park questions and carry on with work they do not block */
  parkQuestions: boolean;
  /** house rules typed into the wizard, verbatim */
  notes: string;
  setAt: number;
}

export interface Board {
  lanes: Lane[];
  tasks: Task[];
  decisions: Decision[];
  questions: Question[];
  routine: Routine | null;
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
    routine: board.routine ?? null,
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
  workable: Task[];
  blocked: Task[];
  openQuestions: Question[];
  proposedDecisions: Decision[];
}

export function nextStep(board: Board): NextStep {
  const blockedIds = blockedTaskIds(board);
  const doneLane = board.lanes[board.lanes.length - 1]?.id;
  const reviewLane = board.lanes.length >= 2 ? board.lanes[board.lanes.length - 2]?.id : undefined;
  const live = board.tasks.filter((t) => t.laneId !== doneLane && t.laneId !== reviewLane);
  const workable = live.filter((t) => !blockedIds.has(t.id));
  const blocked = live.filter((t) => blockedIds.has(t.id));
  const questions = openQuestions(board);
  const proposed = proposedDecisions(board);

  const action =
    workable.length > 0
      ? `Take "${workable[0].title}" (${workable[0].id}) — task_get ${workable[0].id}.`
      : blocked.length > 0
        ? `Everything left is waiting on an answer: ${questions.map((q) => q.id).join(', ')}. Stop here and say so.`
        : questions.length > 0 || proposed.length > 0
          ? 'No work left on the board. Nothing to start, but there are open questions or undecided proposals — say what you are waiting on.'
          : 'No work left on the board, and nothing outstanding. Say so rather than inventing work.';

  return { action, workable, blocked, openQuestions: questions, proposedDecisions: proposed };
}

/**
 * The working agreement, written for the agent that has to follow it.
 *
 * Rendered from the routine rather than stored as prose so that turning a rule
 * off in the wizard actually removes it, instead of leaving a sentence behind
 * that no longer describes what anyone wants.
 */
export function formatRoutineForAgent(board: Board): string {
  const routine = board.routine;
  const out: string[] = ['# Working agreement'];
  if (!routine) {
    out.push(
      '',
      'No routine has been set for this project. Ask the human to set one up in the Control panel, or just work the board: tasks_list → task_get → task_update.',
    );
    return out.join('\n');
  }

  out.push('', 'When you finish what is in front of you, do this instead of stopping:', '');
  let n = 0;
  if (routine.recheckBoard) {
    out.push(
      `${++n}. **Look at the board again.** Call \`tasks_list\`, take the next card that is not blocked, and \`task_update\` it into the in-progress lane. Only stop when there is nothing workable left.`,
    );
  }
  if (routine.flagDecisions) {
    out.push(
      `${++n}. **Write down design decisions, and do not build on them yet.** Anything a reasonable person could disagree with — a shape, a boundary, a dependency, a name that will spread — goes to \`decision_record\` with the alternatives you rejected. It stays *proposed* until a human agrees in the Control panel. Work that only makes sense if a proposed decision is right waits; work that does not, continues.`,
    );
  }
  if (routine.parkQuestions) {
    out.push(
      `${++n}. **Park questions instead of halting on them.** Call \`question_ask\` with the task ids it blocks, then pick up work it does not block. Halt and say so only when every remaining task is blocked.`,
    );
  }
  out.push(`${++n}. Call \`working_agreement\` whenever you are unsure what to pick up — it answers with the board as it stands.`);

  if (routine.notes.trim() !== '') {
    out.push('', '## House rules', '', routine.notes.trim());
  }

  const step = nextStep(board);
  out.push(
    '',
    '## Right now',
    '',
    `- ${step.workable.length} task${step.workable.length === 1 ? '' : 's'} you can work on`,
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
