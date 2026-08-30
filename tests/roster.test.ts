import { describe, expect, it } from 'vitest';
import {
  AGENT_GONE_MS,
  AGENT_IDLE_MS,
  displayName,
  nameFor,
  nextOrdinal,
  presenceOf,
  register,
  sortRoster,
  toolFromClient,
  touch,
  type AgentRecord,
} from '../shared/roster';

/**
 * Who is working on this project, and what to call them.
 *
 * The whole of Flare's multi-agent story rests on two `claude` sessions being
 * two *different* agents, and on a person being able to say which is which out
 * loud. So the two things worth pinning down are that an identity comes from
 * the MCP session rather than from the tool name, and that a name, once given,
 * does not move — a "Claude 1" that becomes a different agent halfway through
 * the session silently merges two of them in every burst that mentions it.
 */

const T0 = 1_700_000_000_000;

describe('toolFromClient', () => {
  it('reads the tool out of the name a client gives itself', () => {
    expect(toolFromClient('claude-code')).toBe('claude');
    expect(toolFromClient('Codex CLI')).toBe('codex');
    expect(toolFromClient('opencode')).toBe('opencode');
  });

  it('keeps an unrecognised client as itself rather than calling it "agent"', () => {
    expect(toolFromClient('my-harness')).toBe('my-harness');
  });

  it('falls back to the process list only when it is unanimous', () => {
    expect(toolFromClient(null, ['codex'])).toBe('codex');
    expect(toolFromClient(null, ['claude', 'codex'])).toBe('agent');
    expect(toolFromClient(null, [])).toBe('agent');
  });
});

describe('displayName', () => {
  it('is the tool and its number', () => {
    expect(displayName('claude', 2)).toBe('Claude 2');
    expect(displayName('opencode', 1)).toBe('OpenCode 1');
  });

  it('title-cases a tool it has never heard of', () => {
    expect(displayName('my-harness', 1)).toBe('My Harness 1');
  });
});

describe('register', () => {
  it('numbers each tool separately, in arrival order', () => {
    let roster: AgentRecord[] = [];
    for (const [id, client] of [
      ['s1', 'claude-code'],
      ['s2', 'claude-code'],
      ['s3', 'codex'],
    ] as const) {
      roster = register(roster, { id: `mcp:${id}`, client, now: T0 }).roster;
    }
    expect(roster.map((a) => a.name)).toEqual(['Claude 1', 'Claude 2', 'Codex 1']);
  });

  it('is idempotent — the same session keeps the name it was given', () => {
    const first = register([], { id: 'mcp:s1', client: 'claude-code', now: T0 });
    const again = register(first.roster, { id: 'mcp:s1', client: 'claude-code', now: T0 + 5_000 });
    expect(again.roster).toHaveLength(1);
    expect(again.agent.name).toBe('Claude 1');
    expect(again.agent.lastSeen).toBe(T0 + 5_000);
  });

  /*
   * A client that calls a tool before it initialises is registered from the
   * process list, which may have had nothing to say. The moment it names
   * itself the roster should agree — but the *ordinal* has to be re-taken
   * within its new tool, not kept from the generic one.
   */
  it('takes a late identification, and renumbers within the tool it turned out to be', () => {
    let roster = register([], { id: 'mcp:s1', client: 'claude-code', now: T0 }).roster;
    roster = register(roster, { id: 'mcp:s2', client: null, now: T0 }).roster;
    expect(roster[1].name).toBe('Agent 1');

    const named = register(roster, { id: 'mcp:s2', client: 'claude-code', now: T0 + 10 });
    expect(named.agent.name).toBe('Claude 2');
    expect(named.roster.find((a) => a.id === 'mcp:s1')!.name).toBe('Claude 1');
  });

  /*
   * The one that would quietly corrupt a whole session's review: a Claude 1
   * that exits and a new session arriving are two different agents, and giving
   * the newcomer the free number would merge their work under one name.
   */
  it('never reuses the number of an agent that has gone', () => {
    let roster = register([], { id: 'mcp:s1', client: 'claude-code', now: T0 }).roster;
    roster = register(roster, { id: 'mcp:s2', client: 'claude-code', now: T0 }).roster;
    // s1 goes silent, then a third session arrives
    const third = register(roster, { id: 'mcp:s3', client: 'claude-code', now: T0 + AGENT_GONE_MS + 1 });
    expect(third.agent.name).toBe('Claude 3');
    expect(nextOrdinal(third.roster, 'claude')).toBe(4);
  });
});

describe('presence', () => {
  const agent = (lastSeen: number): Pick<AgentRecord, 'lastSeen'> => ({ lastSeen });

  it('decays with the clock', () => {
    expect(presenceOf(agent(T0), T0 + 1_000)).toBe('working');
    expect(presenceOf(agent(T0), T0 + AGENT_IDLE_MS + 1)).toBe('idle');
    expect(presenceOf(agent(T0), T0 + AGENT_GONE_MS + 1)).toBe('gone');
  });

  it('puts the ones that are here first, then keeps arrival order', () => {
    let roster = register([], { id: 'mcp:s1', client: 'claude-code', now: T0 }).roster;
    roster = register(roster, { id: 'mcp:s2', client: 'claude-code', now: T0 + 10 }).roster;
    roster = touch(roster, 'mcp:s2', T0 + AGENT_GONE_MS + 100);
    // s1 has gone quiet, s2 has not
    expect(sortRoster(roster, T0 + AGENT_GONE_MS + 200).map((a) => a.name)).toEqual([
      'Claude 2',
      'Claude 1',
    ]);
  });
});

describe('nameFor', () => {
  const roster = register([], { id: 'mcp:s1', client: 'claude-code', now: T0 }).roster;

  it('resolves the id a burst carries', () => {
    expect(nameFor(roster, 'mcp:s1', 'claude')).toBe('Claude 1');
  });

  it('degrades to what the caller already had rather than showing an id', () => {
    expect(nameFor(roster, 'task:t1', 'Add OAuth')).toBe('Add OAuth');
    expect(nameFor(roster, undefined, 'you')).toBe('you');
  });
});
