import { describe, expect, it } from 'vitest';
import {
  aggregateLens,
  buildLensContext,
  lensColor,
  lensSignal,
  lensValue,
  percentileScale,
  type LensContext,
} from '../src/graph/lensColor';
import { STATUS } from '../src/theme';
import type { GraphNode } from '../shared/types';

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    lang: 'ts',
    loc: 40,
    complexity: 5,
    symbols: [],
    cluster: 'src',
    inDegree: 1,
    outDegree: 1,
    externalModules: [],
    testedBy: 1,
    isTest: false,
    orphan: false,
    cycleId: null,
    todos: 0,
    ...over,
  };
}

function ctx(over: Partial<LensContext> = {}): LensContext {
  return {
    lens: 'unread',
    churn: {},
    coverage: {},
    changedAt: {},
    readAt: {},
  reuse: {},
    clusterColor: () => '#3987e5',
    recency: [],
    rank: () => 0,
    ...over,
  };
}

describe('the unread lens', () => {
  it('paints a changed-but-unopened file as the critical colour', () => {
    const c = ctx({ changedAt: { 'src/a.ts': 1000 }, readAt: {} });
    expect(lensColor(node('src/a.ts'), c)).toBe(STATUS.critical);
    expect(lensValue(node('src/a.ts'), c, 10)).toBe(1);
  });

  it('clears once a human opens it after the change', () => {
    const c = ctx({ changedAt: { 'src/a.ts': 1000 }, readAt: { 'src/a.ts': 2000 } });
    expect(lensColor(node('src/a.ts'), c)).toBe(STATUS.good);
  });

  it('goes red again when the file changes after it was read', () => {
    const c = ctx({ changedAt: { 'src/a.ts': 3000 }, readAt: { 'src/a.ts': 2000 } });
    expect(lensColor(node('src/a.ts'), c)).toBe(STATUS.critical);
  });

  it('leaves files that did not change this session neutral, not green', () => {
    // claiming "read" for code nobody has looked at would be the same lie the
    // lens exists to expose
    const c = ctx({ changedAt: {}, readAt: {} });
    const colour = lensColor(node('src/untouched.ts'), c);
    expect(colour).not.toBe(STATUS.good);
    expect(colour).not.toBe(STATUS.critical);
    expect(lensValue(node('src/untouched.ts'), c, 10)).toBeLessThan(0.2);
  });
});

describe('percentileScale', () => {
  it('spreads a power-law distribution across the whole range', () => {
    // a couple of monsters and a long tail — the shape every code metric has
    const values = [1, 1, 2, 2, 3, 4, 5, 7, 9, 40, 251];
    const rank = percentileScale(values);
    expect(rank(1)).toBeLessThan(0.1);
    expect(rank(4)).toBeGreaterThan(0.2);
    expect(rank(4)).toBeLessThan(0.6);
    expect(rank(251)).toBe(1);
  });

  it('invents no contrast when there is none', () => {
    expect(percentileScale([5, 5, 5, 5])(5)).toBe(0);
    expect(percentileScale([])(1)).toBe(0);
  });
});

describe('ranked lenses', () => {
  const many = (complexities: number[]) =>
    complexities.map((c, i) => node('src/f' + i + '.ts', { complexity: c }));

  it('puts the median file near the middle of the ramp, not the floor', () => {
    // the bug: dividing by the max left 83% of this repo below a fifth of the
    // ramp, so "bright" and "not bright" looked identical
    const nodes = many([1, 1, 2, 2, 3, 4, 5, 7, 9, 40, 251]);
    const c = buildLensContext(nodes, { lens: 'hotspot', churn: {}, coverage: {}, changedAt: {}, readAt: {},
  reuse: {}, clusterColor: () => '#000000' });
    const values = nodes.map((n) => lensValue(n, c, 251));
    const median = values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
    expect(median).toBeGreaterThan(0.2);
    expect(Math.max(...values)).toBe(1);
    // and the colours differ, not just the numbers
    const dim = lensColor(nodes[0], c);
    const bright = lensColor(nodes[nodes.length - 1], c);
    expect(dim).not.toBe(bright);
    expect(luminance(bright) - luminance(dim)).toBeGreaterThan(60);
  });

  it('leaves absolute metrics absolute', () => {
    // 80% coverage must look like 80% coverage regardless of the neighbours
    const nodes = [node('src/a.ts'), node('src/b.ts')];
    const c = buildLensContext(nodes, {
      lens: 'coverage',
      churn: {},
      coverage: { 'src/a.ts': { pct: 80, hit: 8, found: 10 }, 'src/b.ts': { pct: 82, hit: 82, found: 100 } },
      changedAt: {},
      readAt: {},
  reuse: {},
      clusterColor: () => '#000000',
    });
    expect(lensColor(nodes[0], c)).toBe(lensColor(nodes[0], c));
    expect(c.rank(999)).toBe(0);
  });
});

/** rough perceived brightness of a #rrggbb colour */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}

describe('activity ranks by recency, not by clock', () => {
  const nodes = ['a.ts', 'b.ts', 'c.ts'].map((id) => node(id));
  const ctxFor = (changedAt: Record<string, number>) =>
    buildLensContext(nodes, {
      lens: 'activity',
      churn: {},
      coverage: {},
      changedAt,
      readAt: {},
  reuse: {},
      clusterColor: () => '#000000',
    });

  it('always shows the last change, however long ago it was', () => {
    // an hour after the agent stopped, "what did it touch" is still answerable
    const c = ctxFor({ 'a.ts': 1000, 'b.ts': 2000 });
    expect(lensValue(node('b.ts'), c, 10)).toBe(1);
    expect(lensValue(node('a.ts'), c, 10)).toBeGreaterThan(0.3);
    expect(lensValue(node('c.ts'), c, 10)).toBe(0);
  });

  it('gives the same answer on every render', () => {
    // the old decay read the clock per render, so the graph flickered mid-edit
    const c = ctxFor({ 'a.ts': 1000 });
    expect(lensColor(node('a.ts'), c)).toBe(lensColor(node('a.ts'), c));
  });
});

describe('folder aggregates', () => {
  it('averages a ratio lens so folders are not all identical', () => {
    // nearly every folder holds one pure leaf; taking the worst member made
    // every folder look maximally unstable
    const members = [
      node('a.ts', { inDegree: 5, outDegree: 0 }),
      node('b.ts', { inDegree: 0, outDegree: 5 }),
    ];
    const c = buildLensContext(members, {
      lens: 'instability',
      churn: {},
      coverage: {},
      changedAt: {},
      readAt: {},
  reuse: {},
      clusterColor: () => '#000000',
    });
    expect(aggregateLens(members, c, 10).value).toBeCloseTo(0.5, 2);
  });

  it('lights a folded folder from the file inside it that was just touched', () => {
    // The question a folded folder is asked under Activity is "did anything in
    // here just change?", and that is not a question about the average: one
    // touched file among twenty averaged to a twentieth of its brightness —
    // the surface colour — so a folder sat looking untouched while an agent
    // was writing into it.
    const members = Array.from({ length: 20 }, (_, i) => node(`shared/f${i}.ts`));
    const c = buildLensContext(members, {
      lens: 'activity',
      churn: {},
      coverage: {},
      changedAt: { 'shared/f7.ts': Date.now() },
      readAt: {},
  reuse: {},
      clusterColor: () => '#000000',
    });
    // the only touched file is the newest change, so the folder is at full tilt
    expect(aggregateLens(members, c, 10).value).toBe(1);
    expect(aggregateLens(members, c, 10).color).not.toBe(aggregateLens([], c, 10).color);
  });

  it('keeps the loudest member for risk, so a folder holding the scariest file looks scary', () => {
    const members = [
      node('calm.ts', { inDegree: 0, complexity: 1, testedBy: 1 }),
      node('scary.ts', { inDegree: 30, complexity: 300, testedBy: 0 }),
    ];
    const c = buildLensContext(members, {
      lens: 'risk',
      churn: {},
      coverage: {},
      changedAt: {},
      readAt: {},
  reuse: {},
      clusterColor: () => '#000000',
    });
    const folder = aggregateLens(members, c, 300).value;
    const worst = lensValue(members[1], c, 300);
    expect(folder).toBeCloseTo(worst, 5);
  });

  it('keeps worst-member for categorical lenses so a bad file still flags its folder', () => {
    const members = [node('a.ts', { cycleId: null }), node('b.ts', { cycleId: 0 })];
    const c = buildLensContext(members, {
      lens: 'cycles',
      churn: {},
      coverage: {},
      changedAt: {},
      readAt: {},
  reuse: {},
      clusterColor: () => '#000000',
    });
    expect(aggregateLens(members, c, 10).value).toBe(1);
  });
});

describe('lensSignal', () => {
  const ctxFor = (lens: LensContext['lens'], nodes: GraphNode[], changedAt = {}) =>
    buildLensContext(nodes, {
      lens,
      churn: {},
      coverage: {},
      changedAt,
      readAt: {},
  reuse: {},
      clusterColor: () => '#000000',
    });

  it('explains a cycle-free repo instead of leaving it grey', () => {
    const nodes = [node('a.ts'), node('b.ts')];
    expect(lensSignal(nodes, ctxFor('cycles', nodes))).toContain('No import cycles');
  });

  it('stays silent when there is something to see', () => {
    const nodes = [node('a.ts', { cycleId: 0 }), node('b.ts')];
    expect(lensSignal(nodes, ctxFor('cycles', nodes))).toBeNull();
  });

  it('explains an untouched session for activity and unread', () => {
    const nodes = [node('a.ts')];
    expect(lensSignal(nodes, ctxFor('activity', nodes))).toContain('Nothing has changed');
    expect(lensSignal(nodes, ctxFor('unread', nodes))).toContain('nothing is unread');
  });

  it('explains missing coverage data', () => {
    const nodes = [node('a.ts')];
    expect(lensSignal(nodes, ctxFor('coverage', nodes))).toContain('lcov.info');
  });
});
