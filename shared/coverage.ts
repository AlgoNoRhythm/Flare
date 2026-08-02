import { toPosix } from './paths';

/** Per-file line coverage. */
export interface FileCoverage {
  found: number;
  hit: number;
  /** 0..100 */
  pct: number;
}

export type CoverageMap = Record<string, FileCoverage>;

/**
 * Parse an lcov.info stream (the de-facto standard emitted by vitest/jest
 * `--coverage`, nyc, pytest-cov via `coverage lcov`, go tooling, …).
 * Returns SF-path -> counts, un-normalized.
 */
export function parseLcov(text: string): Record<string, { found: number; hit: number }> {
  const out: Record<string, { found: number; hit: number }> = {};
  let current: string | null = null;
  let da = { found: 0, hit: 0 };
  let lf: number | null = null;
  let lh: number | null = null;

  const flush = () => {
    if (current !== null) {
      // prefer LF/LH summaries when present, else derive from DA lines
      const found = lf ?? da.found;
      const hit = lh ?? da.hit;
      out[current] = { found, hit };
    }
    current = null;
    da = { found: 0, hit: 0 };
    lf = null;
    lh = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      flush();
      current = line.slice(3).trim();
    } else if (line.startsWith('DA:')) {
      const parts = line.slice(3).split(',');
      const count = Number(parts[1]);
      if (Number.isFinite(count)) {
        da.found++;
        if (count > 0) da.hit++;
      }
    } else if (line.startsWith('LF:')) {
      lf = Number(line.slice(3)) || 0;
    } else if (line.startsWith('LH:')) {
      lh = Number(line.slice(3)) || 0;
    } else if (line === 'end_of_record') {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * Map raw lcov SF paths (absolute or relative, either slash style) onto
 * project-relative posix paths. Case-insensitive; falls back to unique
 * suffix matching when the root prefix doesn't line up.
 */
export function resolveCoverage(
  raw: Record<string, { found: number; hit: number }>,
  projectFiles: Iterable<string>,
  projectRoot: string,
): CoverageMap {
  const byLower = new Map<string, string>();
  for (const f of projectFiles) byLower.set(f.toLowerCase(), f);
  const root = toPosix(projectRoot).toLowerCase().replace(/\/+$/, '');

  const out: CoverageMap = {};
  for (const [sfRaw, counts] of Object.entries(raw)) {
    const sf = toPosix(sfRaw).toLowerCase();
    let rel: string | null = null;
    if (root && sf.startsWith(`${root}/`)) {
      rel = sf.slice(root.length + 1);
    } else if (byLower.has(sf.replace(/^\.\//, ''))) {
      rel = sf.replace(/^\.\//, '');
    }
    let match = rel ? byLower.get(rel) : undefined;
    if (!match) {
      // unique suffix match, e.g. lcov generated in a subdir or another checkout
      const candidates: string[] = [];
      for (const [lower, original] of byLower) {
        if (sf.endsWith(`/${lower}`) || sf === lower) candidates.push(original);
      }
      if (candidates.length === 1) match = candidates[0];
    }
    if (match) {
      const pct = counts.found === 0 ? 100 : Math.round((counts.hit / counts.found) * 1000) / 10;
      out[match] = { ...counts, pct };
    }
  }
  return out;
}
