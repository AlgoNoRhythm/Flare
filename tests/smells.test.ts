import { describe, expect, it } from 'vitest';
import { detectSmells, type FileChange, type SmellInput } from '../shared/smells';
import type { GraphNode, ParsedFile } from '../shared/types';

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    lang: 'ts',
    loc: 40,
    complexity: 5,
    symbols: [],
    cluster: id.includes('/') ? id.split('/')[0] : '',
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

function parsed(path: string, over: Partial<ParsedFile> = {}): ParsedFile {
  return { path, lang: 'ts', imports: [], symbols: [], loc: 40, complexity: 5, todos: 0, ...over };
}

function change(path: string, beforeText: string | null, afterText: string | null, over: Partial<FileChange> = {}): FileChange {
  return {
    path,
    beforeText,
    afterText,
    beforeParsed: beforeText === null ? null : parsed(path),
    afterParsed: afterText === null ? null : parsed(path),
    removed: false,
    added: beforeText === null,
    ...over,
  };
}

function run(files: FileChange[], over: Partial<SmellInput> = {}) {
  const nodes = new Map<string, GraphNode>(files.map((f) => [f.path, node(f.path)]));
  const input: SmellInput = {
    files,
    nodes,
    importersOf: () => [],
    degreeDelta: [],
    ...over,
  };
  return detectSmells(input);
}

const rules = (files: FileChange[], over?: Partial<SmellInput>) => run(files, over).map((s) => s.rule);

describe('detectSmells', () => {
  it('flags a test that moved in lockstep with its source, by name', () => {
    const found = rules([
      change('src/auth.ts', 'export const a = 1;', 'export const a = 2;'),
      change('src/auth.test.ts', 'expect(a).toBe(1);', 'expect(a).toBe(2);'),
    ]);
    expect(found).toContain('test-follows-source');
  });

  it('flags lockstep by import edge even when names differ', () => {
    const found = rules(
      [
        change('src/auth.ts', 'x', 'y'),
        change('tests/login.spec.ts', 'expect(1).toBe(1)', 'expect(1).toBe(2)'),
      ],
      { importersOf: (p) => (p === 'src/auth.ts' ? ['tests/login.spec.ts'] : []) },
    );
    expect(found).toContain('test-follows-source');
  });

  it('does not flag lockstep when only the source changed', () => {
    expect(rules([change('src/auth.ts', 'x', 'y')])).not.toContain('test-follows-source');
  });

  it('catches a skipped or narrowed test as critical', () => {
    const found = run([
      change('src/a.test.ts', 'it("works", () => {})', 'it.skip("works", () => {})'),
    ]);
    const smell = found.find((s) => s.rule === 'test-disabled');
    expect(smell?.severity).toBe('critical');
    expect(smell?.paths).toEqual(['src/a.test.ts']);
    expect(rules([change('src/b.test.ts', 'describe("x", () => {})', 'describe.only("x", () => {})')])).toContain(
      'test-disabled',
    );
    expect(rules([change('t/c_test.py', 'def test_a(): pass', '@pytest.mark.skip\ndef test_a(): pass')])).toContain(
      'test-disabled',
    );
  });

  it('catches deleted assertions', () => {
    const found = rules([
      change('src/a.test.ts', 'expect(x).toBe(1);\nexpect(y).toBe(2);', 'expect(x).toBe(1);'),
    ]);
    expect(found).toContain('assertions-removed');
  });

  it('ignores assertion counts in non-test files', () => {
    expect(rules([change('src/a.ts', 'expect(x).toBe(1);', '')])).not.toContain('assertions-removed');
  });

  it('catches suppressions and widened types', () => {
    const found = rules([
      change('src/a.ts', 'const x: string = f();', '// @ts-ignore\nconst x: any = f();'),
    ]);
    expect(found).toContain('suppression-added');
    expect(found).toContain('types-loosened');
  });

  it('catches a lowered coverage threshold and says what moved', () => {
    const found = run([
      change('vitest.config.ts', 'thresholds: { lines: 80, branches: 70 }', 'thresholds: { lines: 40, branches: 70 }'),
    ]);
    const smell = found.find((s) => s.rule === 'threshold-lowered');
    expect(smell?.severity).toBe('critical');
    expect(smell?.detail).toContain('lines 80 → 40');
  });

  it('does not flag a raised threshold', () => {
    expect(rules([change('vitest.config.ts', 'lines: 40', 'lines: 80')])).not.toContain('threshold-lowered');
  });

  it('flags a sharp complexity jump only when it is both large and proportional', () => {
    const big = change('src/a.ts', 'x', 'y');
    big.beforeParsed = parsed('src/a.ts', { complexity: 10 });
    big.afterParsed = parsed('src/a.ts', { complexity: 60 });
    expect(rules([big])).toContain('complexity-spike');

    const small = change('src/b.ts', 'x', 'y');
    small.beforeParsed = parsed('src/b.ts', { complexity: 200 });
    small.afterParsed = parsed('src/b.ts', { complexity: 230 });
    expect(rules([small])).not.toContain('complexity-spike');
  });

  it('flags a file that lost its last importer', () => {
    const found = run([change('src/new.ts', null, 'export const a = 1;')], {
      degreeDelta: [
        { path: 'src/old.ts', before: 2, after: 0 },
        { path: 'src/still-used.ts', before: 3, after: 1 },
      ],
    });
    const smell = found.find((s) => s.rule === 'left-behind');
    expect(smell?.paths).toEqual(['src/old.ts']);
  });

  it('flags a new module extracted for a single caller', () => {
    const added = change('src/helper.ts', null, 'export function h() {}');
    added.afterParsed = parsed('src/helper.ts', {
      symbols: [{ name: 'h', line: 1, kind: 'function', exported: true }],
    });
    const found = rules([added], { importersOf: () => ['src/app.ts'] });
    expect(found).toContain('single-caller-abstraction');
  });

  it('flags source changes with no test coverage and no test touched', () => {
    const files = [change('src/a.ts', 'x', 'y'), change('src/b.ts', 'x', 'y'), change('src/c.ts', 'x', 'y')];
    const nodes = new Map(files.map((f) => [f.path, node(f.path, { testedBy: 0 })]));
    const found = detectSmells({ files, nodes, importersOf: () => [], degreeDelta: [] });
    const smell = found.find((s) => s.rule === 'unverified-change');
    expect(smell?.severity).toBe('warning');
    expect(smell?.paths).toHaveLength(3);
  });

  it('stays quiet when the changed files are covered', () => {
    expect(rules([change('src/a.ts', 'x', 'y')])).not.toContain('unverified-change');
  });

  it('flags an oversized burst', () => {
    const files = Array.from({ length: 12 }, (_, i) => change(`src/f${i}.ts`, 'x', 'y'));
    expect(rules(files)).toContain('oversized-burst');
  });

  it('returns nothing for an ordinary, covered, single-file change', () => {
    expect(run([change('src/a.ts', 'const a = 1;', 'const a = 2;')])).toEqual([]);
  });
});
