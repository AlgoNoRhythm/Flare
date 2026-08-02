import { describe, expect, it } from 'vitest';
import { reviewTier, sortForReview, tierSummary, type TierInput } from '../shared/review';

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

describe('tierSummary', () => {
  it('reads like an instruction', () => {
    expect(tierSummary(['careful', 'careful', 'read', 'skim', 'skim', 'skim'])).toBe(
      '2 to read carefully, 1 to read, 3 to skim',
    );
    expect(tierSummary([])).toBe('nothing to review');
  });
});
