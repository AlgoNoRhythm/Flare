import { describe, expect, it } from 'vitest';
import {
  baseSnapshotFor,
  groupByTier,
  reviewTier,
  sortForReview,
  tierSummary,
  type TierInput,
} from '../shared/review';

function file(over: Partial<TierInput> = {}): TierInput {
  return {
    path: 'src/a.ts',
    risk: 10,
    blastRadius: 0,
    fanIn: 0,
    coveragePct: 90,
    testedBy: 1,
    complexity: 5,
    inCycle: false,
    isTest: false,
    ...over,
  };
}

describe('reviewTier', () => {
  it('leaves small, covered, unreferenced files in skim', () => {
    expect(reviewTier(file()).tier).toBe('skim');
  });

  it('promotes anything with a wide blast radius to careful', () => {
    const result = reviewTier(file({ blastRadius: 14 }));
    expect(result.tier).toBe('careful');
    expect(result.reasons[0]).toBe('14 files break if this is wrong');
  });

  it('promotes uncovered, widely-imported files to careful', () => {
    const result = reviewTier(file({ fanIn: 4, coveragePct: null, testedBy: 0 }));
    expect(result.tier).toBe('careful');
    expect(result.reasons).toContain('no test covers it');
  });

  it('treats low coverage as uncovered', () => {
    const result = reviewTier(file({ fanIn: 4, coveragePct: 12 }));
    expect(result.tier).toBe('careful');
    expect(result.reasons).toContain('only 12% covered');
  });

  it('promotes cycle members that anything imports', () => {
    expect(reviewTier(file({ inCycle: true, fanIn: 1 })).tier).toBe('careful');
    expect(reviewTier(file({ inCycle: true, fanIn: 0 })).reasons).toContain('sits in an import cycle');
  });

  it('uses the middle tier for real-but-contained changes', () => {
    expect(reviewTier(file({ blastRadius: 4 })).tier).toBe('read');
    expect(reviewTier(file({ complexity: 55 })).tier).toBe('read');
    expect(reviewTier(file({ risk: 35 })).tier).toBe('read');
  });

  it('always gives a reason, even when skimming', () => {
    expect(reviewTier(file()).reasons).toEqual(['nothing depends on it yet']);
    expect(reviewTier(file({ isTest: true })).reasons).toEqual(['a test — the suite checks it for you']);
  });

  it('does not claim coverage problems for well-covered files', () => {
    expect(reviewTier(file({ coveragePct: 95, fanIn: 5 })).reasons).not.toContain('no test covers it');
  });
});

describe('sortForReview', () => {
  it('orders careful first, then by risk', () => {
    const items = [
      { path: 'c.ts', tier: 'skim' as const, risk: 90 },
      { path: 'a.ts', tier: 'careful' as const, risk: 61 },
      { path: 'b.ts', tier: 'careful' as const, risk: 80 },
      { path: 'd.ts', tier: 'read' as const, risk: 30 },
    ];
    expect(sortForReview(items).map((i) => i.path)).toEqual(['b.ts', 'a.ts', 'd.ts', 'c.ts']);
  });
});

describe('baseSnapshotFor', () => {
  /*
   * The bug this exists to stop: diffing a change against the snapshot taken
   * *after* it, which renders a clean, empty diff for an edit that plainly
   * happened — and a revert that restores what is already on disk.
   */
  const timeline = [
    { hash: 'after', time: 3_000 },
    { hash: 'before', time: 1_000 },
    { hash: 'session-start', time: 100 },
  ];

  it('picks the newest snapshot taken before the change began', () => {
    expect(baseSnapshotFor(2_000, timeline)).toBe('before');
  });

  it('never picks one taken after it, however close', () => {
    expect(baseSnapshotFor(2_999, timeline)).toBe('before');
    expect(baseSnapshotFor(3_000, timeline)).toBe('after'); // taken at the same instant
  });

  it('falls back to the session-start snapshot for the first change', () => {
    expect(baseSnapshotFor(500, timeline)).toBe('session-start');
  });

  it('returns null when nothing older exists — HEAD is the only base left', () => {
    expect(baseSnapshotFor(50, timeline)).toBeNull();
    expect(baseSnapshotFor(1_000, [])).toBeNull();
  });

  it('does not care what order the timeline arrives in', () => {
    expect(baseSnapshotFor(2_000, [...timeline].reverse())).toBe('before');
  });
});

describe('tierSummary', () => {
  it('reads like an instruction', () => {
    expect(tierSummary(['careful', 'careful', 'read', 'skim', 'skim', 'skim'])).toBe(
      '2 to read carefully, 1 to read, 3 to skim',
    );
    expect(tierSummary([])).toBe('nothing to review');
  });
});

describe('groupByTier', () => {
  it('buckets rows worst tier first and leaves empty tiers out', () => {
    const rows = [
      { tier: 'skim' as const, path: 'c' },
      { tier: 'careful' as const, path: 'a' },
      { tier: 'skim' as const, path: 'd' },
    ];
    expect(groupByTier(rows)).toEqual([
      { tier: 'careful', rows: [{ tier: 'careful', path: 'a' }] },
      { tier: 'skim', rows: [{ tier: 'skim', path: 'c' }, { tier: 'skim', path: 'd' }] },
    ]);
    expect(groupByTier([])).toEqual([]);
  });
});
