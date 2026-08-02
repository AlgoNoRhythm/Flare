import { describe, expect, it } from 'vitest';
import {
  addLane,
  addNote,
  boardSummary,
  createTask,
  deleteTask,
  emptyBoard,
  formatTaskForAgent,
  moveLane,
  moveTask,
  removeLane,
  renameLane,
  resolveLane,
  slugify,
  tasksInLane,
  updateTask,
  type Board,
} from '../shared/tasks';

function withTasks(titles: string[]): Board {
  let board = emptyBoard();
  for (const title of titles) board = createTask(board, { title }).board;
  return board;
}

describe('createTask', () => {
  it('lands in the first lane by default and keeps ids unique', () => {
    let board = emptyBoard();
    board = createTask(board, { title: 'Fix resolver' }).board;
    board = createTask(board, { title: 'Fix resolver' }).board;
    expect(board.tasks.map((t) => t.id)).toEqual(['fix-resolver', 'fix-resolver-2']);
    expect(board.tasks[0].laneId).toBe('todo');
  });

  it('honours a requested lane and ignores one that does not exist', () => {
    const board = emptyBoard();
    expect(createTask(board, { title: 'a', laneId: 'review' }).task.laneId).toBe('review');
    expect(createTask(board, { title: 'b', laneId: 'nope' }).task.laneId).toBe('todo');
  });

  it('deduplicates paths and never leaves a blank title', () => {
    const { task } = createTask(emptyBoard(), { title: '  ', paths: ['a.ts', 'a.ts', 'b.ts'] });
    expect(task.title).toBe('Untitled task');
    expect(task.paths).toEqual(['a.ts', 'b.ts']);
  });
});

describe('moving tasks', () => {
  it('orders within a lane and renumbers on insert', () => {
    let board = withTasks(['one', 'two', 'three']);
    board = moveTask(board, 'three', 'todo', 0);
    expect(tasksInLane(board, 'todo').map((t) => t.id)).toEqual(['three', 'one', 'two']);
  });

  it('moves between lanes and appends at the end', () => {
    let board = withTasks(['one', 'two']);
    board = moveTask(board, 'one', 'doing', 0);
    expect(tasksInLane(board, 'doing').map((t) => t.id)).toEqual(['one']);
    expect(tasksInLane(board, 'todo').map((t) => t.id)).toEqual(['two']);
  });

  it('clamps an out-of-range index instead of losing the task', () => {
    let board = withTasks(['one', 'two']);
    board = moveTask(board, 'one', 'done', 99);
    expect(tasksInLane(board, 'done').map((t) => t.id)).toEqual(['one']);
  });

  it('ignores unknown tasks and unknown lanes', () => {
    const board = withTasks(['one']);
    expect(moveTask(board, 'nope', 'todo', 0)).toBe(board);
    expect(moveTask(board, 'one', 'nope', 0)).toBe(board);
  });

  it('updateTask moving lanes puts the task at the end of the new one', () => {
    let board = withTasks(['one', 'two', 'three']);
    board = moveTask(board, 'two', 'doing', 0);
    board = updateTask(board, 'one', { laneId: 'doing' });
    expect(tasksInLane(board, 'doing').map((t) => t.id)).toEqual(['two', 'one']);
  });
});

describe('lanes are customizable', () => {
  it('adds, renames and reorders', () => {
    let board = emptyBoard();
    board = addLane(board, 'Blocked on me');
    expect(board.lanes.map((l) => l.id)).toEqual(['todo', 'doing', 'review', 'done', 'blocked-on-me']);
    board = renameLane(board, 'blocked-on-me', 'Blocked');
    expect(board.lanes.at(-1)?.title).toBe('Blocked');
    board = moveLane(board, 'blocked-on-me', 0);
    expect(board.lanes[0].id).toBe('blocked-on-me');
  });

  it('rehomes tasks when a lane is removed rather than dropping them', () => {
    let board = withTasks(['one', 'two']);
    board = moveTask(board, 'one', 'review', 0);
    board = removeLane(board, 'review');
    expect(board.lanes.map((l) => l.id)).toEqual(['todo', 'doing', 'done']);
    expect(board.tasks.find((t) => t.id === 'one')?.laneId).toBe('todo');
  });

  it('sends rehomed tasks to a chosen lane', () => {
    let board = withTasks(['one']);
    board = moveTask(board, 'one', 'review', 0);
    board = removeLane(board, 'review', 'done');
    expect(board.tasks[0].laneId).toBe('done');
  });

  it('refuses to remove the last lane', () => {
    let board = emptyBoard();
    for (const id of ['doing', 'review', 'done']) board = removeLane(board, id);
    expect(board.lanes).toHaveLength(1);
    expect(removeLane(board, 'todo').lanes).toHaveLength(1);
  });
});

describe('resolveLane', () => {
  it('accepts an id, a title, or a hyphenated title', () => {
    const board = emptyBoard();
    expect(resolveLane(board, 'doing')?.id).toBe('doing');
    expect(resolveLane(board, 'In progress')?.id).toBe('doing');
    expect(resolveLane(board, 'in-progress')?.id).toBe('doing');
    expect(resolveLane(board, 'nowhere')).toBeNull();
  });
});

describe('formatTaskForAgent', () => {
  const board = createTask(emptyBoard(), {
    title: 'Make the resolver handle scoped packages',
    brief: 'Imports like @scope/pkg resolve to null today.',
    paths: ['shared/resolver.ts', 'shared/paths.ts'],
  }).board;
  const task = board.tasks[0];

  it('produces a paste-ready brief with the files grouped', () => {
    const text = formatTaskForAgent(task, {}, board.lanes[0]);
    expect(text).toContain('# Make the resolver handle scoped packages');
    expect(text).toContain('_lane: To do_');
    expect(text).toContain('Imports like @scope/pkg resolve to null today.');
    expect(text).toContain('shared/');
    expect(text).toContain('  resolver.ts');
  });

  it('carries what the graph knows about those files', () => {
    // the whole point: the agent starts with the map instead of rediscovering it
    const text = formatTaskForAgent(task, {
      'shared/resolver.ts': { blastRadius: 9, coveragePct: 0, inCycle: true },
      'shared/paths.ts': { fanIn: 2, testedBy: 0 },
    });
    expect(text).toContain('shared/resolver.ts: 9 files downstream, 0% covered, in an import cycle');
    expect(text).toContain('shared/paths.ts: 2 importers, no test covers it');
  });

  it('omits sections that have nothing in them', () => {
    const bare = createTask(emptyBoard(), { title: 'Just a title' }).board.tasks[0];
    const text = formatTaskForAgent(bare);
    expect(text).toBe('# Just a title');
  });

  it('includes the progress log so a resumed task has its history', () => {
    const withNote = addNote(board, task.id, 'claude', 'Found it: resolveRelative drops the @ prefix.', 1700000000000);
    const text = formatTaskForAgent(withNote.tasks[0]);
    expect(text).toContain('## Progress so far');
    expect(text).toContain('claude: Found it: resolveRelative drops the @ prefix.');
  });
});

describe('housekeeping', () => {
  it('addNote ignores empty text', () => {
    const board = withTasks(['one']);
    expect(addNote(board, 'one', 'you', '   ')).toBe(board);
  });

  it('deleteTask removes only the one', () => {
    const board = deleteTask(withTasks(['one', 'two']), 'one');
    expect(board.tasks.map((t) => t.id)).toEqual(['two']);
  });

  it('boardSummary reads like a sentence and skips empty lanes', () => {
    let board = withTasks(['one', 'two']);
    board = moveTask(board, 'two', 'done', 0);
    expect(boardSummary(board)).toBe('1 to do · 1 done');
    expect(boardSummary(emptyBoard())).toBe('');
  });

  it('slugify keeps ids readable and unique', () => {
    expect(slugify('Fix the *resolver*!')).toBe('fix-the-resolver');
    expect(slugify('', new Set())).toBe('lane');
    expect(slugify('a', new Set(['a']))).toBe('a-2');
  });
});
