import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../shared/graph';
import { parseFile } from '../shared/parser';
import { resolveImport } from '../shared/resolver';

const p = (path: string, content: string) => parseFile(path, content);
const pairs = (edges: { source: string; target: string }[]) =>
  edges.map((e) => `${e.source}->${e.target}`).sort();

describe('documents in the graph', () => {
  it('reads a document as prose with links for imports', () => {
    const doc = p(
      'README.md',
      [
        '# Fixture',
        '',
        'See [the app](src/app.ts) and [the helper](./src/lib/helper.ts).',
        '',
        '- also [the app again](src/app.ts)',
        '',
        'TODO: write the rest.',
      ].join('\n'),
    );
    expect(doc.lang).toBe('md');
    expect(doc.complexity).toBe(0);
    expect(doc.symbols).toEqual([]);
    expect(doc.todos).toBe(1);
    expect(doc.imports.map((i) => i.spec)).toEqual(['./src/lib/helper.ts', 'src/app.ts']);
    // twice-linked is a heavier reference, the same way a twice-used import is
    expect(doc.imports.find((i) => i.spec === 'src/app.ts')?.bindings).toEqual({ link: 2 });
  });

  it('does not mistake a path inside a code fence for a reference', () => {
    const doc = p(
      'notes.md',
      ['```sh', 'cat src/app.ts', '```', '', 'and `src/util.ts` in backticks'].join('\n'),
    );
    expect(doc.imports).toEqual([]);
  });

  it('ignores anchors, urls and mail links', () => {
    const doc = p(
      'notes.md',
      '[top](#heading) [home](https://example.com) [mail](mailto:a@b.c) [real](src/app.ts)',
    );
    expect(doc.imports.map((i) => i.spec)).toEqual(['src/app.ts']);
  });

  it('resolves a link as a path, not as a module specifier', () => {
    const index = new Set(['README.md', 'docs/plan.md', 'docs/README.md', 'src/app.ts', 'notes.ts']);
    expect(resolveImport('README.md', 'src/app.ts', index)).toBe('src/app.ts');
    expect(resolveImport('docs/plan.md', '../src/app.ts', index)).toBe('src/app.ts');
    // a link to a folder is that folder's README, the way every forge reads it
    expect(resolveImport('README.md', 'docs', index)).toBe('docs/README.md');
    // and a bare name is NOT guessed into a source file the author never wrote
    expect(resolveImport('README.md', 'notes', index)).toBeNull();
  });

  it('puts a document beside the code it describes', () => {
    const gb = new GraphBuilder();
    const graph = gb.setAll([
      p('README.md', 'See [the app](src/app.ts).'),
      p('src/app.ts', `import { helper } from './lib/helper';`),
      p('src/lib/helper.ts', 'export const helper = 1;'),
    ]);
    expect(pairs(graph.edges)).toEqual(['README.md->src/app.ts', 'src/app.ts->src/lib/helper.ts']);
    const app = graph.nodes.find((n) => n.id === 'src/app.ts')!;
    expect(app.inDegree).toBe(1);
    expect(app.doc).toBe(false);
  });

  it('never judges a document by the standards for code', () => {
    const gb = new GraphBuilder();
    const graph = gb.setAll([
      p('docs/plan.md', 'nothing links here, and nothing tests it'),
      p('src/lonely.ts', 'export const lonely = 1;'),
    ]);
    const doc = graph.nodes.find((n) => n.id === 'docs/plan.md')!;
    expect(doc.doc).toBe(true);
    expect(doc.isTest).toBe(false);
    // the point of the flag: an unlinked plan is a plan, not an orphaned module
    expect(doc.orphan).toBe(false);
    expect(graph.nodes.find((n) => n.id === 'src/lonely.ts')!.orphan).toBe(true);
  });

  it('does not report a broken link as an external package', () => {
    const gb = new GraphBuilder();
    const graph = gb.setAll([p('README.md', 'See [the gone](src/gone.ts).')]);
    expect(graph.nodes[0].externalModules).toEqual([]);
  });
});
