import { describe, expect, it } from 'vitest';
import { attribute, claimCovers, type TaskClaim } from '../shared/attribution';
import { post, workingOn, type ChannelMessage } from '../shared/channel';

/**
 * Which agent wrote this.
 *
 * The case that matters is two `claude` sessions running at once: presence
 * cannot separate them, so what they *said* has to. What must not happen is a
 * confident wrong answer — attributing one agent's write to another turns a
 * real conflict into a clean history.
 */

const oauth: TaskClaim = { id: 't1', title: 'Add OAuth', paths: ['oauth/'], by: 'claude' };
const refactor: TaskClaim = { id: 't2', title: 'Refactor auth', paths: ['auth/session.py'], by: 'claude' };

const twoLive = [
  { terminalId: 't1', agent: 'claude', at: 200 },
  { terminalId: 't2', agent: 'claude', at: 199 },
];

/** A room with one `taking` in it, from the given agent. */
function room(
  entries: { from: string; name: string; paths: string[]; at: number; kind?: 'taking' | 'done' }[],
): ChannelMessage[] {
  let feed: ChannelMessage[] = [];
  for (const [i, e] of entries.entries()) {
    feed = post(feed, {
      id: `m${i}`,
      from: e.from,
      fromName: e.name,
      fromTool: 'claude',
      kind: e.kind ?? 'taking',
      text: `working on ${e.paths.join(', ')}`,
      paths: e.paths,
      now: e.at,
    });
  }
  return feed;
}

describe('claimCovers', () => {
  it('matches an exact file', () => {
    expect(claimCovers(['auth/session.py'], 'auth/session.py')).toBe(true);
  });

  it('matches under a directory', () => {
    expect(claimCovers(['oauth/'], 'oauth/flow.py')).toBe(true);
    expect(claimCovers(['oauth'], 'oauth/flow.py')).toBe(true);
  });

  it('does not match a directory that only shares a prefix', () => {
    expect(claimCovers(['oauth'], 'oauthlib/flow.py')).toBe(false);
  });
});

describe('a recorded intent', () => {
  /*
   * The rung that exists because the one below it is wrong in the case that
   * matters: an agent editing a file listed on someone else's card.
   */
  const intent = { id: 's-oauth', label: 'Add OAuth', tool: 'claude', at: 1_000 };

  it('beats the card, so an agent editing another agents file is recorded as itself', () => {
    const out = attribute({
      paths: ['auth/session.py'], // listed on Refactor auth's card, not OAuth's
      live: twoLive,
      claims: [oauth, refactor],
      intents: [intent],
      now: 1_500,
    });
    expect(out.agentLabel).toBe('Add OAuth');
    expect(out.agentId).toBe('mcp:s-oauth');
    expect(out.basis).toBe('intent');
  });

  it('is what makes the crossing visible at all', () => {
    // the same file, written by each agent under its own intent
    const first = attribute({
      paths: ['auth/session.py'],
      live: twoLive,
      claims: [oauth, refactor],
      intents: [{ id: 's-refactor', label: 'Refactor auth', tool: 'claude', at: 1_000 }],
      now: 1_100,
    });
    const second = attribute({
      paths: ['auth/session.py'],
      live: twoLive,
      claims: [oauth, refactor],
      intents: [intent],
      now: 1_500,
    });
    expect(first.agentId).not.toBe(second.agentId);
  });

  it('stops speaking for writes once it is stale', () => {
    const out = attribute({
      paths: ['oauth/flow.py'],
      live: twoLive,
      claims: [oauth, refactor],
      intents: [intent],
      now: 1_000 + 11 * 60_000,
    });
    expect(out.basis).toBe('claim');
    expect(out.agentLabel).toBe('Add OAuth'); // via the card, not the intent
  });

  it('falls back to an opaque but distinct identity when nothing was claimed', () => {
    const out = attribute({
      paths: ['scratch.ts'],
      live: [],
      claims: [],
      intents: [{ id: 's-1', label: null, tool: null, at: 1_000 }],
      now: 1_100,
    });
    expect(out.agentId).toBe('mcp:s-1');
    expect(out.agent).toBe('agent'); // never 'you' — the detectors skip the human
  });

  /*
   * The reason intents are a list.
   *
   * One global slot meant whichever agent announced last owned every write for
   * the next ten minutes, its neighbour's included — a confident wrong answer
   * produced by two agents each doing exactly what they were asked to.
   */
  it('will not pick between two agents that both announced', () => {
    const out = attribute({
      paths: ['scratch.ts'],
      live: twoLive,
      claims: [],
      intents: [
        { id: 's-a', label: 'A', tool: 'claude', at: 1_000 },
        { id: 's-b', label: 'B', tool: 'claude', at: 1_200 },
      ],
      now: 1_300,
    });
    expect(out.agent).toBe('mixed');
    expect(out.basis).toBe('unknown');
  });

  it('is separated by the channel when one of them said it was taking the file', () => {
    const out = attribute({
      paths: ['shared/graph.ts'],
      live: twoLive,
      claims: [],
      intents: [
        { id: 's-a', label: 'A', tool: 'claude', at: 1_000 },
        { id: 's-b', label: 'B', tool: 'claude', at: 1_200 },
      ],
      working: workingOn(
        room([{ from: 'mcp:s-a', name: 'Claude 1', paths: ['shared/graph.ts'], at: 900 }]),
        1_300,
      ),
      now: 1_300,
    });
    expect(out.agentId).toBe('mcp:s-a');
    expect(out.basis).toBe('intent');
  });
});

describe('what an agent said in the channel', () => {
  const working = (now: number, entries: Parameters<typeof room>[0]) => workingOn(room(entries), now);

  it('attributes a write to the only agent that said it was taking the file', () => {
    const out = attribute({
      paths: ['shared/graph.ts'],
      live: twoLive,
      claims: [],
      working: working(2_000, [
        { from: 'mcp:s-a', name: 'Claude 1', paths: ['shared/'], at: 1_000 },
      ]),
      now: 2_000,
    });
    expect(out.agentId).toBe('mcp:s-a');
    expect(out.agentName).toBe('Claude 1');
    expect(out.basis).toBe('notice');
  });

  /*
   * The room allows two agents to want the same file — that is the situation
   * it exists to surface, not one to resolve behind their backs. Picking a
   * winner here would erase it before anyone saw it.
   */
  it('refuses to pick when two agents both said they were taking it', () => {
    const out = attribute({
      paths: ['shared/graph.ts'],
      live: twoLive,
      claims: [],
      working: working(2_000, [
        { from: 'mcp:s-a', name: 'Claude 1', paths: ['shared/graph.ts'], at: 1_000 },
        { from: 'mcp:s-b', name: 'Claude 2', paths: ['shared/graph.ts'], at: 1_100 },
      ]),
      now: 2_000,
    });
    expect(out.agent).toBe('mixed');
    expect(out.basis).toBe('unknown');
  });

  it('does not speak for a write that also touches files nobody took', () => {
    const out = attribute({
      paths: ['shared/graph.ts', 'server/index.ts'],
      live: twoLive,
      claims: [],
      working: working(2_000, [
        { from: 'mcp:s-a', name: 'Claude 1', paths: ['shared/graph.ts'], at: 1_000 },
      ]),
      now: 2_000,
    });
    expect(out.basis).toBe('unknown');
  });

  it('stops speaking once the agent posts that it is done', () => {
    const out = attribute({
      paths: ['shared/graph.ts'],
      live: twoLive,
      claims: [],
      working: working(2_000, [
        { from: 'mcp:s-a', name: 'Claude 1', paths: ['shared/graph.ts'], at: 1_000 },
        { from: 'mcp:s-a', name: 'Claude 1', paths: ['shared/graph.ts'], at: 1_500, kind: 'done' },
      ]),
      now: 2_000,
    });
    expect(out.basis).toBe('unknown');
  });

  it('ranks below an announced intent, so a crossing stays visible', () => {
    /*
     * Claude 2 announced an edit; Claude 1 had said it was taking the file.
     * The write belongs to whoever announced it — attributing it to the agent
     * that spoke first would delete the evidence that anyone crossed anyone.
     */
    const out = attribute({
      paths: ['shared/graph.ts'],
      live: twoLive,
      claims: [],
      intents: [{ id: 's-b', label: 'Fix the cycle', tool: 'claude', name: 'Claude 2', at: 1_800 }],
      working: working(2_000, [
        { from: 'mcp:s-a', name: 'Claude 1', paths: ['shared/graph.ts'], at: 1_000 },
      ]),
      now: 2_000,
    });
    expect(out.agentId).toBe('mcp:s-b');
    expect(out.agentName).toBe('Claude 2');
    expect(out.basis).toBe('intent');
  });
});

describe('attribute', () => {
  it('separates two concurrent claudes by what they claimed', () => {
    const a = attribute({ paths: ['oauth/flow.py'], live: twoLive, claims: [oauth, refactor] });
    const b = attribute({ paths: ['auth/session.py'], live: twoLive, claims: [oauth, refactor] });

    expect(a.agentLabel).toBe('Add OAuth');
    expect(b.agentLabel).toBe('Refactor auth');
    expect(a.agentId).not.toBe(b.agentId);
    expect(a.basis).toBe('claim');
  });

  it('refuses to pick when a write spans two claims', () => {
    const out = attribute({
      paths: ['oauth/flow.py', 'auth/session.py'],
      live: twoLive,
      claims: [oauth, refactor],
    });
    expect(out.agent).toBe('mixed');
    expect(out.agentId).toBeUndefined();
    expect(out.basis).toBe('unknown');
  });

  it('falls back to the only agent running when nothing is claimed', () => {
    const out = attribute({
      paths: ['scratch.ts'],
      live: [{ terminalId: 't3', agent: 'codex', at: 10 }],
      claims: [],
    });
    expect(out).toEqual({
      agent: 'codex',
      agentId: 'codex:t3',
      agentLabel: 'codex',
      basis: 'sole-agent',
    });
  });

  it('is you when nothing is running', () => {
    expect(attribute({ paths: ['a.ts'], live: [], claims: [] })).toEqual({
      agent: 'you',
      basis: 'unknown',
    });
  });

  it('says mixed rather than guessing between two live agents', () => {
    const out = attribute({ paths: ['scratch.ts'], live: twoLive, claims: [oauth] });
    expect(out.agent).toBe('mixed');
    expect(out.basis).toBe('unknown');
  });

  it('keeps the claim even when the human moved the card', () => {
    const out = attribute({
      paths: ['oauth/flow.py'],
      live: twoLive,
      claims: [{ ...oauth, by: 'you' }],
    });
    expect(out.agentLabel).toBe('Add OAuth');
    expect(out.agent).toBe('claude'); // the tool that is actually running
  });
});
