import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../shared/graph';
import { parseFile } from '../shared/parser';
import { computeInsights, type InsightsInput } from '../shared/insights';
import type { ShadowSnapshot } from '../shared/types';

const branchy = (n: number) =>
  `export function f(a: number) {\n${'  if (a > 1 && a < 5) a++;\n'.repeat(n)}  return a;\n}\n`;

function buildInput(overrides: Partial<InsightsInput> = {}): InsightsInput {
  const gb = new GraphBuilder();
  const graph = gb.setAll([
    parseFile('src/core.ts', branchy(8) + 'export const core = 1;\n// TODO one\n// FIXME two\n// TODO three\n'),
    parseFile('src/a.ts', `import { f } from './core';\nexport const a = f(1);`),
    parseFile('src/b.ts', `import { f } from './core';\nimport { a } from './a';\nexport const b = f(2) + a;`),
    parseFile('src/c.ts', `import { b } from './b';\nexport const c = b;`),
    parseFile('src/dead.ts', `export const nobodyUsesMe = 1;`),
    parseFile('tests/core.test.ts', `import { f } from '../src/core';`),
    parseFile('src/cy1.ts', `import './cy2'; export const x1 = 1;`),
    parseFile('src/cy2.ts', `import './cy1'; export const x2 = 1;`),
  ]);
  return {
    nodes: graph.nodes,
    edges: graph.edges,
    churn: { 'src/core.ts': 12 },
    coverage: {},
    changedAt: {},
    changedBy: {},
    review: { approvedAt: {}, checkpointAt: 0 },
    snapshots: [],
    ...overrides,
  };
}

describe('computeInsights', () => {
  it('computes metrics with blast radius and normalized composites', () => {
    const insights = computeInsights(buildInput());
    const core = insights.files.find((f) => f.path === 'src/core.ts')!;
    expect(core.blastRadius).toBe(4); // a, b, c + the test file
    expect(core.fanIn).toBe(3); // a, b, test
    expect(core.testedBy).toBe(1);
    expect(core.todos).toBe(3);
    expect(core.hotspot).toBe(100); // highest churn x complexity in repo
    const dead = insights.files.find((f) => f.path === 'src/dead.ts')!;
    expect(dead.orphan).toBe(true);
  });

  it('raises a regression-risk critical for changed, load-bearing, uncovered files', () => {
    const insights = computeInsights(
      buildInput({
        changedAt: { 'src/core.ts': Date.now() },
        changedBy: { 'src/core.ts': 'claude' },
        coverage: { 'src/core.ts': { found: 100, hit: 10, pct: 10 } },
      }),
    );
    const issue = insights.issues.find((i) => i.rule === 'regression-risk');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('critical');
    expect(issue!.paths).toEqual(['src/core.ts']);
    expect(issue!.detail).toContain('claude');
    expect(insights.summary.criticals).toBeGreaterThan(0);
    // and it tops the feed
    expect(insights.issues[0].severity).toBe('critical');
  });

  it('flags cycles, orphans and todo debt', () => {
    const insights = computeInsights(buildInput());
    expect(insights.issues.some((i) => i.rule === 'import-cycle')).toBe(true);
    expect(insights.issues.some((i) => i.rule === 'orphan' && i.paths[0] === 'src/dead.ts')).toBe(true);
    expect(insights.issues.some((i) => i.rule === 'todo-debt' && i.paths[0] === 'src/core.ts')).toBe(true);
    expect(insights.summary.cycles).toBe(1);
    expect(insights.summary.orphans).toBe(2); // dead.ts + the leaf c.ts
  });

  it('detects agent thrash and change coupling from session snapshots', () => {
    const snap = (files: string[], i: number): ShadowSnapshot => ({
      hash: `h${i}`,
      time: i,
      message: `m${i}`,
      files,
    });
    const insights = computeInsights(
      buildInput({
        snapshots: [
          snap(['src/core.ts', 'src/a.ts'], 1),
          snap(['src/core.ts', 'src/a.ts'], 2),
          snap(['src/core.ts', 'src/a.ts'], 3),
          snap(['src/core.ts'], 4),
        ],
        changedBy: { 'src/core.ts': 'codex' },
      }),
    );
    const thrash = insights.issues.find((i) => i.rule === 'agent-thrash');
    expect(thrash).toBeDefined();
    expect(thrash!.title).toContain('4×');
    const coupling = insights.issues.find((i) => i.rule === 'change-coupling');
    expect(coupling).toBeDefined();
    expect(coupling!.paths).toContain('src/a.ts');
    const core = insights.files.find((f) => f.path === 'src/core.ts')!;
    expect(core.churnSession).toBe(4);
    expect(core.coupling?.partner).toBe('src/a.ts');
  });

  it('summarizes coverage loc-weighted', () => {
    const insights = computeInsights(
      buildInput({
        coverage: {
          'src/core.ts': { found: 10, hit: 10, pct: 100 },
          'src/a.ts': { found: 10, hit: 0, pct: 0 },
        },
      }),
    );
    expect(insights.summary.avgCoverage).not.toBeNull();
    expect(insights.summary.avgCoverage!).toBeGreaterThan(50); // core is bigger
  });
});

describe('one scale for every metric', () => {
  const insights = computeInsights(buildInput());
  const core = insights.files.find((f) => f.path === 'src/core.ts')!;
  const dead = insights.files.find((f) => f.path === 'src/dead.ts')!;

  it('puts every raw metric on 0..100', () => {
    // A table mixing 2,063 lines, complexity 293 and 1 importer cannot be read
    // across a row: each column needs its own yardstick. One scale answers
    // "is this file unusual?" directly.
    for (const f of insights.files) {
      for (const [key, value] of Object.entries(f.scores)) {
        expect(value, `${f.path}.${key}`).toBeGreaterThanOrEqual(0);
        expect(value, `${f.path}.${key}`).toBeLessThanOrEqual(100);
        expect(Number.isInteger(value), `${f.path}.${key} is whole`).toBe(true);
      }
    }
  });

  it('gives the repo maximum a score of 100', () => {
    for (const key of ['complexity', 'loc', 'churn', 'fanIn', 'blastRadius', 'todos'] as const) {
      const top = Math.max(...insights.files.map((f) => f.scores[key]));
      expect(top, `some file tops out on ${key}`).toBe(100);
    }
  });

  it('preserves the ordering of the raw values it came from', () => {
    // the score is presentation; sorting by it must not reorder anything
    const byRaw = [...insights.files].sort((a, b) => a.complexity - b.complexity).map((f) => f.path);
    const byScore = [...insights.files]
      .sort((a, b) => a.scores.complexity - b.scores.complexity || byRaw.indexOf(a.path) - byRaw.indexOf(b.path))
      .map((f) => f.path);
    expect(byScore).toEqual(byRaw);
  });

  it('keeps the raw values alongside, since a count is a fact and a score is a comparison', () => {
    expect(core.complexity).toBeGreaterThan(0);
    expect(core.scores.complexity).toBe(100); // the branchiest file here
    expect(dead.complexity).toBe(0);
    expect(dead.scores.complexity).toBe(0);
  });

  it('leaves coverage off the shared scale because its meaning is absolute', () => {
    // 80% coverage is 80% whether or not the rest of the repo is worse;
    // normalising it would turn the best of a bad set into a perfect score
    expect(insights.files[0].scores).not.toHaveProperty('coveragePct');
    expect(insights.files[0].scores).not.toHaveProperty('coverage');
  });
});
