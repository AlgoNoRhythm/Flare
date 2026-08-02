import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShadowService } from '../electron/services/shadow';

let project: string;
let storage: string;
let shadow: ShadowService;

function write(rel: string, content: string) {
  const abs = path.join(project, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(project, rel), 'utf8');
  } catch {
    return null;
  }
}

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-proj-'));
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-store-'));
  shadow = new ShadowService(project, storage);
  await shadow.init();
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(storage, { recursive: true, force: true });
});

describe('ShadowService', () => {
  it('snapshots and lists a timeline with changed files', async () => {
    write('a.ts', 'v1');
    const h1 = await shadow.snapshot('first');
    expect(h1).toBeTruthy();

    write('a.ts', 'v2');
    write('b.ts', 'new');
    const h2 = await shadow.snapshot('second');
    expect(h2).toBeTruthy();
    expect(h2).not.toBe(h1);

    const timeline = await shadow.timeline();
    expect(timeline).toHaveLength(2);
    expect(timeline[0].hash).toBe(h2);
    expect(timeline[0].message).toBe('second');
    expect(timeline[0].files.sort()).toEqual(['a.ts', 'b.ts']);
    expect(timeline[1].files).toEqual(['a.ts']);
  });

  it('returns null snapshot when nothing changed', async () => {
    write('a.ts', 'v1');
    await shadow.snapshot('first');
    const again = await shadow.snapshot('no-op');
    expect(again).toBeNull();
  });

  it('shows file content at a snapshot', async () => {
    write('a.ts', 'v1');
    const h1 = await shadow.snapshot('first');
    write('a.ts', 'v2');
    await shadow.snapshot('second');
    expect(await shadow.show(h1!, 'a.ts')).toBe('v1');
    expect(await shadow.show(h1!, 'nope.ts')).toBeNull();
  });

  it('restores a single file to a previous state', async () => {
    write('a.ts', 'v1');
    write('keep.ts', 'same');
    const h1 = await shadow.snapshot('first');
    write('a.ts', 'v2');
    await shadow.snapshot('second');

    expect(await shadow.restoreFile(h1!, 'a.ts')).toBe(true);
    expect(read('a.ts')).toBe('v1');
    expect(read('keep.ts')).toBe('same');
  });

  it('restoring a file absent from the snapshot deletes it', async () => {
    write('a.ts', 'v1');
    const h1 = await shadow.snapshot('first');
    write('later.ts', 'created after');
    await shadow.snapshot('second');

    expect(await shadow.restoreFile(h1!, 'later.ts')).toBe(true);
    expect(read('later.ts')).toBeNull();
  });

  it('restores the whole tree including deleting newer files', async () => {
    write('a.ts', 'v1');
    write('sub/b.ts', 'b1');
    const h1 = await shadow.snapshot('first');

    write('a.ts', 'v2');
    write('c.ts', 'new file');
    fs.rmSync(path.join(project, 'sub/b.ts'));
    await shadow.snapshot('second');

    expect(await shadow.restoreAll(h1!)).toBe(true);
    expect(read('a.ts')).toBe('v1');
    expect(read('sub/b.ts')).toBe('b1');
    expect(read('c.ts')).toBeNull();
  });

  it('ignores node_modules and .git in snapshots', async () => {
    write('a.ts', 'v1');
    write('node_modules/pkg/index.js', 'x');
    write('.git/config', 'x');
    const h1 = await shadow.snapshot('first');
    const timeline = await shadow.timeline();
    expect(h1).toBeTruthy();
    expect(timeline[0].files).toEqual(['a.ts']);
  });

  it('does not touch the real repository', async () => {
    write('a.ts', 'v1');
    await shadow.snapshot('first');
    expect(fs.existsSync(path.join(project, '.git', 'HEAD'))).toBe(false);
  });
});
