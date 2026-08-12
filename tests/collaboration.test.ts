import { describe, expect, it } from 'vitest';
import {
  answerQuestion,
  askQuestion,
  blockedTaskIds,
  createTask,
  decideDecision,
  emptyBoard,
  formatRoutineForAgent,
  nextStep,
  normalizeBoard,
  openQuestions,
  proposedDecisions,
  recordDecision,
  setRoutine,
  updateTask,
  type Board,
} from '../shared/tasks';

/**
 * The collaboration half of the board: what the agent decided without asking,
 * what it needs answered, and what it should do when it runs out of work.
 *
 * The rule this is all built to serve: a question parks the work it names and
 * nothing else, so an agent stops only when there is genuinely nothing left it
 * can do.
 */

function boardWithTasks(...titles: string[]): Board {
  let board = emptyBoard();
  for (const title of titles) board = createTask(board, { title }).board;
  return board;
}

describe('design decisions', () => {
  it('arrives proposed, and an agent cannot agree with itself', () => {
    const { board, decision } = recordDecision(emptyBoard(), {
      title: 'Parse imports with a lexer',
      detail: 'A regex cannot see comments.',
      alternatives: 'Regex with lookarounds — rejected, unreadable.',
      by: 'claude',
    });
    expect(decision.status).toBe('proposed');
    expect(decision.decidedAt).toBeNull();
    expect(proposedDecisions(board)).toHaveLength(1);
  });

  it('records what the human said when they agree or decline', () => {
    let board = recordDecision(emptyBoard(), { title: 'Use a shared store' }).board;
    board = decideDecision(board, 'use-a-shared-store', 'declined', 'Two stores is fine for now.');
    expect(board.decisions[0]).toMatchObject({
      status: 'declined',
      verdict: 'Two stores is fine for now.',
    });
    expect(board.decisions[0].decidedAt).not.toBeNull();
    expect(proposedDecisions(board)).toEqual([]);
  });

  it('treats one you wrote yourself as already agreed', () => {
    const { decision } = recordDecision(emptyBoard(), {
      title: 'Keep the parser dependency-free',
      by: 'you',
      status: 'agreed',
    });
    expect(decision.status).toBe('agreed');
    expect(decision.decidedAt).not.toBeNull();
  });
});

describe('questions', () => {
  it('blocks only the tasks it names', () => {
    let board = boardWithTasks('Rewrite the resolver', 'Tidy the lens palette');
    board = askQuestion(board, {
      text: 'Should the resolver follow symlinks?',
      blocks: ['rewrite-the-resolver'],
    }).board;
    expect([...blockedTaskIds(board)]).toEqual(['rewrite-the-resolver']);
    expect(nextStep(board).workable.map((t) => t.id)).toEqual(['tidy-the-lens-palette']);
  });

  it('unblocks its tasks once answered', () => {
    let board = boardWithTasks('Rewrite the resolver');
    board = askQuestion(board, { text: 'Symlinks?', blocks: ['rewrite-the-resolver'] }).board;
    expect(nextStep(board).workable).toEqual([]);
    board = answerQuestion(board, 'symlinks', 'No — treat them as ordinary files.');
    expect(openQuestions(board)).toEqual([]);
    expect(nextStep(board).workable.map((t) => t.id)).toEqual(['rewrite-the-resolver']);
  });

  it('ignores an empty answer rather than closing the question', () => {
    let board = askQuestion(emptyBoard(), { text: 'Symlinks?' }).board;
    board = answerQuestion(board, 'symlinks', '   ');
    expect(openQuestions(board)).toHaveLength(1);
  });
});

describe('nextStep', () => {
  it('names the next workable task', () => {
    const board = boardWithTasks('First thing', 'Second thing');
    expect(nextStep(board).action).toContain('First thing');
  });

  it('does not count work that is already in review or done', () => {
    let board = boardWithTasks('Shipped it');
    board = updateTask(board, 'shipped-it', { laneId: 'review' });
    const step = nextStep(board);
    expect(step.workable).toEqual([]);
    expect(step.action).toContain('No work left');
  });

  it('says to stop only when everything left is blocked', () => {
    let board = boardWithTasks('Rewrite the resolver');
    board = askQuestion(board, { text: 'Symlinks?', blocks: ['rewrite-the-resolver'] }).board;
    const step = nextStep(board);
    expect(step.blocked).toHaveLength(1);
    expect(step.action).toContain('waiting on an answer');
  });

  it('distinguishes "nothing to do" from "nothing outstanding"', () => {
    const idle = nextStep(emptyBoard());
    expect(idle.action).toContain('nothing outstanding');
    const asked = askQuestion(emptyBoard(), { text: 'Which database?' }).board;
    expect(nextStep(asked).action).toContain('say what you are waiting on');
  });
});

describe('the working agreement', () => {
  const routine = { recheckBoard: true, flagDecisions: true, parkQuestions: true, notes: '' };

  it('says so plainly when no routine has been set', () => {
    expect(formatRoutineForAgent(emptyBoard())).toContain('No routine has been set');
  });

  it('renders only the rules that are switched on', () => {
    const all = formatRoutineForAgent(setRoutine(emptyBoard(), routine));
    expect(all).toContain('Look at the board again');
    expect(all).toContain('Write down design decisions');
    expect(all).toContain('Park questions instead of halting');

    const quiet = formatRoutineForAgent(
      setRoutine(emptyBoard(), { ...routine, flagDecisions: false, parkQuestions: false }),
    );
    expect(quiet).toContain('Look at the board again');
    expect(quiet).not.toContain('Write down design decisions');
    expect(quiet).not.toContain('Park questions');
  });

  it('carries house rules verbatim', () => {
    const text = formatRoutineForAgent(
      setRoutine(emptyBoard(), { ...routine, notes: 'never touch shared/types.ts' }),
    );
    expect(text).toContain('## House rules');
    expect(text).toContain('never touch shared/types.ts');
  });

  it('ends with the state of the board, not a general instruction', () => {
    let board = boardWithTasks('Rewrite the resolver', 'Tidy the palette');
    board = askQuestion(board, { text: 'Symlinks?', blocks: ['rewrite-the-resolver'] }).board;
    board = recordDecision(board, { title: 'Lexer over regex' }).board;
    const text = formatRoutineForAgent(setRoutine(board, routine));
    expect(text).toContain('1 task you can work on');
    expect(text).toContain('1 blocked by an unanswered question');
    expect(text).toContain('1 question waiting on the human');
    expect(text).toContain('1 design decision waiting to be agreed');
    expect(text).toContain('Tidy the palette');
  });
});

describe('normalizeBoard', () => {
  it('fills in what a board written before these fields is missing', () => {
    const old = { lanes: [{ id: 'todo', title: 'To do' }], tasks: [{ id: 'a' }] };
    const board = normalizeBoard(old);
    expect(board.decisions).toEqual([]);
    expect(board.questions).toEqual([]);
    expect(board.routine).toBeNull();
    expect(board.tasks).toHaveLength(1);
  });

  it('falls back to a fresh board for anything unusable', () => {
    expect(normalizeBoard(null).lanes.length).toBeGreaterThan(0);
    expect(normalizeBoard({ lanes: [] }).lanes.length).toBeGreaterThan(0);
  });
});
