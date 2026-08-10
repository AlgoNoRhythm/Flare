import type { ChangeBurst } from './activity';
import { reviewTier, uncovered, type TierInput } from './review';

/**
 * Which changes are worth interrupting someone for.
 *
 * The review cockpit is where changes are read, but it is a tab: an agent can
 * rewrite the file forty others import while you are looking at the graph, and
 * nothing on screen says so until you go and look. These are the changes that
 * earn a popup — the same tiering the review panel uses, filtered down to the
 * ones a person would actually want pulled to the front of their attention.
 *
 * Two gates, and both matter:
 *
 * - the file tiers **careful** — Flare's existing definition of a change that
 *   needs the whole diff read.
 * - and something *absolute* is true of it: real dependents, an import cycle,
 *   real complexity, or no test at all. The risk composite is a ranking within
 *   the repo, so its top file scores 100 whatever the repo is like; without
 *   this second gate every project would pop an alert for its least boring
 *   file the first time anything was edited.
 *
 * Deleted files are deliberately not alerted on: they are gone from the graph,
 * so there are no metrics to judge them by. The burst still lists them.
 */

export interface RiskAlert {
  /** stable per file per burst, so one edit never queues twice */
  id: string;
  path: string;
  burstId: string;
  /** when the burst that touched it ended */
  at: number;
  agent: string;
  /** why it is risky, worst first — the same words the review rows use */
  reasons: string[];
  /** regression-risk composite, 0..100 within this repo */
  risk: number;
  /** when the burst began — the cut-off for finding the state to diff against */
  startedAt: number;
}

export interface RiskAlertInput {
  /** oldest first, as the activity service reports them */
  bursts: readonly ChangeBurst[];
  /** tiering inputs per file, by path */
  metrics: ReadonlyMap<string, TierInput>;
  /** review.approvedAt — a file already dealt with does not queue */
  approvedAt?: Record<string, number>;
  /** alert ids already dismissed */
  dismissed?: ReadonlySet<string>;
  /** how many to keep queued */
  limit?: number;
}

/**
 * Enough to read as "several", not enough to become a wall. Past this the
 * oldest fall off: an alert nobody has looked at in twenty changes has been
 * answered by the review tab, not by a popup.
 */
export const ALERT_LIMIT = 20;

export function alertId(burstId: string, path: string): string {
  return `${burstId}::${path}`;
}

/** The absolute half of the test — see the note at the top of the file. */
function concretelyRisky(m: TierInput): boolean {
  return m.blastRadius >= 3 || m.inCycle || m.complexity >= 40 || (uncovered(m) && m.fanIn >= 2);
}

/**
 * The queue, newest first.
 *
 * A file edited three times queues once, for its most recent burst: the alert
 * is about the file's current state, and three cards for one file would push
 * the other two files off the screen.
 */
export function riskAlerts(input: RiskAlertInput): RiskAlert[] {
  const { bursts, metrics, approvedAt = {}, dismissed, limit = ALERT_LIMIT } = input;
  const out: RiskAlert[] = [];
  const seen = new Set<string>();

  for (let i = bursts.length - 1; i >= 0; i--) {
    const burst = bursts[i];
    for (const path of burst.changed) {
      if (seen.has(path)) continue;
      seen.add(path);

      // no metrics: gone from the graph, so there is nothing to judge.
      // a test: the thing it protects is what would be worth interrupting for.
      const m = metrics.get(path);
      if (!m || m.isTest) continue;

      const { tier, reasons } = reviewTier(m);
      if (tier !== 'careful' || !concretelyRisky(m)) continue;

      // approved after this burst: someone has already been through it
      if ((approvedAt[path] ?? 0) >= burst.endedAt) continue;

      const id = alertId(burst.id, path);
      if (dismissed?.has(id)) continue;

      out.push({
        id,
        path,
        burstId: burst.id,
        at: burst.endedAt,
        agent: burst.agent,
        reasons,
        risk: m.risk,
        startedAt: burst.startedAt,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
