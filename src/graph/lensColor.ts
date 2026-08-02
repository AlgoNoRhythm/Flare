import type { GraphNode } from '../../shared/types';
import type { CoverageMap } from '../../shared/coverage';
import { LENS_HUES, ramp, riskScore, type Lens } from './lenses';
import { NEUTRAL_SERIES, STATUS, SURFACE, mixHex } from '../theme';

export interface LensContext {
  lens: Lens;
  churn: Record<string, number>;
  coverage: CoverageMap;
  changedAt: Record<string, number>;
  /** path -> when a human last opened it in the editor */
  readAt: Record<string, number>;
  /**
   * path -> reuse score, computed once by the metrics engine. Passed in
   * rather than derived here: it needs the transitive dependency count, which
   * is a whole-graph walk the renderer has no business repeating.
   */
  reuse: Record<string, number | null>;
  clusterColor(cluster: string): string;
  /**
   * Recency order of this session's changes, newest first. The activity lens
   * uses the *order* rather than elapsed time: a decaying heat goes blank ten
   * minutes after you stop typing, and re-reading the clock on every render
   * makes the graph flicker while you edit.
   */
  recency: string[];
  /**
   * Where a raw value sits in this repo's distribution, 0..1. Used by the
   * skewed lenses — see `RANKED`.
   */
  rank(raw: number): number;
}


/**
 * Lenses whose raw values follow a power law: a couple of monsters and a long
 * tail of ordinary files.
 *
 * Dividing by the maximum on that shape wastes the ramp — in this repo it puts
 * 83% of files in its bottom fifth, so "bright" and "not bright" look the
 * same and only the single worst file stands out. Ranking within the repo's
 * own distribution spends the whole ramp, and makes "bright" mean what the
 * lens claims it means: worst *here*, relative to everything else here.
 *
 * Lenses with an absolute meaning are deliberately excluded: 80% coverage
 * should look like 80% coverage whether or not the rest of the repo is worse.
 */
const RANKED = new Set<Lens>(['hotspot', 'risk']);

/** Lenses drawn with a single-hue ramp rather than fixed swatches. */
const RAMP_HUE: Partial<Record<Lens, string>> = {
  activity: LENS_HUES.activity,
  hotspot: LENS_HUES.hotspot,
  risk: LENS_HUES.risk,
  instability: LENS_HUES.instability,
  coverage: LENS_HUES.instability,
  reuse: LENS_HUES.reuse,
};

/** Raw, un-normalised value for the ranked lenses. */
function rawValue(node: GraphNode, ctx: LensContext): number {
  return ctx.lens === 'hotspot'
    ? node.complexity * ((ctx.churn[node.id] ?? 0) + 1)
    : riskScore(node, ctx.coverage[node.id]?.pct);
}

/**
 * Mid-rank percentile over a fixed set of values. A distribution with no
 * spread returns 0 throughout rather than inventing contrast that isn't there.
 */
export function percentileScale(values: number[]): (value: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n < 2 || sorted[n - 1] - sorted[0] < 1e-9) return () => 0;
  const bound = (target: number, strict: boolean): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (strict ? sorted[mid] < target : sorted[mid] <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (value: number) => {
    const below = bound(value, true);
    const atOrBelow = bound(value, false);
    const rank = Math.max(0, Math.min(1, (below + atOrBelow) / 2 / (n - 1)));
    // A flat percentile spends the ramp evenly, which makes half the repo look
    // hot. Bending it keeps the ordering visible while preserving the shape
    // the metric actually has: most files ordinary, a few genuinely loud.
    return Math.pow(rank, 1.5);
  };
}

export interface LensContextOptions {
  lens: Lens;
  churn: Record<string, number>;
  coverage: CoverageMap;
  changedAt: Record<string, number>;
  readAt: Record<string, number>;
  reuse: Record<string, number | null>;
  clusterColor(cluster: string): string;
}

/**
 * Build the colouring context for a lens, including the distribution the
 * ranked lenses are scaled against. One place, so canvas, wheel and districts
 * cannot disagree about what a colour means.
 */
export function buildLensContext(
  nodes: Iterable<GraphNode>,
  options: LensContextOptions,
): LensContext {
  const recency = Object.entries(options.changedAt)
    .filter(([, at]) => at > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([path]) => path);
  const ctx: LensContext = { ...options, recency, rank: () => 0 };
  if (RANKED.has(options.lens)) {
    const values: number[] = [];
    for (const node of nodes) values.push(rawValue(node, ctx));
    ctx.rank = percentileScale(values);
  }
  return ctx;
}

/**
 * How loud is this file under the activity lens?
 *
 * The most recent change is always full brightness, the one before it a step
 * down, and so on — so "what did the agent just touch" is answerable at any
 * point, including an hour later, and the answer does not change unless the
 * files do.
 */
export function activityValue(path: string, ctx: LensContext): number {
  const index = ctx.recency.indexOf(path);
  if (index === -1) return 0;
  if (ctx.recency.length === 1) return 1;
  // the oldest change in the session still reads clearly against the surface
  return 1 - (index / (ctx.recency.length - 1)) * 0.62;
}

/**
 * Has a human opened this file since it last changed? Files that never
 * changed this session count as read — the lens is about *new* code nobody
 * has looked at, not about auditing the whole repo's history.
 */
export function isUnread(path: string, ctx: LensContext): boolean {
  const changed = ctx.changedAt[path] ?? 0;
  if (changed === 0) return false;
  return (ctx.readAt[path] ?? 0) < changed;
}

/** File color under the active lens — shared by canvas, wheel and districts. */
export function lensColor(node: GraphNode, ctx: LensContext): string {
  const clusterColor = ctx.clusterColor(node.cluster);
  switch (ctx.lens) {
    case 'clusters':
      return clusterColor;
    case 'activity':
      return ramp(LENS_HUES.activity!, activityValue(node.id, ctx));
    case 'hotspot':
      return ramp(LENS_HUES.hotspot!, ctx.rank(rawValue(node, ctx)));
    case 'risk':
      return ramp(LENS_HUES.risk!, ctx.rank(rawValue(node, ctx)));
    case 'tests':
      if (node.isTest) return NEUTRAL_SERIES;
      return node.testedBy > 0 ? STATUS.good : STATUS.critical;
    case 'coverage': {
      const cov = ctx.coverage[node.id];
      if (!cov) return mixHex(NEUTRAL_SERIES, SURFACE, 0.6);
      return ramp(LENS_HUES.instability!, cov.pct / 100);
    }
    case 'instability': {
      const total = node.inDegree + node.outDegree;
      return ramp(LENS_HUES.instability!, total === 0 ? 0 : node.outDegree / total);
    }
    case 'reuse': {
      const score = ctx.reuse[node.id];
      // too little in the file to be worth the question — not "unreusable"
      if (score === null || score === undefined) return mixHex(NEUTRAL_SERIES, SURFACE, 0.6);
      return ramp(LENS_HUES.reuse!, score / 100);
    }
    case 'unread':
      if ((ctx.changedAt[node.id] ?? 0) === 0) return mixHex(NEUTRAL_SERIES, SURFACE, 0.6);
      return isUnread(node.id, ctx) ? STATUS.critical : STATUS.good;
    case 'cycles':
      if (node.cycleId === null) return mixHex(NEUTRAL_SERIES, SURFACE, 0.6);
      return [STATUS.critical, '#d95926', '#d55181', '#9085e9'][node.cycleId % 4];
    default:
      return clusterColor;
  }
}

/**
 * Lens intensity 0..1 — how loud this file should be under the active lens.
 * Districts uses it for shading, the canvas for its rail width and glow.
 */
export function lensValue(node: GraphNode, ctx: LensContext, maxCx: number): number {
  switch (ctx.lens) {
    case 'activity':
      return activityValue(node.id, ctx);
    case 'hotspot':
    case 'risk':
      return ctx.rank(rawValue(node, ctx));
    case 'tests':
      return node.isTest ? 0.4 : node.testedBy > 0 ? 0.25 : 0.95;
    case 'coverage':
      return ctx.coverage[node.id] ? 1 - ctx.coverage[node.id].pct / 100 : 0.15;
    case 'instability': {
      const total = node.inDegree + node.outDegree;
      return total === 0 ? 0 : node.outDegree / total;
    }
    case 'reuse': {
      const score = ctx.reuse[node.id];
      return score === null || score === undefined ? 0.08 : score / 100;
    }
    case 'unread':
      if ((ctx.changedAt[node.id] ?? 0) === 0) return 0.08;
      return isUnread(node.id, ctx) ? 1 : 0.3;
    case 'cycles':
      return node.cycleId !== null ? 1 : 0.1;
    default:
      return Math.pow(node.complexity / Math.max(maxCx, 1), 0.5);
  }
}

/**
 * Lenses a folder card averages over its members rather than taking the
 * loudest.
 *
 * Both are ratios, and both have a member in almost every folder that pins the
 * maximum: instability has a pure leaf, coverage a fully-covered file. Taking
 * the loudest made every folder identical and the lens looked broken.
 *
 * Everything else takes the loudest member, which is the only aggregate that
 * answers the question a folded folder is asked. "Did anything in here just
 * change?" is not a question about the average: one file touched inside a
 * twenty-file folder averages to a twentieth of its brightness, which is the
 * surface colour, so a folded folder sat there looking untouched while an
 * agent was writing to it.
 */
const MEAN_AGGREGATE = new Set<Lens>(['instability', 'coverage', 'reuse']);

/** The colour for a folder card, aggregated from its members. */
export function aggregateLens(
  members: readonly GraphNode[],
  ctx: LensContext,
  maxCx: number,
): { value: number; color: string } {
  if (members.length === 0) return { value: 0, color: ctx.clusterColor('') };
  const hue = RAMP_HUE[ctx.lens];
  if (hue && MEAN_AGGREGATE.has(ctx.lens)) {
    const mean = members.reduce((sum, n) => sum + lensValue(n, ctx, maxCx), 0) / members.length;
    return { value: mean, color: ramp(hue, mean) };
  }
  let worst = members[0];
  let best = lensValue(worst, ctx, maxCx);
  for (const node of members) {
    const value = lensValue(node, ctx, maxCx);
    if (value > best) {
      best = value;
      worst = node;
    }
  }
  return { value: best, color: lensColor(worst, ctx) };
}

/**
 * When a lens has nothing to say, say so. A repo with no import cycles renders
 * uniformly grey under the Cycles lens, which is indistinguishable from the
 * lens being broken.
 */
export function lensSignal(nodes: Iterable<GraphNode>, ctx: LensContext): string | null {
  const all = [...nodes];
  if (all.length === 0) return null;
  switch (ctx.lens) {
    case 'cycles':
      return all.some((n) => n.cycleId !== null)
        ? null
        : 'No import cycles in this repo — nothing to highlight, which is the good outcome.';
    case 'unread':
      if (ctx.recency.length === 0) {
        return 'Nothing has changed yet this session, so nothing is unread. Colours appear as soon as you or an agent edits a file.';
      }
      return all.some((n) => isUnread(n.id, ctx))
        ? null
        : 'Every file changed this session has been opened since. No comprehension debt outstanding.';
    case 'activity':
      return ctx.recency.length === 0
        ? 'Nothing has changed yet this session — this lights up the moment a file is written.'
        : null;
    case 'coverage':
      return Object.keys(ctx.coverage).length === 0
        ? 'No lcov.info found. Drop one in coverage/ and this fills in live.'
        : null;
    case 'tests':
      return all.some((n) => n.testedBy > 0)
        ? null
        : 'No test imports any file here, so everything is red. Worth knowing, but the lens cannot rank it.';
    case 'reuse': {
      const scored = all.filter((n) => typeof ctx.reuse[n.id] === 'number');
      if (scored.length === 0) {
        return 'Nothing here has enough in it to score — the reuse question needs files with some logic in them.';
      }
      return null;
    }
    case 'instability': {
      const values = all.map((n) => {
        const total = n.inDegree + n.outDegree;
        return total === 0 ? 0 : n.outDegree / total;
      });
      const spread = Math.max(...values) - Math.min(...values);
      return spread < 0.15 ? 'Every file has a similar fan-in/fan-out ratio — nothing stands out.' : null;
    }
    default:
      return null;
  }
}
