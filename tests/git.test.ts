import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService, parsePorcelainZ } from '../electron/services/git';

let tmp: string;

function git(...args: string[]) {
  execFileSync('git', args, { cwd: tmp, stdio: 'pipe' });
}

function write(rel: string, content: string) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-git-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@test.local');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parsePorcelainZ', () => {
  it('parses states', () => {
    const out = ' M a.ts\0?? new.ts\0A  staged.ts\0 D gone.ts\0';
    const files = parsePorcelainZ(out);
    expect(files['a.ts']).toBe('modified');
    expect(files['new.ts']).toBe('untracked');
    expect(files['staged.ts']).toBe('added');
    expect(files['gone.ts']).toBe('deleted');
  });

  it('handles renames with -z record pairs', () => {
    const out = 'R  new-name.ts\0old-name.ts\0M  other.ts\0';
    const files = parsePorcelainZ(out);
    expect(files['new-name.ts']).toBe('renamed');
    expect(files['other.ts']).toBe('modified');
    expect(files['old-name.ts']).toBeUndefined();
  });
});

describe('GitService', () => {
  it('reports non-repo directories', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-norepo-'));
    try {
      const service = new GitService(dir);
      const status = await service.status();
      expect(status.isRepo).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports branch, modified and untracked files', async () => {
    write('a.ts', 'original');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    write('a.ts', 'changed');
    write('b.ts', 'new');

    const service = new GitService(tmp);
    const status = await service.status();
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.files['a.ts']).toBe('modified');
    expect(status.files['b.ts']).toBe('untracked');
  });

  it('shows HEAD content and null for untracked', async () => {
    write('a.ts', 'original');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    write('a.ts', 'changed');

    const service = new GitService(tmp);
    expect(await service.showHead('a.ts')).toBe('original');
    expect(await service.showHead('missing.ts')).toBeNull();
  });
});
