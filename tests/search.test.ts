import { describe, expect, it } from 'vitest';
import { compileQuery, groupHits, isSearchableFile, replaceText, searchText } from '../shared/search';

describe('compileQuery', () => {
  it('escapes literal text', () => {
    const re = compileQuery('a.b(c)')!;
    expect(re.test('a.b(c)')).toBe(true);
    re.lastIndex = 0;
    expect(re.test('axb(c)')).toBe(false);
  });

  it('is case-insensitive unless asked', () => {
    expect(compileQuery('Util')!.test('util')).toBe(true);
    expect(compileQuery('Util', { caseSensitive: true })!.test('util')).toBe(false);
  });

  it('honours whole-word', () => {
    expect(compileQuery('util', { wholeWord: true })!.test('utility')).toBe(false);
    expect(compileQuery('util', { wholeWord: true })!.test('a util b')).toBe(true);
  });

  it('turns a broken regex into null rather than an exception', () => {
    expect(compileQuery('[', { regex: true })).toBeNull();
    expect(compileQuery('')).toBeNull();
  });
});

describe('searchText', () => {
  it('reports every match with its line, column and a preview', () => {
    const text = 'import { util } from "./util";\nexport const x = util();\n';
    const hits = searchText('src/app.ts', text, compileQuery('util')!);
    expect(hits.map((h) => [h.line, h.col])).toEqual([
      [1, 9],
      [1, 24],
      [2, 17],
    ]);
    expect(hits[0].preview).toContain('import { util }');
    expect(hits[0].preview.slice(hits[0].previewCol, hits[0].previewCol + hits[0].length)).toBe('util');
  });

  it('clips a long line around the match and says so', () => {
    const line = `${'a'.repeat(100)}needle${'b'.repeat(200)}`;
    const [hit] = searchText('f', line, compileQuery('needle')!);
    expect(hit.preview.startsWith('…')).toBe(true);
    expect(hit.preview.endsWith('…')).toBe(true);
    expect(hit.preview.slice(hit.previewCol, hit.previewCol + 6)).toBe('needle');
  });

  it('does not loop on a pattern that can match nothing', () => {
    const hits = searchText('f', 'abc', compileQuery('x*', { regex: true })!);
    expect(hits).toEqual([]);
  });
});

describe('replaceText', () => {
  it('replaces every match and counts them', () => {
    const { text, count } = replaceText('a util, a util', compileQuery('util')!, 'helper');
    expect(text).toBe('a helper, a helper');
    expect(count).toBe(2);
  });

  it('passes regex groups through to the replacement', () => {
    const { text } = replaceText('get_name get_age', compileQuery('get_(\\w+)', { regex: true })!, 'read_$1');
    expect(text).toBe('read_name read_age');
  });
});

describe('groupHits', () => {
  it('keeps files in search order and hits in line order', () => {
    const hits = [
      ...searchText('b.ts', 'x\nx', compileQuery('x')!),
      ...searchText('a.ts', 'x', compileQuery('x')!),
    ];
    expect(groupHits(hits).map((g) => [g.path, g.hits.length])).toEqual([
      ['b.ts', 2],
      ['a.ts', 1],
    ]);
  });
});

describe('isSearchableFile', () => {
  it('skips the obvious binaries and keeps everything else', () => {
    expect(isSearchableFile('docs/dot.png')).toBe(false);
    expect(isSearchableFile('package-lock.json')).toBe(true);
    expect(isSearchableFile('yarn.lock')).toBe(false);
    expect(isSearchableFile('Makefile')).toBe(true);
    expect(isSearchableFile('src/app.ts')).toBe(true);
  });
});
