import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ignore from 'ignore';
import { afterEach, describe, expect, it } from 'vitest';
import { WatcherService, type WatchBatch } from '../electron/services/watcher';

const started: WatcherService[] = [];
const roots: string[] = [];

function watch(onBatch: (b: WatchBatch) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-watch-'));
  roots.push(root);
  const ig = ignore().add(['node_modules', 'dist']);
  const w = new WatcherService(root, ig, onBatch, 60);
  w.start();
  started.push(w);
  return root;
}

/** Resolve once `predicate` has seen every path it wants, or time out. */
function collect(timeoutMs: number): { seen: Set<string>; wait: (rel: string) => Promise<number> } {
  const seen = new Set<string>();
  const start = Date.now();
  return {
    seen,
    async wait(rel: string) {
      while (Date.now() - start < timeoutMs) {
        if (seen.has(rel)) return Date.now() - start;
        await new Promise((r) => setTimeout(r, 25));
      }
      return -1;
    },
  };
}

afterEach(async () => {
  for (const w of started.splice(0)) await w.dispose();
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // a lingering handle is not a test failure
    }
  }
});

describe('WatcherService', () => {
  it('reports a file written into an existing directory', async () => {
    const c = collect(6000);
    const root = watch((b) => b.changed.forEach((p) => c.seen.add(p)));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    expect(await c.wait('src/a.ts')).toBeGreaterThan(-1);
  });

  it('reports a file written into a directory that did not exist a moment ago', async () => {
    // chokidar attaches a watcher to a new directory only after it has seen
    // it, and anything written in that gap surfaced whenever it next
    // reconciled — measured at over five seconds, against ~400ms for the same
    // file in a folder that already existed. An agent scaffolding a module
    // hits this every time, so the directory is read directly instead.
    const c = collect(4000);
    const root = watch((b) => b.changed.forEach((p) => c.seen.add(p)));
    await new Promise((r) => setTimeout(r, 300));
    fs.mkdirSync(path.join(root, 'fresh', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'fresh', 'nested', 'deep.ts'), 'export const deep = 1;\n');
    const ms = await c.wait('fresh/nested/deep.ts');
    expect(ms, 'the file was reported at all').toBeGreaterThan(-1);
    expect(ms, 'and without waiting for a reconcile').toBeLessThan(3000);
  });

  it('reports non-code files too, since the explorer shows them', async () => {
    const c = collect(4000);
    const root = watch((b) => b.changed.forEach((p) => c.seen.add(p)));
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(root, 'GUIDE.md'), '# Guide\n');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'dot.png'), Buffer.from([1, 2, 3]));
    expect(await c.wait('GUIDE.md'), 'markdown at the root').toBeGreaterThan(-1);
    expect(await c.wait('docs/dot.png'), 'an image in a new folder').toBeGreaterThan(-1);
  });

  it('does not walk into an ignored directory', async () => {
    const c = collect(1500);
    const root = watch((b) => b.changed.forEach((p) => c.seen.add(p)));
    await new Promise((r) => setTimeout(r, 300));
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'real.ts'), 'export const real = 1;\n');
    // the real file proves the watcher is alive; the ignored one must not appear
    expect(await c.wait('real.ts')).toBeGreaterThan(-1);
    expect([...c.seen].filter((p) => p.includes('node_modules'))).toEqual([]);
  });
});
