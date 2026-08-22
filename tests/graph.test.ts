import { describe, expect, it } from 'vitest';
import { GraphBuilder, findCycles, isTestPath, withBlastRadius } from '../shared/graph';
import { parseFile } from '../shared/parser';

function p(path: string, content: string) {
  return parseFile(path, content);
}

const pairs = (edges: { source: string; target: string }[]) =>
  edges.map((e) => `${e.source}->${e.target}`).sort();

describe('GraphBuilder', () => {
  it('builds nodes and resolved edges', () => {
    const gb = new GraphBuilder();
    const graph = gb.setAll([
      p('src/a.ts', `import { b } from './b'; import react from 'react'; export const a = 1;`),
      p('src/b.ts', `export const b = 2;`),
      p('src/c.ts', `import { a } from './a'; import { b } from './b';`),
    ]);
    expect(graph.nodes).toHaveLength(3);
    expect(pairs(graph.edges)).toEqual([
      'src/a.ts->src/b.ts',
      'src/c.ts->src/a.ts',
      'src/c.ts->src/b.ts',
    ]);
    const a = graph.nodes.find((n) => n.id === 'src/a.ts')!;
    expect(a.inDegree).toBe(1);
    expect(a.outDegree).toBe(1);
    expect(a.externalModules.length).toBe(1); // react
    expect(a.cluster).toBe('src');
  });

  it('weights edges by referenced-binding count', () => {
    const gb = new GraphBuilder();
    const graph = gb.setAll([
      p(
        'a.ts',
        `import { x, y } from './b';\nexport const r = x() + x() + y();\n`,
      ),
      p('b.ts', `export const x = () => 1;\nexport const y = () => 2;`),
      p('c.ts', `import './b';`),
    ]);
    const ab = graph.edges.find((e) => e.source === 'a.ts')!;
    expect(ab.weight).toBe(3); // x twice + y once
    const cb = graph.edges.find((e) => e.source === 'c.ts')!;
    expect(cb.weight).toBe(1); // side-effect import floor
  });

  it('produces patches for content changes including weight updates', () => {
    const gb = new GraphBuilder();
    gb.setAll([
      p('a.ts', `import { b } from './b';\nb();`),
      p('b.ts', `export const b = () => 1;`),
    ]);
    const patch = gb.apply([p('a.ts', `import { b } from './b';\nb();\nb();`)], []);
    expect(patch.addedEdges).toHaveLength(0);
    expect(patch.updatedEdges).toEqual([{ source: 'a.ts', target: 'b.ts', weight: 2 }]);
  });

  it('handles file removal including its edges', () => {
    const gb = new GraphBuilder();
    gb.setAll([p('a.ts', `import './b';`), p('b.ts', `export {};`)]);
    const patch = gb.apply([], ['b.ts']);
    expect(patch.removedNodeIds).toEqual(['b.ts']);
    expect(pairs(patch.removedEdges)).toEqual(['a.ts->b.ts']);
  });

  it('re-resolves imports when a previously missing file appears', () => {
    const gb = new GraphBuilder();
    gb.setAll([p('a.ts', `import './b';`)]);
    expect(gb.getGraph().edges).toHaveLength(0);
    const patch = gb.apply([p('b.ts', `export {};`)], []);
    expect(patch.addedNodes.map((n) => n.id)).toEqual(['b.ts']);
    expect(pairs(patch.addedEdges)).toEqual(['a.ts->b.ts']);
  });

  it('computes neighbors and blast radius transitively', () => {
    const gb = new GraphBuilder();
    gb.setAll([
      p('core.ts', `export const core = 1;`),
      p('mid.ts', `import { core } from './core';`),
      p('top.ts', `import './mid';`),
      p('unrelated.ts', `export {};`),
    ]);
    const n = gb.neighbors('core.ts');
    expect(n.dependents).toEqual(['mid.ts']);
    expect(gb.blastRadius('core.ts')).toBe(2); // mid + top
    expect(gb.blastRadius('top.ts')).toBe(0);
  });

  it('detects import cycles via SCC', () => {
    const gb = new GraphBuilder();
    const graph = gb.setAll([
      p('src/a.ts', `import './b'; export const a = 1;`),
      p('src/b.ts', `import './a'; export const b = 1;`),
      p('src/free.ts', `import './a';`),
    ]);
    const a = graph.nodes.find((n) => n.id === 'src/a.ts')!;
    const b = graph.nodes.find((n) => n.id === 'src/b.ts')!;
    const free = graph.nodes.find((n) => n.id === 'src/free.ts')!;
    expect(a.cycleId).not.toBeNull();
    expect(a.cycleId).toBe(b.cycleId);
    expect(free.cycleId).toBeNull();
  });

  it('computes test linkage and orphan flags', () => {
    const gb = new GraphBuilder();
    const graph = gb.setAll([
      p('src/util.ts', `export const u = 1;`),
      p('tests/util.test.ts', `import { u } from '../src/util';`),
      p('src/lonely.ts', `import { u } from './util'; export const l = u;`),
      p('src/main.ts', `import './util';`),
    ]);
    const util = graph.nodes.find((n) => n.id === 'src/util.ts')!;
    expect(util.testedBy).toBe(1);
    expect(util.orphan).toBe(false); // has dependents
    const test = graph.nodes.find((n) => n.id === 'tests/util.test.ts')!;
    expect(test.isTest).toBe(true);
    expect(test.orphan).toBe(false);
    const lonely = graph.nodes.find((n) => n.id === 'src/lonely.ts')!;
    expect(lonely.orphan).toBe(true); // nobody imports it, not an entry name
    const main = graph.nodes.find((n) => n.id === 'src/main.ts')!;
    expect(main.orphan).toBe(false); // entry-like basename
  });

  it('ignores self-imports and keeps a single weighted edge per pair', () => {
    const gb = new GraphBuilder();
    const graph = gb.setAll([
      p('a.ts', `import './a'; import { x } from './b'; import { y } from './b';\nx(); y();`),
      p('b.ts', `export const x = () => 1; export const y = () => 2;`),
    ]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ source: 'a.ts', target: 'b.ts' });
  });

  it('links python modules and does not count speculative misses as external', () => {
    const gb = new GraphBuilder();
    const graph = gb.setAll([
      p('app/__init__.py', ''),
      p('app/main.py', `from .models import User\nfrom app.services import auth`),
      p('app/models.py', `class User: pass`),
      p('app/services/__init__.py', ''),
      p('app/services/auth.py', `def login(): pass`),
    ]);
    const edgePairs = pairs(graph.edges);
    expect(edgePairs).toContain('app/main.py->app/models.py');
    expect(edgePairs).toContain('app/main.py->app/services/__init__.py');
    expect(edgePairs).toContain('app/main.py->app/services/auth.py');
    const main = graph.nodes.find((n) => n.id === 'app/main.py')!;
    // `.models.User` doesn't resolve (User is a class) but is speculative — not external
    expect(main.externalModules.length).toBe(0);
  });

  it('exposes importers with merged bindings', () => {
    const gb = new GraphBuilder();
    gb.setAll([
      p('a.ts', `import { x } from './b';\nx(); x();`),
      p('b.ts', `export const x = () => 1;`),
    ]);
    const importers = gb.importersOf('b.ts');
    expect(importers).toEqual([{ importer: 'a.ts', bindings: { x: 2 } }]);
  });
});

describe('smart clustering', () => {
  it('splits container top-dirs (monorepo) into second-level clusters', () => {
    const gb = new GraphBuilder();
    const graph = gb.setAll([
      p('apps/web/src/a.ts', 'export const a = 1;'),
      p('apps/web/src/b.ts', 'export const b = 1;'),
      p('apps/api/src/c.ts', 'export const c = 1;'),
      p('apps/api/src/d.ts', 'export const d = 1;'),
      p('apps/api/src/e.ts', 'export const e = 1;'),
      p('lib/util.ts', 'export const u = 1;'),
    ]);
    const clusters = new Map(graph.nodes.map((n) => [n.id, n.cluster]));
    expect(clusters.get('apps/web/src/a.ts')).toBe('apps/web');
    expect(clusters.get('apps/api/src/c.ts')).toBe('apps/api');
    expect(clusters.get('lib/util.ts')).toBe('lib');
  });

  it('keeps small or file-bearing top dirs whole', () => {
    const gb = new GraphBuilder();
    const graph = gb.setAll([
      p('tests/web/a.test.ts', 'export {};'),
      p('tests/api/b.test.ts', 'export {};'),
      p('src/index.ts', 'export {};'),
      p('src/sub/x.ts', 'export {};'),
      p('src/sub2/y.ts', 'export {};'),
      p('src/sub2/z.ts', 'export {};'),
      p('src/sub/w.ts', 'export {};'),
    ]);
    const clusters = new Map(graph.nodes.map((n) => [n.id, n.cluster]));
    // tests: only 2 files -> stays whole
    expect(clusters.get('tests/web/a.test.ts')).toBe('tests');
    // src has a direct file -> stays whole even with subdirs
    expect(clusters.get('src/sub/x.ts')).toBe('src');
  });
});

describe('findCycles', () => {
  it('finds multiple distinct components', () => {
    const adj = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
      ['c', ['d']],
      ['d', ['e']],
      ['e', ['c']],
      ['solo', ['a']],
    ]);
    const cycles = findCycles(adj);
    expect(cycles.get('a')).toBe(cycles.get('b'));
    expect(cycles.get('c')).toBe(cycles.get('d'));
    expect(cycles.get('c')).toBe(cycles.get('e'));
    expect(cycles.get('a')).not.toBe(cycles.get('c'));
    expect(cycles.has('solo')).toBe(false);
  });
});

describe('isTestPath', () => {
  it('classifies test files', () => {
    expect(isTestPath('tests/foo.test.ts')).toBe(true);
    expect(isTestPath('src/foo.spec.tsx')).toBe(true);
    expect(isTestPath('e2e/app.spec.ts')).toBe(true);
    expect(isTestPath('pkg/test_util.py')).toBe(true);
    expect(isTestPath('src/foo.ts')).toBe(false);
    expect(isTestPath('src/latest.ts')).toBe(false);
  });
});

describe('withBlastRadius', () => {
  // util <- helper <- app, and api imports util directly; leaf imports nothing
  const edges = [
    { source: 'src/helper.ts', target: 'src/util.ts', weight: 1 },
    { source: 'src/app.ts', target: 'src/helper.ts', weight: 1 },
    { source: 'src/api.ts', target: 'src/util.ts', weight: 1 },
    { source: 'src/leaf.ts', target: 'src/api.ts', weight: 1 },
  ];

  it('walks importers to any depth, and keeps the seeds', () => {
    expect(withBlastRadius(['src/util.ts'], edges)).toEqual([
      'src/api.ts',
      'src/app.ts',
      'src/helper.ts',
      'src/leaf.ts',
      'src/util.ts',
    ]);
  });

  it('does not walk downstream — what a file imports is not its blast radius', () => {
    expect(withBlastRadius(['src/app.ts'], edges)).toEqual(['src/app.ts']);
  });

  it('unions the radii of several seeds without repeating a file', () => {
    expect(withBlastRadius(['src/helper.ts', 'src/api.ts'], edges)).toEqual([
      'src/api.ts',
      'src/app.ts',
      'src/helper.ts',
      'src/leaf.ts',
    ]);
  });

  it('terminates on a cycle instead of walking it forever', () => {
    const cyclic = [
      { source: 'a.ts', target: 'b.ts', weight: 1 },
      { source: 'b.ts', target: 'a.ts', weight: 1 },
    ];
    expect(withBlastRadius(['a.ts'], cyclic)).toEqual(['a.ts', 'b.ts']);
  });

  it('passes through a path the graph has never heard of', () => {
    expect(withBlastRadius(['docs/'], edges)).toEqual(['docs/']);
  });
});
