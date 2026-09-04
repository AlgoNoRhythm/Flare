import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanProject, parseFileFromDisk } from '../shared/scanner';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-scan-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('scanProject', () => {
  it('walks files, builds tree, parses code files', () => {
    write('src/a.ts', `import './b';`);
    write('src/b.ts', 'export {};');
    write('README.md', '# hi');
    const result = scanProject(tmp);
    expect(result.allFiles.sort()).toEqual(['README.md', 'src/a.ts', 'src/b.ts']);
    expect(result.parsed.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    const rootChildren = result.fileTree.children!.map((c) => c.name);
    expect(rootChildren).toEqual(['src', 'README.md']); // dirs first
  });

  it('respects default ignores and .gitignore', () => {
    write('node_modules/pkg/index.js', 'x');
    write('.git/config', 'x');
    write('dist/out.js', 'x');
    write('secret/hidden.ts', 'x');
    write('kept.ts', 'export {};');
    write('.gitignore', 'secret/\n');
    const result = scanProject(tmp);
    expect(result.allFiles).toContain('kept.ts');
    expect(result.allFiles).toContain('.gitignore');
    expect(result.allFiles.some((f) => f.startsWith('node_modules'))).toBe(false);
    expect(result.allFiles.some((f) => f.startsWith('.git/'))).toBe(false);
    expect(result.allFiles.some((f) => f.startsWith('dist'))).toBe(false);
    expect(result.allFiles.some((f) => f.startsWith('secret'))).toBe(false);
  });

  it('leaves log files out, rotated ones and a logs folder included', () => {
    write('src/a.ts', 'export {};');
    write('server.log', 'started');
    write('out/../npm-debug.log', 'x');
    write('logs/2026-09-04.txt', 'x');
    write('var/app.log.1', 'x');
    write('var/app.log.gz', 'x');
    write('src/logger.ts', 'export const log = () => {};');
    const result = scanProject(tmp);
    expect(result.allFiles.sort()).toEqual(['src/a.ts', 'src/logger.ts']);
  });
});

describe('parseFileFromDisk', () => {
  it('parses a code file and returns null for non-code', () => {
    write('x.ts', `import './y';`);
    write('notes.txt', 'hello');
    expect(parseFileFromDisk(tmp, 'x.ts')?.imports.map((d) => d.spec)).toEqual(['./y']);
    expect(parseFileFromDisk(tmp, 'notes.txt')).toBeNull();
    expect(parseFileFromDisk(tmp, 'missing.ts')).toBeNull();
  });
});
