import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ShadowSnapshot } from '../../shared/types';
import { toPosix } from '../../shared/paths';
import { runGit } from './exec';

const SHADOW_EXCLUDES = `.git/
node_modules/
dist/
dist-electron/
build/
out/
coverage/
.cache/
.next/
.nuxt/
.venv/
venv/
__pycache__/
.pytest_cache/
.mypy_cache/
.idea/
*.log
`;

/**
 * Fine-grained local history: a hidden git repo (separate GIT_DIR) whose work
 * tree is the project. Every change burst becomes a micro-commit, giving
 * per-file and whole-tree time travel without touching the user's real repo.
 */
export class ShadowService {
  readonly shadowDir: string;
  private env: NodeJS.ProcessEnv;
  /** All mutating operations run serialized — git locks the shadow index. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private projectRoot: string,
    storageRoot: string,
  ) {
    const hash = crypto.createHash('sha1').update(projectRoot.toLowerCase()).digest('hex').slice(0, 16);
    this.shadowDir = path.join(storageRoot, 'shadow', hash);
    this.env = {
      GIT_DIR: this.shadowDir,
      GIT_WORK_TREE: this.projectRoot,
      GIT_INDEX_FILE: path.join(this.shadowDir, 'index'),
    };
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {
      // errors are handled by callers; keep the queue alive
    });
    return next;
  }

  private git(args: string[]) {
    return runGit(
      [
        '-c', 'user.name=Flare',
        '-c', 'user.email=shadow@flare.local',
        '-c', 'commit.gpgsign=false',
        '-c', 'core.autocrlf=false',
        ...args,
      ],
      { cwd: this.projectRoot, env: this.env },
    );
  }

  async init(): Promise<void> {
    if (!fs.existsSync(path.join(this.shadowDir, 'HEAD'))) {
      fs.mkdirSync(this.shadowDir, { recursive: true });
      const r = await this.git(['init', '-q']);
      if (r.code !== 0) throw new Error(`shadow init failed: ${r.stderr}`);
    }
    const infoDir = path.join(this.shadowDir, 'info');
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(path.join(infoDir, 'exclude'), SHADOW_EXCLUDES);
  }

  /** Commit current work-tree state if anything changed. Returns hash or null. */
  snapshot(message: string): Promise<string | null> {
    return this.serialize(() => this.snapshotNow(message));
  }

  private async snapshotNow(message: string): Promise<string | null> {
    const add = await this.git(['add', '-A', '--', '.']);
    if (add.code !== 0) return null;
    const status = await this.git(['status', '--porcelain']);
    if (status.stdout.trim() === '') return null;
    const commit = await this.git(['commit', '-q', '-m', message || 'snapshot']);
    if (commit.code !== 0) return null;
    const rev = await this.git(['rev-parse', 'HEAD']);
    return rev.code === 0 ? rev.stdout.trim() : null;
  }

  async timeline(limit = 100): Promise<ShadowSnapshot[]> {
    const r = await this.git([
      'log',
      `-n`, String(limit),
      '--name-only',
      '--pretty=format:@@%H%x09%ct%x09%s',
    ]);
    if (r.code !== 0) return [];
    const snapshots: ShadowSnapshot[] = [];
    let current: ShadowSnapshot | null = null;
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('@@')) {
        const [hash, ct, ...rest] = line.slice(2).split('\t');
        current = { hash, time: Number(ct) * 1000, message: rest.join('\t'), files: [] };
        snapshots.push(current);
      } else if (line.trim() !== '' && current) {
        current.files.push(toPosix(line.trim()));
      }
    }
    return snapshots;
  }

  /** File content at a snapshot, or null if absent. */
  async show(hash: string, relPath: string): Promise<string | null> {
    const r = await this.git(['show', `${hash}:${toPosix(relPath)}`]);
    return r.code === 0 ? r.stdout : null;
  }

  /** Restore a single file to its state at `hash`. */
  restoreFile(hash: string, relPath: string): Promise<boolean> {
    return this.serialize(() => this.restoreFileNow(hash, relPath));
  }

  private async restoreFileNow(hash: string, relPath: string): Promise<boolean> {
    const rel = toPosix(relPath);
    const inSnapshot = await this.git(['cat-file', '-e', `${hash}:${rel}`]);
    if (inSnapshot.code !== 0) {
      // file didn't exist at that snapshot -> restoring means deleting it
      try {
        fs.rmSync(path.join(this.projectRoot, rel), { force: true });
        return true;
      } catch {
        return false;
      }
    }
    const r = await this.git(['checkout', hash, '--', rel]);
    return r.code === 0;
  }

  /** Restore the whole tree to `hash`, deleting files created since. */
  restoreAll(hash: string): Promise<boolean> {
    return this.serialize(() => this.restoreAllNow(hash));
  }

  private async restoreAllNow(hash: string): Promise<boolean> {
    const [inSnap, tracked] = await Promise.all([
      this.git(['ls-tree', '-r', '--name-only', hash]),
      this.git(['ls-files']),
    ]);
    if (inSnap.code !== 0) return false;
    const snapFiles = new Set(inSnap.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
    const trackedNow = tracked.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    for (const f of trackedNow) {
      if (!snapFiles.has(f)) {
        try {
          fs.rmSync(path.join(this.projectRoot, f), { force: true });
        } catch {
          // ignore
        }
      }
    }
    const r = await this.git(['checkout', hash, '--', '.']);
    return r.code === 0;
  }
}
