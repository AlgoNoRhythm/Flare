import { describe, expect, it } from 'vitest';
import type { ChangeBurst } from '../shared/activity';
import type { Conflict } from '../shared/conflicts';
import { buildTicks } from '../src/components/BurstStrip';

/**
 * What the time machine puts on its rail.
 *
 * The strip is the only place the whole session is visible at once, so an
 * event that never becomes a tick is an event nobody will find — and one that
 * lands in the wrong order tells the wrong story about who did what first.
 */

function burst(over: Partial<ChangeBurst> & Pick<ChangeBurst, 'id'>): ChangeBurst {
  const at = over.endedAt ?? 1_000;
  return {
    startedAt: at - 100,
    endedAt: at,
    agent: 'claude',
    changed: ['a.ts'],
    removed: [],
    smells: [],
    verification: 'not-run',
    verifiedBy: null,
    checks: [],
    intent: null,
    snapshotHash: null,
    ...over,
  };
}

const conflict: Conflict = {
  id: 'x',
  kind: 'contested-file',
  severity: 'warning',
  at: 2_500,
  agents: [
    { id: 'a', label: 'Add OAuth' },
    { id: 'b', label: 'Refactor auth' },
  ],
  paths: ['auth/session.py'],
  summary: 'Add OAuth and Refactor auth both wrote auth/session.py',
  detail: '',
  burstIds: ['b2', 'b1'],
};

describe('buildTicks', () => {
  const base = {
    bursts: [
      burst({ id: 'b1', endedAt: 1_000, agentLabel: 'Refactor auth', agentId: 'claude:t1' }),
      burst({ id: 'b2', endedAt: 3_000, agentLabel: 'Add OAuth', agentId: 'claude:t2' }),
    ],
    conflicts: [conflict],
    decisions: [
      {
        id: 'd1',
        title: 'Redis for sessions',
        detail: '',
        alternatives: '',
        status: 'proposed' as const,
        by: 'claude',
        at: 2_000,
        paths: [],
        verdict: '',
        decidedAt: null,
      },
    ],
    questions: [
      {
        id: 'q1',
        text: 'Redis or Postgres?',
        detail: '',
        by: 'claude',
        at: 500,
        answer: '',
        answeredAt: null,
        blocks: [],
      },
    ],
    lastGreen: null,
  };

  it('puts every kind of event on one rail, in the order it happened', () => {
    expect(buildTicks(base).map((t) => t.kind)).toEqual([
      'question',
      'burst',
      'decision',
      'conflict',
      'burst',
    ]);
  });

  it('carries what a burst tick needs to draw itself', () => {
    const tick = buildTicks(base).find((t) => t.id === 'b2')!;
    expect(tick.weight).toBe(1);
    expect(tick.tone).toBe('crit'); // never checked
    expect(tick.title).toContain('Add OAuth');
    expect(tick.title).toContain('never checked');
  });

  it('gives two agents two colours', () => {
    const ticks = buildTicks(base).filter((t) => t.kind === 'burst');
    expect(ticks[0].color).not.toBe(ticks[1].color);
  });

  it('flags the last green burst rather than adding a tick for it', () => {
    const ticks = buildTicks({
      ...base,
      bursts: [burst({ id: 'b1', endedAt: 1_000, snapshotHash: 'abc', verification: 'passed' })],
      lastGreen: { hash: 'abc', at: 1_000 },
    });
    expect(ticks.filter((t) => t.kind === 'burst')).toHaveLength(1);
    expect(ticks.find((t) => t.id === 'b1')?.green).toBe(true);
  });

  it('keeps every burst on the rail, whatever is selected — a span narrows the map, not the history', () => {
    const ticks = buildTicks(base);
    expect(ticks.filter((t) => t.kind === 'burst').map((t) => t.id)).toEqual(['b1', 'b2']);
  });

  it('says what a conflict is in the hover, since the tick itself is one glyph', () => {
    const tick = buildTicks(base).find((t) => t.kind === 'conflict')!;
    expect(tick.title).toContain('both wrote auth/session.py');
    expect(tick.conflict).toBe(conflict);
  });
});
