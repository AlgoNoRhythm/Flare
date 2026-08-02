import type { GraphNode, ParsedFile } from './types';
import { isTestPath } from './graph';
import { basename } from './paths';

/**
 * Agent smells: the failure modes that agent-written changes have and
 * human-written changes mostly don't.
 *
 * These are deliberately *not* generic lint rules. Each one encodes a pattern
 * the literature keeps naming — a test rewritten to match new behaviour, a
 * suppression added instead of a fix, a coverage threshold quietly lowered,
 * an abstraction extracted for a single caller — and each one is scoped to a
 * single change burst, because that is the unit a human actually reviews.
 *
 * Pure: give it before/after text plus a few graph facts and it returns
 * findings. No filesystem, no git.
 */

export type SmellSeverity = 'critical' | 'warning' | 'info';

export interface Smell {
  rule: string;
  severity: SmellSeverity;
  title: string;
  detail: string;
  paths: string[];
}

export interface FileChange {
  path: string;
  /** null when the previous content is unknown (first time we saw this file). */
  beforeText: string | null;
  afterText: string | null;
  beforeParsed: ParsedFile | null;
  afterParsed: ParsedFile | null;
  removed: boolean;
  /** true when the file did not exist before this burst */
  added: boolean;
}

export interface SmellInput {
  files: FileChange[];
  /** Graph state after the burst. */
  nodes: ReadonlyMap<string, GraphNode>;
  /** Files importing a given path, after the burst. */
  importersOf(path: string): string[];
  /** Direct-importer counts that changed during this burst. */
  degreeDelta: { path: string; before: number; after: number }[];
  /**
   * Does the repo contain any test files at all? In one that does not, saying
   * "nothing tests this" on every burst is noise, not a finding — Insights
   * already says it once, at the repo level.
   */
  hasTests?: boolean;
}

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

const ASSERTION_RE = /\b(expect\s*\(|assert(_[a-z]+)?\s*\(|assertEquals?\s*\(|should\s*\.|\.to\.(be|equal|deep|have|throw))/g;
const SKIP_RE =
  /(\b(it|test|describe|context|suite)\s*\.\s*(skip|only|todo)\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.(skip|xfail)|#\[ignore\]|\bt\.Skip\s*\(|\.skip\s*\(\s*['"`])/g;
const SUPPRESSION_RE =
  /(eslint-disable(-next-line|-line)?|@ts-(ignore|expect-error|nocheck)|#\s*noqa|#\s*type:\s*ignore|@SuppressWarnings|\/\/\s*nolint|# rubocop:disable|prettier-ignore)/g;
const ANY_RE = /(:\s*any\b|\bas\s+any\b|<any>)/g;
const THRESHOLD_RE = /\b(lines|statements|branches|functions|threshold|minCoverage|coverageThreshold)\s*[:=]\s*(\d+(?:\.\d+)?)/gi;

function thresholds(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const match of text.matchAll(THRESHOLD_RE)) {
    const key = match[1].toLowerCase();
    const value = Number(match[2]);
    // keep the lowest occurrence per key: config files often repeat them
    const prev = out.get(key);
    if (prev === undefined || value < prev) out.set(key, value);
  }
  return out;
}

/** Strip the extension and any `.test`/`.spec`/`_test` marker: foo.test.ts -> foo */
function testStem(path: string): string {
  return basename(path)
    .replace(/\.[^.]+$/, '')
    .replace(/[._-](test|spec)$/i, '')
    .replace(/^test_/i, '');
}

export function detectSmells(input: SmellInput): Smell[] {
  const smells: Smell[] = [];
  const live = input.files.filter((f) => !f.removed);
  const changedTests = live.filter((f) => isTestPath(f.path));
  const changedSource = live.filter((f) => !isTestPath(f.path));

  // ---- a test moved in lockstep with the code it covers -------------------
  const lockstep: string[] = [];
  for (const test of changedTests) {
    for (const source of changedSource) {
      const imports = input.importersOf(source.path).includes(test.path);
      const nameMatch = testStem(test.path) === testStem(source.path);
      if (imports || nameMatch) lockstep.push(test.path, source.path);
    }
  }
  if (lockstep.length > 0) {
    smells.push({
      rule: 'test-follows-source',
      severity: 'warning',
      title: 'Test changed in the same burst as the code it covers',
      detail:
        'A passing suite proves nothing when the test moved with the implementation. Check that the assertions still describe the behaviour you wanted, not the behaviour that was produced.',
      paths: [...new Set(lockstep)],
    });
  }

  // ---- verification quietly weakened --------------------------------------
  const deAsserted: string[] = [];
  const skipped: string[] = [];
  const suppressed: string[] = [];
  const loosened: string[] = [];
  const lowered: { path: string; key: string; before: number; after: number }[] = [];

  for (const file of live) {
    const after = file.afterText;
    if (after === null) continue;
    const before = file.beforeText;

    if (before !== null) {
      const dropped = count(before, ASSERTION_RE) - count(after, ASSERTION_RE);
      if (isTestPath(file.path) && dropped > 0) deAsserted.push(file.path);

      if (count(after, SKIP_RE) > count(before, SKIP_RE)) skipped.push(file.path);
      if (count(after, SUPPRESSION_RE) > count(before, SUPPRESSION_RE)) suppressed.push(file.path);
      if (count(after, ANY_RE) > count(before, ANY_RE)) loosened.push(file.path);

      const beforeThresholds = thresholds(before);
      for (const [key, value] of thresholds(after)) {
        const prev = beforeThresholds.get(key);
        if (prev !== undefined && value < prev) {
          lowered.push({ path: file.path, key, before: prev, after: value });
        }
      }
    } else if (count(after, SKIP_RE) > 0 && file.added && isTestPath(file.path)) {
      skipped.push(file.path);
    }
  }

  if (skipped.length > 0) {
    smells.push({
      rule: 'test-disabled',
      severity: 'critical',
      title: 'A test was skipped or narrowed',
      detail:
        'This burst added a .skip / .only / xit marker. Skipping keeps the suite green while the behaviour goes unchecked; .only silently stops every other test in the file from running.',
      paths: [...new Set(skipped)],
    });
  }
  if (deAsserted.length > 0) {
    smells.push({
      rule: 'assertions-removed',
      severity: 'critical',
      title: 'Assertions were deleted from a test',
      detail:
        'The test file has fewer assertions than before the burst. Removing the assertion is the cheapest way to make a failing test pass.',
      paths: [...new Set(deAsserted)],
    });
  }
  if (lowered.length > 0) {
    smells.push({
      rule: 'threshold-lowered',
      severity: 'critical',
      title: 'A quality threshold was lowered',
      detail: lowered
        .map((l) => `${l.path}: ${l.key} ${l.before} → ${l.after}`)
        .join('; '),
      paths: [...new Set(lowered.map((l) => l.path))],
    });
  }
  if (suppressed.length > 0) {
    smells.push({
      rule: 'suppression-added',
      severity: 'warning',
      title: 'A linter or type-checker was silenced',
      detail:
        'New eslint-disable / @ts-ignore / noqa comments appeared. Sometimes correct — but it is also how an agent makes a diagnostic go away without addressing it.',
      paths: [...new Set(suppressed)],
    });
  }
  if (loosened.length > 0) {
    smells.push({
      rule: 'types-loosened',
      severity: 'warning',
      title: 'Types were widened to any',
      detail: 'More `any` than before the burst — the type checker stops covering these paths.',
      paths: [...new Set(loosened)],
    });
  }

  // ---- shape of the change ------------------------------------------------
  const spikes = live.filter(
    (f) =>
      f.beforeParsed !== null &&
      f.afterParsed !== null &&
      f.afterParsed.complexity - f.beforeParsed.complexity >= 25 &&
      f.afterParsed.complexity >= f.beforeParsed.complexity * 1.5,
  );
  if (spikes.length > 0) {
    smells.push({
      rule: 'complexity-spike',
      severity: 'warning',
      title: 'Complexity jumped sharply',
      detail: spikes
        .map((f) => `${f.path}: ${f.beforeParsed!.complexity} → ${f.afterParsed!.complexity}`)
        .join('; '),
      paths: spikes.map((f) => f.path),
    });
  }

  const orphaned = input.degreeDelta
    .filter((d) => d.before > 0 && d.after === 0)
    .map((d) => d.path)
    .filter((p) => !isTestPath(p) && !input.nodes.get(p)?.isTest);
  if (orphaned.length > 0) {
    smells.push({
      rule: 'left-behind',
      severity: 'warning',
      title: 'A file lost its last importer',
      detail:
        'Nothing imports these any more. Agents rewire call sites but rarely delete what they replaced, so old implementations linger and get maintained by mistake.',
      paths: orphaned,
    });
  }

  const newSingleCaller = live
    .filter((f) => f.added && !isTestPath(f.path))
    .filter((f) => {
      const importers = input.importersOf(f.path);
      const exported = f.afterParsed?.symbols.filter((s) => s.exported).length ?? 0;
      return importers.length === 1 && exported > 0 && exported <= 2;
    })
    .map((f) => f.path);
  if (newSingleCaller.length > 0) {
    smells.push({
      rule: 'single-caller-abstraction',
      severity: 'info',
      title: 'New module with exactly one caller',
      detail:
        'A file was extracted that only one place uses. Sometimes the right seam — often an abstraction built where a function would have done.',
      paths: newSingleCaller,
    });
  }

  const untested = changedSource
    .filter((f) => !f.removed)
    .filter((f) => (input.nodes.get(f.path)?.testedBy ?? 0) === 0)
    .map((f) => f.path);
  if (changedTests.length === 0 && untested.length > 0 && input.hasTests !== false) {
    smells.push({
      rule: 'unverified-change',
      severity: untested.length >= 3 ? 'warning' : 'info',
      title: 'Source changed with no test anywhere near it',
      detail: `${untested.length} changed file${untested.length === 1 ? ' has' : 's have'} no test importing them, and no test was touched in this burst. Nothing here is protected by the suite.`,
      paths: untested,
    });
  }

  if (input.files.length >= 12) {
    smells.push({
      rule: 'oversized-burst',
      severity: 'info',
      title: `${input.files.length} files in one burst`,
      detail:
        'Large changes get rubber-stamped: review time rises with size while attention does not. Consider reviewing this in slices, worst-risk first.',
      paths: input.files.slice(0, 8).map((f) => f.path),
    });
  }

  return smells;
}
