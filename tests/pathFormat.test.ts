import { describe, expect, it } from 'vitest';
import { formatPathsFlat, formatPathsTree } from '../shared/pathFormat';

describe('formatPathsTree', () => {
  it('returns a single path unchanged', () => {
    expect(formatPathsTree(['src/app.ts'])).toBe('src/app.ts');
  });

  it('groups by folder, sorted and indented', () => {
    const out = formatPathsTree([
      'src/components/GraphView.tsx',
      'shared/parser.ts',
      'src/components/FileTree.tsx',
      'shared/types.ts',
      'README.md',
    ]);
    expect(out).toBe(
      [
        './',
        '  README.md',
        'shared/',
        '  parser.ts',
        '  types.ts',
        'src/components/',
        '  FileTree.tsx',
        '  GraphView.tsx',
      ].join('\n'),
    );
  });

  it('dedupes', () => {
    expect(formatPathsTree(['a/b.ts', 'a/b.ts'])).toBe('a/b.ts');
  });
});

describe('formatPathsFlat', () => {
  it('space-separates and quotes paths with spaces', () => {
    expect(formatPathsFlat(['my dir/a.ts', 'b.ts'])).toBe('b.ts "my dir/a.ts"');
  });
});
