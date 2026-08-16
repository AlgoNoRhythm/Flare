import { describe, expect, it } from 'vitest';
import type { ChangeBurst } from '../shared/activity';
import type { Conflict } from '../shared/conflicts';
import type { Question } from '../shared/tasks';
import { ABSENCE_MS, BRIEFING_ROWS, briefing, shouldBrief, spanLabel } from '../shared/briefing';

/**
 * What happened while you were away.
 *
 * The two ways this fails are both fatal to it: greeting someone with a
 * ceremony about changes they sat and watched, and burying the one thing that
 * needed them under four things that did not.
 */

function burst(over: Partial<ChangeBurst> & Pick<ChangeBurst, 'id'>): ChangeBurst {
  const at = over.endedAt ?? 2_000;
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

function conflict(id: string, at: number): Conflict {
  return {
    id,
    kind: 'contested-file',
    severity: 'warning',
    at,
    agents: [
      { id: 'a', label: 'Add OAuth' },
      { id: 'b', label: 'Refactor auth' },
    ],
    paths: ['auth/session.py'],
    summary: `crossing ${id}`,
    detail: '',
    burstIds: [],
  };
}

function question(id: string, at: number, answeredAt: number | null = null): Question {
  return { id, text: `q ${id}`, detail: '', by: 'claude', at, answer: '', answeredAt, blocks: ['t1'] };
}

const SINCE = 1_000;
const AWAY = SINCE + ABSENCE_MS + 1;

describe('shouldBrief', () => {
  it('greets you after a real absence with agent work in it', () => {
    expect(shouldBrief({ since: SINCE, now: AWAY, bursts: [burst({ id: 'b1', endedAt: 2_000 })] })).toBe(true);
  });

  it('stays quiet for a short break', () => {
    expect(
      shouldBrief({ since: SINCE, now: SINCE + 60_000, bursts: [burst({ id: 'b1', endedAt: 2_000 })] }),
    ).toBe(false);
  });

  it('stays quiet when nothing happened while you were gone', () => {
    expect(shouldBrief({ since: SINCE, now: AWAY, bursts: [burst({ id: 'b1', endedAt: 500 })] })).toBe(false);
  });

  it('does not report your own edits back to you', () => {
    expect(
      shouldBrief({ since: SINCE, now: AWAY, bursts: [burst({ id: 'b1', endedAt: 2_000, agent: 'you' })] }),
    ).toBe(false);
  });

  it('stays quiet on a first-ever open, when there is no "since"', () => {
    expect(shouldBrief({ since: 0, now: AWAY, bursts: [burst({ id: 'b1', endedAt: 2_000 })] })).toBe(false);
  });
});

describe('briefing', () => {
  const base = {
    since: SINCE,
    bursts: [
      burst({ id: 'b1', endedAt: 2_000, changed: ['a.ts', 'b.ts'], agentId: 'claude:t1' }),
      burst({ id: 'b2', endedAt: 3_000, changed: ['b.ts'], agentId: 'claude:t2', verification: 'passed' as const }),
    ],
    conflicts: [conflict('c1', 2_500)],
    questions: [question('q1', 2_600)],
    decisions: [],
  };

  it('counts the night without double-counting a file two agents touched', () => {
    const out = briefing(base)!;
    expect(out.files).toBe(2);
    expect(out.changes).toBe(2);
    expect(out.agents).toBe(2);
  });

  it('puts what wants an answer first, and the good news last', () => {
    expect(briefing(base)!.rows.map((r) => r.kind)).toEqual(['conflict', 'question', 'clear']);
  });

  it('never grows past five rows', () => {
    const out = briefing({
      ...base,
      conflicts: [1, 2, 3, 4, 5, 6, 7].map((n) => conflict(`c${n}`, 2_000 + n)),
    })!;
    expect(out.rows).toHaveLength(BRIEFING_ROWS);
    expect(out.needsYou).toBe(8); // seven crossings and the question — the count still tells the truth
  });

  it('drops the good-news row rather than something that wants an answer', () => {
    const out = briefing({
      ...base,
      conflicts: [1, 2, 3, 4, 5].map((n) => conflict(`c${n}`, 2_000 + n)),
    })!;
    expect(out.rows.every((r) => r.kind !== 'clear')).toBe(true);
  });

  it('still says something when the night was clean', () => {
    const out = briefing({ ...base, conflicts: [], questions: [] })!;
    expect(out.quiet).toBe(true);
    expect(out.needsYou).toBe(0);
    expect(out.rows).toEqual([
      expect.objectContaining({ kind: 'clear', text: '1 of 2 changes verified' }),
    ]);
  });

  it('ignores questions answered before you got back', () => {
    const out = briefing({ ...base, questions: [question('q1', 2_600, 2_700)] })!;
    expect(out.rows.some((r) => r.kind === 'question')).toBe(false);
  });

  it('ignores what happened before you left', () => {
    const out = briefing({ ...base, conflicts: [conflict('old', 500)] })!;
    expect(out.conflicts).toBe(0);
  });

  it('is nothing at all when no agent worked', () => {
    expect(briefing({ ...base, bursts: [burst({ id: 'b1', endedAt: 2_000, agent: 'you' })] })).toBeNull();
  });
});

describe('spanLabel', () => {
  it('reads as the shape of a night, not a stopwatch', () => {
    expect(spanLabel(45 * 60_000)).toBe('45m');
    expect(spanLabel(6 * 3_600_000 + 20 * 60_000)).toBe('6h 20m');
    expect(spanLabel(2 * 3_600_000)).toBe('2h');
    expect(spanLabel(5_000)).toBe('1m');
  });
});
