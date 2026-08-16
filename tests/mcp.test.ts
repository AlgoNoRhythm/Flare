import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProjectSession } from '../electron/session';
import { McpServer, identify } from '../electron/services/mcp';
import { McpRegistry } from '../electron/services/mcpRegistry';
import { SlugBook } from '../electron/services/slugs';
import {
  createTask,
  emptyBoard,
  setRoutine,
  updateTask,
  type Board,
  type Routine,
} from '../shared/tasks';

/**
 * The MCP server's HTTP surface, driven the way the things that use it do.
 *
 * It had no test of its own: everything here was covered only by the end-to-end
 * suite, through a real Electron window, which is a slow and indirect way to
 * find out that a route stopped matching. The two surfaces that matter are the
 * JSON-RPC endpoint an assistant registers, and the plain endpoint its stop
 * hook curls — the second of which is not MCP at all, and cannot be reached
 * through a tool call.
 */

const ROUTINE: Omit<Routine, 'setAt'> = {
  recheckBoard: true,
  decisions: 'flag',
  parkQuestions: true,
  heartbeat: 'stop-hook' as const,
  heartbeatEvery: 600_000,
  heartbeatCommand: '',
  notes: '',
  text: '',
};

/**
 * Just enough session for the board tools.
 *
 * A real ProjectSession owns a watcher, a shadow repo and a graph builder;
 * none of that is what these routes do. What they do is read and write a
 * board, so that is what this is.
 */
function fakeSession(board: Board): {
  session: ProjectSession;
  board: () => Board;
  claimed: Map<string, string>;
} {
  let current = board;
  const claimed = new Map<string, string>();
  const session = {
    root: '/tmp/project',
    getBoard: () => current,
    setBoard: (next: Board) => {
      current = next;
    },
    formatTask: (id: string) => current.tasks.find((t) => t.id === id)?.title ?? null,
    /** claiming a card is how an MCP session tells Flare what to call it */
    noteClaim: (callerId: string | null, title: string) => {
      if (callerId) claimed.set(callerId, title);
    },
  };
  return { session: session as unknown as ProjectSession, board: () => current, claimed };
}

let dir = '';
let server: McpServer | null = null;
let port = 0;

/** Start a server whose session holds `board`, and answer on its private port. */
async function serve(board: Board): Promise<{ board: () => Board }> {
  const state = fakeSession(board);
  // publicPort 0: an ephemeral gateway port, so a Flare running on this
  // machine keeps 7345 and this test never talks to it by accident
  server = new McpServer(() => state.session, 0, new McpRegistry(dir), '127.0.0.1', new SlugBook(path.join(dir, 'slugs.json')));
  await server.start();
  server.updateProject('/tmp/project', 'project');
  port = server.localPort;
  return state;
}

const rpc = async (body: unknown): Promise<any> => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status === 202 ? { status: 202 } : ((await res.json()) as unknown);
};

const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return out?.result?.content?.[0]?.text ?? '';
};

const stopHook = async (
  urlPath = '/hook/stop',
  body: unknown = {},
  method = 'POST',
): Promise<Record<string, unknown>> => {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return (await res.json()) as Record<string, unknown>;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-mcp-test-'));
});

afterEach(() => {
  server?.stop();
  server = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the JSON-RPC endpoint', () => {
  it('introduces itself and lists its tools', async () => {
    await serve(emptyBoard());
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(init.result.serverInfo.name).toBe('flare');
    expect(init.result.protocolVersion).toBeTruthy();

    const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = tools.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('tasks_list');
    expect(names).toContain('working_agreement');
    // every tool has to carry a description and a schema, or an assistant
    // cannot choose between them
    for (const tool of tools.result.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('runs a board tool against the session and writes the result back', async () => {
    const state = await serve(emptyBoard());
    expect(await call('task_create', { title: 'Rewrite the resolver' })).toContain('filed');
    expect(state.board().tasks.map((t) => t.title)).toEqual(['Rewrite the resolver']);
    expect(await call('tasks_list')).toContain('Rewrite the resolver');
  });

  /*
   * Several agents on one board, all writing at once.
   *
   * Each tool reads the board, computes a new one and writes it back, which is
   * only safe because the whole of that happens in one tick — the moment a
   * handler awaits between the read and the write, the last writer of each
   * overlapping pair silently wins. Cheap to assert, and the assertion is what
   * makes it safe to add an async board tool later.
   */
  it('loses nothing when several agents write at the same time', async () => {
    const state = await serve(emptyBoard());
    await Promise.all([
      ...Array.from({ length: 25 }, (_, i) => call('task_create', { title: `card ${i}` })),
      ...Array.from({ length: 10 }, (_, i) => call('decision_record', { title: `decision ${i}` })),
      ...Array.from({ length: 10 }, (_, i) => call('question_ask', { text: `question ${i}?` })),
    ]);
    const board = state.board();
    expect(board.tasks).toHaveLength(25);
    expect(board.decisions).toHaveLength(10);
    expect(board.questions).toHaveLength(10);
    // and every one of them got its own id rather than overwriting a twin
    expect(new Set(board.tasks.map((t) => t.id)).size).toBe(25);
  });

  it('moves a card only once when two agents race to claim it', async () => {
    const state = await serve(createTask(emptyBoard(), { title: 'Rewrite the resolver' }).board);
    const [a, b] = await Promise.all([
      call('task_update', { id: 'rewrite-the-resolver', lane: 'in progress', note: 'agent one' }),
      call('task_update', { id: 'rewrite-the-resolver', lane: 'in progress', note: 'agent two' }),
    ]);
    expect(a).toContain('moved');
    expect(b).toContain('moved');
    // both notes survive: whoever wrote second read the first one's board
    expect(state.board().tasks[0].notes.map((n) => n.text)).toEqual(['agent one', 'agent two']);
  });

  it('answers an unknown tool with a message rather than a protocol error', async () => {
    await serve(emptyBoard());
    const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } });
    expect(out.error ?? out.result?.isError).toBeTruthy();
  });

  it('takes a notification without answering it', async () => {
    await serve(emptyBoard());
    // no id: JSON-RPC says say nothing back, and a reply here makes strict
    // clients drop the connection
    const out = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(out.status === 202 || out.result === undefined).toBe(true);
  });
});

/*
 * The heartbeat endpoint is not an MCP tool and cannot be tested through one:
 * it is a plain POST that Claude Code's stop hook curls, and the only thing
 * that ever calls it is a shell command in someone's settings file.
 */
describe('the stop-hook endpoint', () => {
  const withWork = (routine?: Omit<Routine, 'setAt'>): Board => {
    let board = createTask(emptyBoard(), { title: 'Rewrite the resolver' }).board;
    if (routine) board = setRoutine(board, routine);
    return board;
  };

  it('hands back the next card when the board still has work', async () => {
    await serve(withWork(ROUTINE));
    const out = await stopHook();
    expect(out.decision).toBe('block');
    expect(String(out.reason)).toContain('Rewrite the resolver');
  });

  it('lets the session end when nothing is workable', async () => {
    const board = updateTask(withWork(ROUTINE), 'rewrite-the-resolver', { laneId: 'review' });
    await serve(board);
    expect(await stopHook()).not.toHaveProperty('decision');
  });

  it('says nothing when the project has no heartbeat set', async () => {
    await serve(withWork());
    expect(await stopHook()).not.toHaveProperty('decision');
    await serve(withWork({ ...ROUTINE, heartbeat: 'off' as const }));
    expect(await stopHook()).not.toHaveProperty('decision');
  });

  /*
   * The mode is a string, and every value of it is truthy.
   *
   * This blocked real sessions the moment the flag stopped being a boolean:
   * `!routine.heartbeat` reads as "no heartbeat is set" and is false for
   * 'off'. The timer mode is the same trap wearing a different value, so it
   * is asserted rather than left to the next person to rediscover.
   */
  it('answers only to the stop-hook mode, not to any mode at all', async () => {
    await serve(withWork({ ...ROUTINE, heartbeat: 'timer' as const }));
    expect(await stopHook()).not.toHaveProperty('decision');
    await serve(withWork({ ...ROUTINE, heartbeat: 'stop-hook' as const }));
    expect(await stopHook()).toHaveProperty('decision', 'block');
  });

  /*
   * The flag the assistant sets when this stop was already caused by a hook.
   * Blocking on it is how a heartbeat becomes a session that cannot be ended,
   * which is far worse than a missed nudge.
   */
  it('never blocks the same stop twice', async () => {
    await serve(withWork(ROUTINE));
    expect((await stopHook('/hook/stop', {})).decision).toBe('block');
    expect(await stopHook('/hook/stop', { stop_hook_active: true })).not.toHaveProperty('decision');
  });

  it('answers on the project slug, and on a trailing slash', async () => {
    await serve(withWork(ROUTINE));
    const slug = server!.slug!;
    expect((await stopHook(`/hook/${slug}/stop`)).decision).toBe('block');
    expect((await stopHook(`/hook/${slug}/stop/`)).decision).toBe('block');
  });

  it('lets the stop through when the slug belongs to another project', async () => {
    await serve(withWork(ROUTINE));
    expect(await stopHook('/hook/some-other-project/stop')).not.toHaveProperty('decision');
  });

  /*
   * A hook whose body never arrives, or arrives as something other than JSON,
   * must not hold a session hostage — but it must also still do its job, which
   * is why an empty body is treated as "a normal stop" rather than as an error.
   */
  it('survives a request with no body, or an unreadable one', async () => {
    await serve(withWork(ROUTINE));
    const raw = await fetch(`http://127.0.0.1:${port}/hook/stop`, { method: 'POST', body: '{ not json' });
    expect((await raw.json()).decision).toBe('block');
    expect((await stopHook('/hook/stop', {}, 'GET')).decision).toBe('block');
  });

  it('leaves everything that is not a stop hook to the rest of the server', async () => {
    await serve(withWork(ROUTINE));
    const res = await fetch(`http://127.0.0.1:${port}/hook/stopping`);
    expect(res.status).toBe(405);
  });
});

describe('identifying the caller', () => {
  /*
   * The one handle that separates two agents. A process list cannot (two
   * `claude` sessions look identical) and the board cannot (it attributes by
   * path, so an agent editing someone else's file is recorded as them).
   */
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const call = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'issues' } });

  it('mints an id on initialize and hands it back', () => {
    const { caller, minted } = identify({ headers: {} }, init);
    expect(minted).toBeTruthy();
    expect(caller.id).toBe(minted);
  });

  it('gives two clients two identities', () => {
    const a = identify({ headers: {} }, init).minted;
    const b = identify({ headers: {} }, init).minted;
    expect(a).not.toBe(b);
  });

  it('recognises a client that echoes the header back', () => {
    const { caller, minted } = identify({ headers: { 'mcp-session-id': 'abc' } }, call);
    expect(caller.id).toBe('abc');
    expect(minted).toBeNull(); // already had one — do not issue another
  });

  it('leaves a client that never says who it is anonymous rather than inventing one', () => {
    const { caller, minted } = identify({ headers: {} }, call);
    expect(caller.id).toBeNull();
    expect(minted).toBeNull();
  });

  it('does not fall over on a malformed body', () => {
    expect(identify({ headers: {} }, 'not json')).toEqual({ caller: { id: null }, minted: null });
  });
});
