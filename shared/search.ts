/**
 * Find in files, as pure functions.
 *
 * The session walks the project and reads each file; everything about what a
 * hit *is* — where the match sits on the line, what to show around it, how a
 * replacement is applied — lives here, where it can be tested without a disk.
 */

export interface SearchOptions {
  /** treat the query as a regular expression rather than literal text */
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface SearchHit {
  path: string;
  /** 1-based, the way editors say it */
  line: number;
  /** 0-based column of the match start on that line */
  col: number;
  /** the line, trimmed and clipped around the match */
  preview: string;
  /** where the match starts inside `preview`, so it can be highlighted */
  previewCol: number;
  /** how long the match is */
  length: number;
}

/** Files worth opening for text: anything that is not obviously bytes. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'svgz',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'zip', 'gz', 'tgz', 'bz2', '7z', 'rar', 'jar',
  'pdf', 'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'pyc', 'wasm',
  'mp3', 'mp4', 'mov', 'avi', 'wav', 'ogg', 'flac',
  'lock',
]);

/** A file the search reads. Size is the caller's problem — this is by name. */
export function isSearchableFile(rel: string): boolean {
  const dot = rel.lastIndexOf('.');
  if (dot === -1) return true;
  return !BINARY_EXTENSIONS.has(rel.slice(dot + 1).toLowerCase());
}

/** The largest file the search will read: past this it is a log or a bundle. */
export const MAX_SEARCH_FILE_BYTES = 1_500_000;

/** The most hits one search returns — enough to act on, not a dump. */
export const MAX_SEARCH_HITS = 1000;

const PREVIEW_BEFORE = 40;
const PREVIEW_AFTER = 80;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The query as a regular expression, or null when it cannot be one.
 *
 * Literal text is escaped; a regex query is taken as written and a bad one
 * yields null rather than an exception, so a half-typed `[` in the box does
 * not throw its way up to the UI. Always global, so one line can hit twice.
 */
export function compileQuery(query: string, options: SearchOptions = {}): RegExp | null {
  if (query === '') return null;
  let source = options.regex ? query : escapeRegExp(query);
  if (options.wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return new RegExp(source, options.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

/** Every match in one file's text. */
export function searchText(path: string, text: string, pattern: RegExp): SearchHit[] {
  const hits: SearchHit[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(line)) !== null) {
      if (m[0] === '') {
        // a pattern that matches nothing at all would loop forever here
        pattern.lastIndex++;
        continue;
      }
      const col = m.index;
      const start = Math.max(0, col - PREVIEW_BEFORE);
      const end = Math.min(line.length, col + m[0].length + PREVIEW_AFTER);
      const clipped = line.slice(start, end);
      hits.push({
        path,
        line: i + 1,
        col,
        preview: (start > 0 ? '…' : '') + clipped.trimEnd() + (end < line.length ? '…' : ''),
        previewCol: col - start + (start > 0 ? 1 : 0),
        length: m[0].length,
      });
    }
  }
  return hits;
}

/**
 * Apply a replacement across one file's text.
 *
 * `$1`-style groups work when the query was a regex, because the pattern is
 * the same one the search used — what you saw matched is what gets replaced.
 */
export function replaceText(text: string, pattern: RegExp, replacement: string): { text: string; count: number } {
  let count = 0;
  pattern.lastIndex = 0;
  const next = text.replace(pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    if (match === '') return match;
    count++;
    // the callback's arguments are: match, ...groups, offset, whole string —
    // the groups are what sits before the first number
    const offsetAt = args.findIndex((a) => typeof a === 'number');
    const groups = args.slice(1, offsetAt) as (string | undefined)[];
    return replacement.replace(/\$(\d+|&)/g, (whole, ref: string) => {
      if (ref === '&') return match;
      const idx = Number(ref);
      return idx >= 1 && idx <= groups.length ? (groups[idx - 1] ?? '') : whole;
    });
  });
  return { text: next, count };
}

/** Hits grouped by file, in the order files were searched. */
export function groupHits(hits: readonly SearchHit[]): { path: string; hits: SearchHit[] }[] {
  const groups = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const list = groups.get(hit.path);
    if (list) list.push(hit);
    else groups.set(hit.path, [hit]);
  }
  return [...groups.entries()].map(([path, list]) => ({ path, hits: list }));
}
