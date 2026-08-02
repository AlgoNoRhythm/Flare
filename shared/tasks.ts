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

export interface Board {
  lanes: Lane[];
  tasks: Task[];
}

export const DEFAULT_LANES: Lane[] = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'In progress' },
  { id: 'review', title: 'To review' },
  { id: 'done', title: 'Done' },
];

export function emptyBoard(): Board {
  return { lanes: structuredClone(DEFAULT_LANES), tasks: [] };
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
