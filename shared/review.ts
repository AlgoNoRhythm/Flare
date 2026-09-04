/**
 * Risk-tiered review.
 *
 * Reviewing every changed file with equal attention is how large agent
 * changes get rubber-stamped: attention is finite and spread evenly, so the
 * one file that matters gets the same three seconds as the lockfile. Tiering
 * says out loud which files deserve the attention, and why.
 */

export type ReviewTier = 'careful' | 'read' | 'skim';

export interface TierInput {
  path: string;
  /** regression-risk composite, 0..100 within this repo */
  risk: number;
  /** transitive dependents */
  blastRadius: number;
  /** direct importers */
  fanIn: number;
  coveragePct: number | null;
  testedBy: number;
  complexity: number;
  inCycle: boolean;
  isTest: boolean;
}

export interface TierResult {
  tier: ReviewTier;
  /** short, quantified, worst-first — these are shown next to the file */
  reasons: string[];
}

export const TIER_ORDER: Record<ReviewTier, number> = { careful: 0, read: 1, skim: 2 };

export const TIER_LABEL: Record<ReviewTier, string> = {
  careful: 'Read carefully',
  read: 'Read',
  skim: 'Skim',
};

export const TIER_HINT: Record<ReviewTier, string> = {
  careful: 'load-bearing and under-protected — read the whole diff',
  read: 'has real dependents or real complexity — read the diff',
  skim: 'leaf, small or well covered — a glance is enough',
};

/** Nothing meaningful is checking this file. Exported so alerts agree with tiers. */
export function uncovered(f: TierInput): boolean {
  return f.coveragePct === null ? f.testedBy === 0 : f.coveragePct < 30;
}

export function reviewTier(f: TierInput): TierResult {
  const reasons: string[] = [];

  if (f.blastRadius >= 3) {
    reasons.push(`${f.blastRadius} file${f.blastRadius === 1 ? '' : 's'} break if this is wrong`);
  } else if (f.fanIn >= 1) {
    reasons.push(f.fanIn === 1 ? '1 file imports it' : `${f.fanIn} files import it`);
  }
  if (uncovered(f)) {
    reasons.push(f.coveragePct === null ? 'no test covers it' : `only ${Math.round(f.coveragePct)}% covered`);
  }
  if (f.inCycle) reasons.push('sits in an import cycle');
  if (f.complexity >= 40) reasons.push(`complexity ${f.complexity}`);

  const careful =
    f.risk >= 60 ||
    f.blastRadius >= 10 ||
    (f.inCycle && f.fanIn >= 1) ||
    (uncovered(f) && f.fanIn >= 3);

  const read = f.risk >= 30 || f.blastRadius >= 3 || f.complexity >= 40 || f.fanIn >= 3;

  const tier: ReviewTier = careful ? 'careful' : read ? 'read' : 'skim';

  if (tier === 'skim' && reasons.length === 0) {
    reasons.push(f.isTest ? 'a test — the suite checks it for you' : 'nothing depends on it yet');
  }
  return { tier, reasons };
}

/** Careful first, then by risk — the order a human should walk the change in. */
export function sortForReview<T extends { tier: ReviewTier; risk: number; path: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.risk - a.risk || a.path.localeCompare(b.path),
  );
}

/**
 * What to compare a change against: the newest snapshot taken *before* it.
 *
 * A burst's own `snapshotHash` is the snapshot taken a second and a half
 * *after* its writes — the right thing to jump back to once something is
 * verified, and exactly the wrong thing to diff against, because it already
 * contains the change. Diffing a file against it showed a clean, empty diff
 * for an edit that had plainly happened, and reverting to it did nothing at
 * all. The state before the burst is the previous snapshot; the session takes
 * one at startup, so there is normally one even for the first change of a
 * session. Null means there is none, and git HEAD is the only base left.
 */
export function baseSnapshotFor(
  startedAt: number,
  snapshots: readonly { hash: string; time: number }[],
): string | null {
  let best: { hash: string; time: number } | null = null;
  for (const snap of snapshots) {
    if (snap.time > startedAt) continue;
    if (!best || snap.time > best.time) best = snap;
  }
  return best?.hash ?? null;
}

/**
 * The rows bucketed by tier, worst tier first, empty tiers left out.
 *
 * A burst's file list reads as one flat run of rows otherwise, and the tier
 * — the one fact that says how much of your attention each row deserves —
 * was a badge repeated on every one of them. As groups it is said once per
 * tier, and the tier nobody needs to read can fold away.
 */
export function groupByTier<T extends { tier: ReviewTier }>(
  rows: readonly T[],
): { tier: ReviewTier; rows: T[] }[] {
  const buckets = new Map<ReviewTier, T[]>();
  for (const row of rows) {
    const list = buckets.get(row.tier);
    if (list) list.push(row);
    else buckets.set(row.tier, [row]);
  }
  return (Object.keys(TIER_ORDER) as ReviewTier[])
    .sort((a, b) => TIER_ORDER[a] - TIER_ORDER[b])
    .filter((tier) => buckets.has(tier))
    .map((tier) => ({ tier, rows: buckets.get(tier)! }));
}

/** "read 3 carefully, read 4, skim 9" */
export function tierSummary(tiers: ReviewTier[]): string {
  const counts = { careful: 0, read: 0, skim: 0 };
  for (const t of tiers) counts[t]++;
  const parts: string[] = [];
  if (counts.careful > 0) parts.push(`${counts.careful} to read carefully`);
  if (counts.read > 0) parts.push(`${counts.read} to read`);
  if (counts.skim > 0) parts.push(`${counts.skim} to skim`);
  return parts.join(', ') || 'nothing to review';
}
