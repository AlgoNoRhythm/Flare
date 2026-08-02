import * as fs from 'node:fs';
import * as path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Ignore } from 'ignore';
import { toPosix } from '../../shared/paths';

export interface WatchBatch {
  /** Files added or modified (project-relative posix). */
  changed: string[];
  /** Files removed. */
  removed: string[];
}

/** Debounced recursive watcher honoring the project's ignore rules. */
export class WatcherService {
  private watcher: FSWatcher | null = null;
  private changed = new Set<string>();
  private removed = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private root: string,
    private ig: Ignore,
    private onBatch: (batch: WatchBatch) => void,
    private debounceMs = 200,
  ) {}

  start(): void {
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      ignored: (absPath: string) => {
        const rel = toPosix(path.relative(this.root, absPath));
        if (rel === '' || rel === '.') return false;
        if (rel.startsWith('..')) return true;
        return this.ig.ignores(rel) || this.ig.ignores(`${rel}/`);
      },
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.watcher
      .on('add', (p) => this.enqueue(p, 'changed'))
      .on('change', (p) => this.enqueue(p, 'changed'))
      .on('unlink', (p) => this.enqueue(p, 'removed'))
      .on('addDir', (p) => this.enqueueNewDir(p))
      .on('error', () => {
        // transient FS errors (locked files etc.) — safe to ignore
      });
  }

  /**
   * A directory appeared: read what is already inside it, now.
   *
   * chokidar attaches a watcher to a new directory only after it has seen it,
   * and anything written in the gap is reported whenever it next reconciles —
   * measured at over five seconds for a file created in a folder that did not
   * exist a moment earlier, against ~400ms for the same file in a folder that
   * did. An agent scaffolding a new module hits that case every time. Reading
   * the directory ourselves closes the window rather than waiting it out;
   * anything chokidar does report later is deduplicated by the pending set.
   */
  private enqueueNewDir(absPath: string, depth = 0): void {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absPath, { withFileTypes: true });
    } catch {
      return; // vanished again, or unreadable — the watcher will cope
    }
    for (const entry of entries) {
      const child = path.join(absPath, entry.name);
      const rel = toPosix(path.relative(this.root, child));
      if (rel === '' || rel.startsWith('..')) continue;
      if (this.ig.ignores(rel) || this.ig.ignores(`${rel}/`)) continue;
      if (entry.isDirectory()) this.enqueueNewDir(child, depth + 1);
      else if (entry.isFile()) this.enqueue(child, 'changed');
    }
  }

  private enqueue(absPath: string, kind: 'changed' | 'removed'): void {
    const rel = toPosix(path.relative(this.root, absPath));
    if (rel === '' || rel.startsWith('..')) return;
    if (kind === 'changed') {
      this.changed.add(rel);
      this.removed.delete(rel);
    } else {
      this.removed.add(rel);
      this.changed.delete(rel);
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    this.timer = null;
    if (this.changed.size === 0 && this.removed.size === 0) return;
    const batch: WatchBatch = { changed: [...this.changed], removed: [...this.removed] };
    this.changed.clear();
    this.removed.clear();
    this.onBatch(batch);
  }

  async dispose(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
    this.watcher = null;
  }
}
