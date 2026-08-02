import { describe, expect, it } from 'vitest';
import { parseLcov, resolveCoverage } from '../shared/coverage';
import { riskScore } from '../src/graph/lenses';
import { GraphBuilder } from '../shared/graph';
import { parseFile } from '../shared/parser';

const LCOV = `TN:
SF:C:\\proj\\src\\util.ts
DA:1,5
DA:2,0
DA:3,3
DA:4,0
end_of_record
SF:src/app.ts
LF:10
LH:9
end_of_record
SF:/other/checkout/lib/deep/thing.ts
DA:1,1
end_of_record
SF:/somewhere/unrelated.ts
DA:1,0
end_of_record
`;

describe('parseLcov', () => {
  it('parses DA lines and LF/LH summaries', () => {
    const raw = parseLcov(LCOV);
    expect(raw['C:\\proj\\src\\util.ts']).toEqual({ found: 4, hit: 2 });
    expect(raw['src/app.ts']).toEqual({ found: 10, hit: 9 });
    expect(raw['/other/checkout/lib/deep/thing.ts']).toEqual({ found: 1, hit: 1 });
  });
});

describe('resolveCoverage', () => {
  const files = ['src/util.ts', 'src/app.ts', 'lib/deep/thing.ts'];

  it('maps absolute, relative and suffix-matched paths onto project files', () => {
    const cov = resolveCoverage(parseLcov(LCOV), files, 'C:/proj');
    expect(cov['src/util.ts']).toEqual({ found: 4, hit: 2, pct: 50 });
    expect(cov['src/app.ts']).toEqual({ found: 10, hit: 9, pct: 90 });
    expect(cov['lib/deep/thing.ts'].pct).toBe(100);
    // unrelated file not force-mapped
    expect(Object.keys(cov)).toHaveLength(3);
  });

  it('is case-insensitive for windows paths', () => {
    const cov = resolveCoverage(parseLcov('SF:c:\\PROJ\\SRC\\Util.ts\nDA:1,1\nend_of_record\n'), files, 'C:/proj');
    expect(cov['src/util.ts']).toBeDefined();
  });
});

describe('riskScore with coverage', () => {
  const node = new GraphBuilder()
    .setAll([parseFile('src/x.ts', 'export const x = 1;')])
    .nodes[0];

  it('low coverage raises risk, high coverage lowers it below the untested heuristic', () => {
    const heuristic = riskScore(node); // untested per linkage -> 1.8x factor
    const wellCovered = riskScore(node, 95);
    const uncovered = riskScore(node, 0);
    expect(wellCovered).toBeLessThan(heuristic);
    expect(uncovered).toBeGreaterThan(wellCovered);
  });
});
