import { describe, expect, it } from 'vitest';
import { flowLayout, hierarchicalFlowLayout } from '../src/graph/flowLayout';

describe('flowLayout', () => {
  it('places dependencies left of dependents', () => {
    const pos = flowLayout(
      [
        { id: 'util.ts', cluster: 'src' },
        { id: 'mid.ts', cluster: 'src' },
        { id: 'app.ts', cluster: 'src' },
      ],
      [
        { source: 'app.ts', target: 'mid.ts' },
        { source: 'mid.ts', target: 'util.ts' },
      ],
    );
    expect(pos['util.ts'].x).toBeLessThan(pos['mid.ts'].x);
    expect(pos['mid.ts'].x).toBeLessThan(pos['app.ts'].x);
  });

  it('uses longest path, not shortest', () => {
    // app -> mid -> util, app -> util directly: app must still be right of mid
    const pos = flowLayout(
      [
        { id: 'util', cluster: '' },
        { id: 'mid', cluster: '' },
        { id: 'app', cluster: '' },
      ],
      [
        { source: 'app', target: 'mid' },
        { source: 'mid', target: 'util' },
        { source: 'app', target: 'util' },
      ],
    );
    expect(pos['app'].x).toBeGreaterThan(pos['mid'].x);
  });

  it('collapses cycles into one column and stacks members', () => {
    const pos = flowLayout(
      [
        { id: 'a', cluster: '' },
        { id: 'b', cluster: '' },
        { id: 'entry', cluster: '' },
      ],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
        { source: 'entry', target: 'a' },
      ],
    );
    expect(pos['a'].x).toBe(pos['b'].x);
    expect(pos['a'].y).not.toBe(pos['b'].y);
    expect(pos['entry'].x).toBeGreaterThan(pos['a'].x);
  });

  it('is deterministic and covers isolated nodes', () => {
    const nodes = [
      { id: 'x', cluster: 'a' },
      { id: 'y', cluster: 'b' },
      { id: 'z', cluster: 'a' },
    ];
    const a = flowLayout(nodes, []);
    const b = flowLayout(nodes, []);
    expect(a).toEqual(b);
    expect(Object.keys(a)).toHaveLength(3);
    // isolated nodes share the leftmost column, distinct rows
    expect(new Set([a['x'].y, a['y'].y, a['z'].y]).size).toBe(3);
  });
});

describe('hierarchicalFlowLayout', () => {
  const nodes = [
    { id: 'lib/a.ts', cluster: 'lib' },
    { id: 'lib/b.ts', cluster: 'lib' },
    { id: 'app/x.ts', cluster: 'app' },
    { id: 'app/y.ts', cluster: 'app' },
    { id: '@dir:tests', cluster: 'tests' },
  ];
  const edges = [
    { source: 'lib/b.ts', target: 'lib/a.ts' }, // internal to lib
    { source: 'app/x.ts', target: 'lib/a.ts' }, // app depends on lib
    { source: 'app/y.ts', target: 'app/x.ts' }, // internal to app
    { source: '@dir:tests', target: 'app/x.ts' }, // tests depend on app
  ];

  it('orders cluster blocks by dependency and keeps members local', () => {
    const pos = hierarchicalFlowLayout(nodes, edges);
    expect(Object.keys(pos)).toHaveLength(5);
    const libX = (pos['lib/a.ts'].x + pos['lib/b.ts'].x) / 2;
    const appX = (pos['app/x.ts'].x + pos['app/y.ts'].x) / 2;
    // lib (foundation) left of app, app left of tests
    expect(libX).toBeLessThan(appX);
    expect(appX).toBeLessThan(pos['@dir:tests'].x);
    // members stay near their cluster's block, not scattered across others
    const libSpread = Math.abs(pos['lib/a.ts'].x - pos['lib/b.ts'].x);
    expect(libSpread).toBeLessThan(appX - libX);
    // internal ordering holds inside a block too
    expect(pos['lib/a.ts'].x).toBeLessThan(pos['lib/b.ts'].x);
  });

  it('is deterministic', () => {
    expect(hierarchicalFlowLayout(nodes, edges)).toEqual(hierarchicalFlowLayout(nodes, edges));
  });
});
