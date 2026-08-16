import { describe, expect, it } from 'vitest';
import { attribute, claimCovers, type TaskClaim } from '../shared/attribution';

/**
 * Which agent wrote this.
 *
 * The case that matters is two `claude` sessions running at once: presence
 * cannot separate them, so the board has to. What must not happen is a
 * confident wrong answer — attributing one agent's write to another turns a
 * real conflict into a clean history.
 */

const oauth: TaskClaim = { id: 't1', title: 'Add OAuth', paths: ['oauth/'], by: 'claude' };
const refactor: TaskClaim = { id: 't2', title: 'Refactor auth', paths: ['auth/session.py'], by: 'claude' };

const twoLive = [
  { terminalId: 't1', agent: 'claude', at: 200 },
  { terminalId: 't2', agent: 'claude', at: 199 },
];

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

  it('beats the claim, so an agent editing another agents file is recorded as itself', () => {
    const out = attribute({
      paths: ['auth/session.py'], // listed on Refactor auth's card, not OAuth's
      live: twoLive,
      claims: [oauth, refactor],
      intent,
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
      intent: { id: 's-refactor', label: 'Refactor auth', tool: 'claude', at: 1_000 },
      now: 1_100,
    });
    const second = attribute({
      paths: ['auth/session.py'],
      live: twoLive,
      claims: [oauth, refactor],
      intent,
      now: 1_500,
    });
    expect(first.agentId).not.toBe(second.agentId);
  });

  it('stops speaking for writes once it is stale', () => {
    const out = attribute({
      paths: ['oauth/flow.py'],
      live: twoLive,
      claims: [oauth, refactor],
      intent,
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
      intent: { id: 's-1', label: null, tool: null, at: 1_000 },
      now: 1_100,
    });
    expect(out.agentId).toBe('mcp:s-1');
    expect(out.agent).toBe('agent'); // never 'you' — the detectors skip the human
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
