import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { FileTreeNode, ParsedFile } from './types';
import { CODE_EXTENSIONS, parseFile } from './parser';
import { extname, toPosix } from './paths';

const DEFAULT_IGNORES = [
  '.git/',
  'node_modules/',
  'dist/',
  'dist-electron/',
  'build/',
  'out/',
  'coverage/',
  '.cache/',
  '.next/',
  '.nuxt/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.idea/',
  '*.min.js',
  '*.map',
  /*
   * Logs are output, not source. A dev server or an agent appends to one
   * continuously, and every append used to arrive as a change: a burst with
   * nothing to review, a row in the tree between the code, a file the
   * unread lens painted as work nobody had looked at. Rotated logs (`.log.1`,
   * `.log.gz`) and a `logs/` folder are the same thing under other names.
   */
  '*.log',
  '*.log.*',
  'logs/',
];

const MAX_FILES = 50_000;
const MAX_PARSE_BYTES = 1_500_000;

export interface ScanResult {
  fileTree: FileTreeNode;
  /** All scanned (non-ignored) files, project-relative posix paths. */
  allFiles: string[];
  /** Parsed code files. */
  parsed: ParsedFile[];
}

export function buildIgnore(root: string): Ignore {
  const ig = ignore();
  ig.add(DEFAULT_IGNORES);
  const gitignorePath = path.join(root, '.gitignore');
  try {
    ig.add(fs.readFileSync(gitignorePath, 'utf8'));
  } catch {
    // no .gitignore — fine
  }
  return ig;
}

/** True if the project-relative posix path should be excluded from scan/watch. */
export function isIgnored(ig: Ignore, relPath: string, isDir: boolean): boolean {
  if (relPath === '') return false;
  return ig.ignores(isDir ? `${relPath}/` : relPath);
}

export function scanProject(root: string, options: { parse?: boolean } = {}): ScanResult {
  const doParse = options.parse !== false;
  const ig = buildIgnore(root);
  const allFiles: string[] = [];
  const parsed: ParsedFile[] = [];

  function walk(dirAbs: string, dirRel: string): FileTreeNode[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs: FileTreeNode[] = [];
    const files: FileTreeNode[] = [];
    for (const entry of entries) {
      if (allFiles.length >= MAX_FILES) break;
      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isIgnored(ig, rel, true)) continue;
        const children = walk(abs, rel);
        dirs.push({ name: entry.name, path: rel, type: 'dir', children });
      } else if (entry.isFile()) {
        if (isIgnored(ig, rel, false)) continue;
        allFiles.push(rel);
        files.push({ name: entry.name, path: rel, type: 'file' });
        if (doParse && CODE_EXTENSIONS.has(extname(rel).toLowerCase())) {
          try {
            const stat = fs.statSync(abs);
            if (stat.size <= MAX_PARSE_BYTES) {
              parsed.push(parseFile(rel, fs.readFileSync(abs, 'utf8')));
            }
          } catch {
            // unreadable — skip
          }
        }
      }
    }
    const byName = (a: FileTreeNode, b: FileTreeNode) => a.name.localeCompare(b.name);
    return [...dirs.sort(byName), ...files.sort(byName)];
  }

  const children = walk(root, '');
  return {
    fileTree: { name: path.basename(root), path: '', type: 'dir', children },
    allFiles,
    parsed,
  };
}

/** Parse a single file from disk; returns null if unreadable/too big/not code. */
export function parseFileFromDisk(root: string, relPath: string): ParsedFile | null {
  const rel = toPosix(relPath);
  if (!CODE_EXTENSIONS.has(extname(rel).toLowerCase())) return null;
  const abs = path.join(root, rel);
  try {
    const stat = fs.statSync(abs);
    if (stat.size > MAX_PARSE_BYTES) return null;
    return parseFile(rel, fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}
