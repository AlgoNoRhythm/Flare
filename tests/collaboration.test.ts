import { describe, expect, it } from 'vitest';
import {
  addNote,
  answerQuestion,
  askQuestion,
  blockedTaskIds,
  createTask,
  decideDecision,
  decisionAdvice,
  emptyBoard,
  formatRoutineForAgent,
  mergeBoards,
  nextStep,
  normalizeBoard,
  openQuestions,
  proposedDecisions,
  recordDecision,
  setRoutine,
  stopVerdict,
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
  const routine = {
    recheckBoard: true,
    decisions: 'flag' as const,
    parkQuestions: true,
    heartbeat: false,
    notes: '',
    text: '',
  };

  it('says so plainly when no routine has been set', () => {
    expect(formatRoutineForAgent(emptyBoard())).toContain('No routine has been set');
  });

  it('renders only the rules that are switched on', () => {
    const all = formatRoutineForAgent(setRoutine(emptyBoard(), routine));
    expect(all).toContain('Look at the board again');
    expect(all).toContain('Write architectural decisions down');
    expect(all).toContain('Park questions instead of halting');

    const quiet = formatRoutineForAgent(
      setRoutine(emptyBoard(), { ...routine, decisions: 'off', parkQuestions: false }),
    );
    expect(quiet).toContain('Look at the board again');
    expect(quiet).not.toContain('architectural decisions');
    expect(quiet).not.toContain('Park questions');
  });

  /*
   * The half of the decision rule that actually changes what happens: both
   * policies record the same card, and they differ only in whether the work
   * resting on it carries on. A routine that said "record it" and left that
   * open is a routine the agent has to guess at.
   */
  it('says what to do with the work while a decision waits', () => {
    const flag = formatRoutineForAgent(setRoutine(emptyBoard(), routine));
    expect(flag).toContain('carry on and build on it');
    expect(flag).toContain('which decisions the work assumes');

    const park = formatRoutineForAgent(setRoutine(emptyBoard(), { ...routine, decisions: 'park' }));
    expect(park).toContain('leave the work that rests on it');
    expect(park).not.toContain('carry on and build on it');
  });

  it('scopes decisions to architecture rather than to every choice', () => {
    const text = formatRoutineForAgent(setRoutine(emptyBoard(), routine));
    expect(text).toContain('module boundary');
    expect(text).toContain('refactor across several files');
    expect(text).toContain('Not a local name');
  });

  it('tells an agent recording one what the project expects next', () => {
    expect(decisionAdvice(setRoutine(emptyBoard(), routine))).toContain('carry on');
    expect(decisionAdvice(setRoutine(emptyBoard(), { ...routine, decisions: 'park' }))).toContain(
      'leave the work',
    );
    // no routine is not permission to build on a guess
    expect(decisionAdvice(emptyBoard())).toContain('leave the work');
  });

  /*
   * The heartbeat is the one rule that does not depend on the agent having
   * read the others, so the agreement has to say it is there — an agent that
   * is told "keep going" by something it did not expect behaves worse than one
   * that was warned.
   */
  it('warns that the board answers back when it tries to stop', () => {
    expect(formatRoutineForAgent(setRoutine(emptyBoard(), routine))).not.toContain('when you try to stop');
    const beating = formatRoutineForAgent(setRoutine(emptyBoard(), { ...routine, heartbeat: true }));
    expect(beating).toContain('when you try to stop');
  });

  /*
   * The switches cover what every project wants and nothing of what yours
   * wants said in its own words, so the generated text is a starting point
   * rather than the ceiling. What is not editable is the board state below it:
   * that is counted at the moment of asking, and a hand-written copy of it
   * would be a snapshot of an hour ago.
   */
  describe('rewritten by hand', () => {
    const mine = '# How we work here\n\nSmall commits. Ask before touching the parser.';

    it('is what the agent reads, instead of the generated rules', () => {
      const text = formatRoutineForAgent(setRoutine(emptyBoard(), { ...routine, text: mine }));
      expect(text).toContain('Ask before touching the parser');
      expect(text).not.toContain('Look at the board again');
    });

    it('still gets the state of the board attached', () => {
      const board = setRoutine(boardWithTasks('Rewrite the resolver'), { ...routine, text: mine });
      const text = formatRoutineForAgent(board);
      expect(text).toContain('## Right now');
      expect(text).toContain('1 card waiting to be picked up');
      expect(text).toContain('Rewrite the resolver');
    });

    it('falls back to the generated rules when emptied', () => {
      const text = formatRoutineForAgent(setRoutine(emptyBoard(), { ...routine, text: '   ' }));
      expect(text).toContain('Look at the board again');
    });

    /*
     * The switches are not decoration once the text is custom: two of them —
     * the decision policy and the heartbeat — are read by the code, not by the
     * agent, so they keep working whatever the prose says.
     */
    it('does not stop the switches meaning what they mean', () => {
      const board = setRoutine(emptyBoard(), { ...routine, decisions: 'park', text: mine });
      expect(decisionAdvice(board)).toContain('leave the work');
    });
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
    expect(text).toContain('1 card waiting to be picked up');
    expect(text).toContain('1 blocked by an unanswered question');
    expect(text).toContain('1 question waiting on the human');
    expect(text).toContain('1 design decision waiting to be agreed');
    expect(text).toContain('Tidy the palette');
  });
});

/*
 * The heartbeat's whole job is to answer one question — "may I stop?" — at the
 * moment the agent has already decided it may. So the answer has to be usable
 * without any further calls: it names the card, and it says what is waiting
 * when there is no card.
 */
describe('the stop verdict', () => {
  it('hands back the next card rather than just refusing', () => {
    const verdict = stopVerdict(boardWithTasks('Rewrite the resolver', 'Tidy the palette'));
    expect(verdict.keepGoing).toBe(true);
    expect(verdict.reason).toContain('Rewrite the resolver');
    expect(verdict.reason).toContain('2 cards nobody has started');
  });

  it('lets it stop when everything left is blocked, and says by what', () => {
    let board = boardWithTasks('Rewrite the resolver');
    board = askQuestion(board, { text: 'Symlinks?', blocks: ['rewrite-the-resolver'] }).board;
    const verdict = stopVerdict(board);
    expect(verdict.keepGoing).toBe(false);
    expect(verdict.reason).toContain('blocked by an unanswered question');
    expect(verdict.reason).toContain('1 question waiting on the human');
  });

  it('lets it stop on an empty board', () => {
    expect(stopVerdict(emptyBoard())).toEqual({ keepGoing: false, reason: 'Nothing left on the board.' });
  });

  it('counts a card in review as finished, not as work', () => {
    let board = boardWithTasks('Shipped it');
    board = updateTask(board, 'shipped-it', { laneId: 'review' });
    expect(stopVerdict(board).keepGoing).toBe(false);
  });

  /*
   * The hook cannot tell which agent it is answering, so a card someone has
   * already started is not an answer — hand it out and two agents work the
   * same brief on the same files, repeatedly, because each of them gets sent
   * back the moment it tries to stop.
   */
  it('never hands out a card that is already in progress', () => {
    let board = boardWithTasks('Rewrite the resolver', 'Tidy the palette');
    board = updateTask(board, 'rewrite-the-resolver', { laneId: 'doing' });

    const verdict = stopVerdict(board);
    expect(verdict.keepGoing).toBe(true);
    expect(verdict.reason).toContain('Tidy the palette');
    expect(verdict.reason).not.toContain('Rewrite the resolver');
    expect(verdict.reason).toContain('1 in progress');
  });

  it('lets a session end when every remaining card is being worked on', () => {
    let board = boardWithTasks('Rewrite the resolver', 'Tidy the palette');
    board = updateTask(board, 'rewrite-the-resolver', { laneId: 'doing' });
    board = updateTask(board, 'tidy-the-palette', { laneId: 'doing' });
    const verdict = stopVerdict(board);
    expect(verdict.keepGoing).toBe(false);
    expect(verdict.reason).toContain('2 cards already in progress');
  });
});

/*
 * Several writers, one board.
 *
 * The panel edits by sending the whole board back, and with a routine running
 * it is no longer the only writer — agents file cards, log notes and move
 * lanes continuously. Every case here is one where the naive "last write wins"
 * loses something somebody did.
 */
describe('merging concurrent board writes', () => {
  it('keeps what the writer never saw', () => {
    const base = boardWithTasks('shared');
    const current = createTask(base, { title: 'filed by the agent' }).board;
    const incoming = createTask(base, { title: 'filed by the human' }).board;
    const merged = mergeBoards(base, current, incoming);
    expect(merged.tasks.map((t) => t.title).sort()).toEqual([
      'filed by the agent',
      'filed by the human',
      'shared',
    ]);
  });

  it('still deletes what the writer deliberately removed', () => {
    const base = boardWithTasks('doomed');
    const current = createTask(base, { title: 'filed by the agent' }).board;
    const incoming = { ...base, tasks: [] };
    const merged = mergeBoards(base, current, incoming);
    expect(merged.tasks.map((t) => t.title)).toEqual(['filed by the agent']);
  });

  it('takes the writer’s version of a card they actually edited', () => {
    const base = boardWithTasks('card');
    const current = updateTask(base, 'card', { brief: 'from the agent' });
    const incoming = updateTask(base, 'card', { title: 'renamed by the human' });
    const merged = mergeBoards(base, current, incoming);
    expect(merged.tasks[0].title).toBe('renamed by the human');
  });

  it('leaves a card alone if the writer only carried a copy of it', () => {
    const base = boardWithTasks('card');
    const current = updateTask(base, 'card', { laneId: 'doing' });
    // the human edited something else entirely and sent the whole board back
    const incoming = createTask(base, { title: 'unrelated' }).board;
    const merged = mergeBoards(base, current, incoming);
    expect(merged.tasks.find((t) => t.id === 'card')?.laneId).toBe('doing');
  });

  /*
   * The realistic collision on one card: an agent logs progress while a human,
   * looking at the card as it was a moment earlier, renames it or moves it.
   * The human's edit should win — but not by throwing away the note that says
   * what was done.
   */
  it('keeps notes from both sides of a conflict', () => {
    const base = boardWithTasks('card');
    // explicit times: the notes come back in the order they were written,
    // whichever side wrote them
    const current = addNote(base, 'card', 'agent', 'sized the cards; not verified', 1000);
    const incoming = addNote(updateTask(base, 'card', { laneId: 'review' }), 'card', 'you', 'looks right', 2000);
    const merged = mergeBoards(base, current, incoming);
    expect(merged.tasks[0].laneId).toBe('review');
    expect(merged.tasks[0].notes.map((n) => n.text)).toEqual([
      'sized the cards; not verified',
      'looks right',
    ]);
  });

  it('loses nothing when the writer is too far behind to rebase', () => {
    const base = boardWithTasks('shared');
    const current = createTask(base, { title: 'filed by the agent' }).board;
    const incoming = createTask(base, { title: 'filed by the human' }).board;
    // no base: a union, because resurrecting a deleted card is a nuisance and
    // dropping an agent's work is not
    expect(mergeBoards(null, current, incoming).tasks).toHaveLength(3);
  });

  it('merges the other collections the same way', () => {
    const base = emptyBoard();
    const current = recordDecision(base, { title: 'from the agent' }).board;
    const incoming = askQuestion(base, { text: 'from the human?' }).board;
    const merged = mergeBoards(base, current, incoming);
    expect(merged.decisions).toHaveLength(1);
    expect(merged.questions).toHaveLength(1);
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

  /*
   * The decision rule used to be a switch, and a switch could not say what to
   * do about a decision while it waited — it just meant "record it, and build
   * nothing expensive on it". That is `park`, so that is what an old board
   * becomes; reading it as `flag` would quietly grant a permission nobody gave.
   */
  it('migrates the old decisions switch to the policy it stood for', () => {
    const migrated = normalizeBoard({
      lanes: [{ id: 'todo', title: 'To do' }],
      routine: { recheckBoard: true, flagDecisions: true, parkQuestions: true, notes: '', setAt: 1 },
    });
    expect(migrated.routine?.decisions).toBe('park');

    const off = normalizeBoard({
      lanes: [{ id: 'todo', title: 'To do' }],
      routine: { recheckBoard: true, flagDecisions: false, parkQuestions: true, notes: '', setAt: 1 },
    });
    expect(off.routine?.decisions).toBe('off');
  });

  it('falls back to a fresh board for anything unusable', () => {
    expect(normalizeBoard(null).lanes.length).toBeGreaterThan(0);
    expect(normalizeBoard({ lanes: [] }).lanes.length).toBeGreaterThan(0);
  });
});
