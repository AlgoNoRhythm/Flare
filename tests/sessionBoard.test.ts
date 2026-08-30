import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectSession } from '../electron/session';
import { addNote, createTask, type Board } from '../shared/tasks';

/**
 * The board with more than one writer, through the session that owns it.
 *
 * `mergeBoards` is tested on its own; this is the wiring — that a write coming
 * in against an older revision is actually rebased rather than believed, and
 * that the revision moves so the next writer can be caught out in turn. Both
 * are easy to leave unconnected and impossible to notice by hand: the symptom
 * is a card that was there a second ago and now is not.
 */

let root = '';
let data = '';
let session: ProjectSession;

const NOTHING = {
  onGraphPatch: () => {},
  onFilesChanged: () => {},
  onGitStatus: () => {},
  onTreeChanged: () => {},
  onShadowSnapshot: () => {},
  onCoverage: () => {},
  onActivity: () => {},
  onCommandUpdate: () => {},
  onDangerousCommand: () => {},
  onBoard: () => {},
  onAgents: () => {},
  onSummaries: () => {},
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-board-proj-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-board-data-'));
  session = new ProjectSession(root, data, NOTHING);
});

afterEach(async () => {
  await session.dispose();
  for (const dir of [root, data]) fs.rmSync(dir, { recursive: true, force: true });
});

const titles = (): string[] => session.getBoard().tasks.map((t) => t.title);

describe('a board with several writers', () => {
  it('moves the revision on every accepted write', () => {
    const first = session.getBoard().rev;
    session.setBoard(createTask(session.getBoard(), { title: 'one' }).board);
    session.setBoard(createTask(session.getBoard(), { title: 'two' }).board);
    expect(session.getBoard().rev).toBe(first + 2);
  });

  /*
   * The panel holds a board for as long as someone is looking at it. With a
   * routine running, that snapshot goes stale in seconds — and sending it back
   * used to delete everything the agents had done in between.
   */
  it('rebases a write made against an older revision', () => {
    const heldByThePanel: Board = session.getBoard();
    session.setBoard(createTask(session.getBoard(), { title: 'filed by the agent' }).board);
    session.setBoard(createTask(session.getBoard(), { title: 'also by the agent' }).board);

    session.setBoard(createTask(heldByThePanel, { title: 'filed by the human' }).board);

    expect(titles().sort()).toEqual(['also by the agent', 'filed by the agent', 'filed by the human']);
  });

  it('still honours a deletion made against an older revision', () => {
    session.setBoard(createTask(session.getBoard(), { title: 'doomed' }).board);
    const held = session.getBoard();
    session.setBoard(createTask(session.getBoard(), { title: 'filed by the agent' }).board);

    session.setBoard({ ...held, tasks: held.tasks.filter((t) => t.title !== 'doomed') });

    expect(titles()).toEqual(['filed by the agent']);
  });

  it('keeps an agent note written while the panel was being used', () => {
    session.setBoard(createTask(session.getBoard(), { title: 'card' }).board);
    const held = session.getBoard();
    session.setBoard(addNote(session.getBoard(), 'card', 'agent', 'done; not verified', 1000));

    // the human moves the card on, from the board as it was before the note
    session.setBoard(addNote(held, 'card', 'you', 'thanks', 2000));

    expect(session.getBoard().tasks[0].notes.map((n) => n.text)).toEqual(['done; not verified', 'thanks']);
  });

  it('takes a current write at face value', () => {
    session.setBoard(createTask(session.getBoard(), { title: 'one' }).board);
    // read, change, write, all without anyone else in between — the ordinary
    // case, and the one every MCP tool takes
    session.setBoard(createTask(session.getBoard(), { title: 'two' }).board);
    expect(titles()).toEqual(['one', 'two']);
  });
});
