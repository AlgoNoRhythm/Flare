import { basename, dirname } from './paths';

/**
 * Format a set of project paths for pasting into an agent prompt or terminal:
 * grouped by folder, indented, deterministic. A single path stays a plain
 * path.
 *
 *   src/components/
 *     FileTree.tsx
 *     GraphView.tsx
 *   shared/
 *     parser.ts
 */
export function formatPathsTree(paths: string[]): string {
  const unique = [...new Set(paths)].filter(Boolean);
  if (unique.length === 0) return '';
  if (unique.length === 1) return unique[0];
  const byDir = new Map<string, string[]>();
  for (const p of unique) {
    const dir = dirname(p);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(basename(p));
  }
  const lines: string[] = [];
  for (const dir of [...byDir.keys()].sort()) {
    lines.push(dir === '' ? './' : `${dir}/`);
    for (const file of byDir.get(dir)!.sort()) lines.push(`  ${file}`);
  }
  return lines.join('\n');
}

/** Space-separated flat list, quoting paths that contain spaces (shell-ready). */
export function formatPathsFlat(paths: string[]): string {
  return [...new Set(paths)]
    .filter(Boolean)
    .sort()
    .map((p) => (/\s/.test(p) ? `"${p}"` : p))
    .join(' ');
}
