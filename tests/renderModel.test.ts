import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../shared/graph';
import { parseFile } from '../shared/parser';
import { buildSymbolGraph } from '../shared/symbols';
import {
  childFolders,
  deriveRenderModel,
  dirNodeId,
  drillCount,
  foldDir,
  representingDir,
  symbolNodeId,
  unfoldDir,
} from '../src/graph/renderModel';
import type { SymbolGraph } from '../shared/types';

function makeGraph() {
  const gb = new GraphBuilder();
  const graph = gb.setAll([
    parseFile('src/a.ts', `import { b } from './b';\nb();\nb();`),
    parseFile('src/b.ts', `export const b = () => 1;`),
    parseFile('lib/util.ts', `import { b } from '../src/b';\nb();`),
    parseFile('root.ts', `import './src/a';`),
  ]);
  return { gb, nodes: new Map(graph.nodes.map((n) => [n.id, n])), edges: graph.edges };
}

const noSymbols = new Map<string, SymbolGraph>();

describe('deriveRenderModel', () => {
  it('passes through when nothing is collapsed or expanded', () => {
    const { nodes, edges } = makeGraph();
    const out = deriveRenderModel(nodes, edges, { collapsedDirs: new Set(), expandedFiles: new Set() }, noSymbols);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['lib/util.ts', 'root.ts', 'src/a.ts', 'src/b.ts']);
    expect(out.edges).toHaveLength(3);
    expect(out.nodes.every((n) => n.kind === 'file')).toBe(true);
  });

  it('collapses a directory into an aggregate meta-node with rerouted edges', () => {
    const { nodes, edges } = makeGraph();
    const out = deriveRenderModel(
      nodes,
      edges,
      { collapsedDirs: new Set(['src']), expandedFiles: new Set() },
      noSymbols,
    );
    const ids = out.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([dirNodeId('src'), 'lib/util.ts', 'root.ts'].sort());
    const dir = out.nodes.find((n) => n.kind === 'dir')!;
    expect(dir.dir!.files).toBe(2);
    expect(dir.label).toBe('src (2)');
    // internal src edge dropped; external edges rerouted to the meta-node
    const edgePairs = out.edges.map((e) => `${e.source}->${e.target}`).sort();
    expect(edgePairs).toEqual([`lib/util.ts->${dirNodeId('src')}`, `root.ts->${dirNodeId('src')}`]);
  });

  it('expands a file into hub + symbol nodes, routing inbound edges to symbols', () => {
    const { nodes, edges } = makeGraph();
    const content = `export const b = () => 1;`;
    const sg = buildSymbolGraph(parseFile('src/b.ts', content), content, [
      { importer: 'src/a.ts', bindings: { b: 2 } },
      { importer: 'lib/util.ts', bindings: { b: 1 } },
    ]);
    const out = deriveRenderModel(
      nodes,
      edges,
      { collapsedDirs: new Set(), expandedFiles: new Set(['src/b.ts']) },
      new Map([['src/b.ts', sg]]),
    );
    const symId = symbolNodeId('src/b.ts', 'b');
    expect(out.nodes.find((n) => n.id === symId)?.kind).toBe('symbol');
    expect(out.nodes.find((n) => n.id === 'src/b.ts')?.kind).toBe('hub');
    const pairs = out.edges.map((e) => `${e.source}->${e.target}`);
    expect(pairs).toContain(`src/a.ts->${symId}`);
    expect(pairs).toContain(`lib/util.ts->${symId}`);
    expect(pairs).toContain(`src/b.ts->${symId}`); // hub anchor
    // no more direct file->file edge into the expanded file
    expect(pairs).not.toContain('src/a.ts->src/b.ts');
  });

  it('routes inbound to hub when importer has no known symbol bindings', () => {
    const { nodes, edges } = makeGraph();
    const content = `export const b = () => 1;`;
    const sg = buildSymbolGraph(parseFile('src/b.ts', content), content, []);
    const out = deriveRenderModel(
      nodes,
      edges,
      { collapsedDirs: new Set(), expandedFiles: new Set(['src/b.ts']) },
      new Map([['src/b.ts', sg]]),
    );
    const pairs = out.edges.map((e) => `${e.source}->${e.target}`);
    expect(pairs).toContain('src/a.ts->src/b.ts'); // falls back to hub
  });

  it('collapse wins over expansion inside the same dir and merges parallel edges', () => {
    const { nodes, edges } = makeGraph();
    const out = deriveRenderModel(
      nodes,
      edges,
      { collapsedDirs: new Set(['src']), expandedFiles: new Set(['src/b.ts']) },
      noSymbols,
    );
    expect(out.nodes.some((n) => n.kind === 'symbol')).toBe(false);
    // lib/util.ts imported b (weight 1); root imported a (weight 1) — both into @dir:src
    const intoDir = out.edges.filter((e) => e.target === dirNodeId('src'));
    expect(intoDir).toHaveLength(2);
  });

  it('folds sub-folders, and an outer fold swallows an inner one', () => {
    const gb = new GraphBuilder();
    const graph = gb.setAll([
      parseFile('src/app/page.ts', `import { b } from '../lib/b';\nb();`),
      parseFile('src/app/api.ts', `export const api = 1;`),
      parseFile('src/lib/b.ts', `export const b = () => 1;`),
      parseFile('root.ts', `import './src/app/page';`),
    ]);
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));

    const drilled = deriveRenderModel(
      nodes,
      graph.edges,
      { collapsedDirs: new Set(['src/app', 'src/lib']), expandedFiles: new Set() },
      noSymbols,
    );
    expect(drilled.nodes.map((n) => n.id).sort()).toEqual(
      [dirNodeId('src/app'), dirNodeId('src/lib'), 'root.ts'].sort(),
    );
    // the folder cards keep their parent's cluster, so they band and colour as src
    expect(drilled.nodes.filter((n) => n.kind === 'dir').every((n) => n.cluster === 'src')).toBe(true);
    expect(drilled.edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual(
      [`${dirNodeId('src/app')}->${dirNodeId('src/lib')}`, `root.ts->${dirNodeId('src/app')}`].sort(),
    );

    const outer = deriveRenderModel(
      nodes,
      graph.edges,
      { collapsedDirs: new Set(['src/app', 'src', 'src/lib']), expandedFiles: new Set() },
      noSymbols,
    );
    expect(outer.nodes.map((n) => n.id).sort()).toEqual([dirNodeId('src'), 'root.ts'].sort());
    expect(outer.nodes.find((n) => n.kind === 'dir')!.dir!.files).toBe(3);
  });
});

describe('drill-down folding', () => {
  // 70 files under src/app, 30 under src/lib, 1 loose in src/
  const paths = [
    ...Array.from({ length: 70 }, (_, i) => `src/app/f${i}.ts`),
    ...Array.from({ length: 30 }, (_, i) => `src/lib/g${i}.ts`),
    'src/index.ts',
    'root.ts',
  ];

  it('opens an oversized folder into its sub-folders, not its files', () => {
    const next = unfoldDir(new Set(['src']), 'src', paths);
    expect([...next].sort()).toEqual(['src/app', 'src/lib']);
    expect(drillCount(new Set(['src']), 'src', paths)).toBe(2);
  });

  it('opens a folder that fits straight into files', () => {
    const next = unfoldDir(new Set(['src/lib']), 'src/lib', paths);
    expect([...next]).toEqual([]);
    expect(drillCount(new Set(['src/lib']), 'src/lib', paths)).toBe(0);
  });

  it('skips a level that holds the whole folder on its own', () => {
    const nested = Array.from({ length: 80 }, (_, i) => `src/app/api/r${i}.ts`);
    // src -> app -> api are the same set of files; only api's children are a choice
    expect([...unfoldDir(new Set(['src']), 'src', nested)]).toEqual([]);
    const withSiblings = [...nested, ...Array.from({ length: 5 }, (_, i) => `src/app/ui/u${i}.ts`)];
    expect([...unfoldDir(new Set(['src']), 'src', withSiblings)].sort()).toEqual([
      'src/app/api',
      'src/app/ui',
    ]);
  });

  it('restores where you had drilled to instead of starting over', () => {
    const drilled = unfoldDir(new Set(['src']), 'src', paths); // {src/app, src/lib}
    const deeper = new Set([...drilled].filter((d) => d !== 'src/lib')); // src/lib opened
    const refolded = foldDir(deeper, 'src');
    expect(refolded.has('src')).toBe(true);
    expect([...unfoldDir(refolded, 'src', paths)].sort()).toEqual(['src/app']);
  });

  it('leaves files with no folded ancestor alone', () => {
    expect(representingDir('root.ts', new Set(['src']))).toBeNull();
    expect(representingDir('src/app/f1.ts', new Set(['src/app']))).toBe('src/app');
    expect(representingDir('src/app/f1.ts', new Set(['src/app', 'src']))).toBe('src');
    expect(childFolders(paths, 'src')).toEqual(new Map([['app', 70], ['lib', 30]]));
  });
});
