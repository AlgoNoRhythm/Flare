/** Pure path helpers (posix-style, project-relative). Safe for renderer use. */

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Normalize a posix path: resolve '.' and '..', strip leading './', collapse '//'. */
export function normalizePosix(p: string): string {
  const parts = toPosix(p).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

export function dirname(p: string): string {
  const norm = toPosix(p);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}

export function basename(p: string): string {
  const norm = toPosix(p);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

export function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx);
}

export function joinPosix(...parts: string[]): string {
  return normalizePosix(parts.filter(Boolean).join('/'));
}

/** Top-level directory of a project-relative path, or '' for root files. */
export function topDir(p: string): string {
  const norm = toPosix(p);
  const idx = norm.indexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}
