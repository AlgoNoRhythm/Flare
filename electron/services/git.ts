import type { GitFileState, GitStatus } from '../../shared/types';
import { toPosix } from '../../shared/paths';
import { runGit } from './exec';

function stateFromXY(xy: string): GitFileState {
  if (xy === '??') return 'untracked';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflicted';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

/** Parse `git status --porcelain=v1 -z` output into path -> state. */
export function parsePorcelainZ(out: string): Record<string, GitFileState> {
  const files: Record<string, GitFileState> = {};
  const records = out.split('\0');
  let i = 0;
  while (i < records.length) {
    const rec = records[i];
    if (!rec || rec.length < 4) {
      i++;
      continue;
    }
    const xy = rec.slice(0, 2);
    const p = toPosix(rec.slice(3));
    const state = stateFromXY(xy);
    files[p] = state;
    if (xy[0] === 'R' || xy[0] === 'C') {
      // rename/copy: next record is the original path
      i += 2;
    } else {
      i++;
    }
  }
  return files;
}

export class GitService {
  constructor(private root: string) {}

  async isRepo(): Promise<boolean> {
    const r = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: this.root });
    return r.code === 0 && r.stdout.trim() === 'true';
  }

  async status(): Promise<GitStatus> {
    if (!(await this.isRepo())) return { branch: '', files: {}, isRepo: false };
    const [branchRes, statusRes] = await Promise.all([
      runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.root }),
      runGit(['status', '--porcelain=v1', '-z'], { cwd: this.root }),
    ]);
    return {
      branch: branchRes.code === 0 ? branchRes.stdout.trim() : '',
      files: parsePorcelainZ(statusRes.stdout),
      isRepo: true,
    };
  }

  /** Content of a file at HEAD, or null if it doesn't exist there. */
  async showHead(relPath: string): Promise<string | null> {
    const r = await runGit(['show', `HEAD:${toPosix(relPath)}`], { cwd: this.root });
    return r.code === 0 ? r.stdout : null;
  }

  /** Commits-touching-file counts over recent history (churn). */
  async churn(maxCommits = 3000): Promise<Record<string, number>> {
    const r = await runGit(
      ['log', `-n`, String(maxCommits), '--name-only', '--pretty=format:'],
      { cwd: this.root },
    );
    if (r.code !== 0) return {};
    const counts: Record<string, number> = {};
    for (const line of r.stdout.split('\n')) {
      const p = line.trim();
      if (p !== '') counts[toPosix(p)] = (counts[toPosix(p)] ?? 0) + 1;
    }
    return counts;
  }
}
