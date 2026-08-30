import type { CommandOutcome } from './commands';
import type { Smell } from './smells';
import type { CommandLogEntry } from './types';

/**
 * A change burst — one batch of file writes attributed to one author — plus
 * the evidence that it was verified.
 *
 * The IDE sees both halves: the watcher knows exactly when files changed, and
 * the terminals know exactly which commands ran and what they printed. Joining
 * them answers the question review is actually for: *was this checked?*
 */

export type VerificationState =
  /** a verification command ran after the last edit and passed */
  | 'passed'
  /** …and failed */
  | 'failed'
  /** …and we could not read a verdict from its output */
  | 'unknown'
  /** a verification command is running right now */
  | 'running'
  /** tests ran, but more files were edited afterwards — the evidence is out of date */
  | 'stale'
  /** nothing was run at all */
  | 'not-run';

export interface VerificationEvidence {
  command: string;
  outcome: CommandOutcome;
  evidence: string | null;
  at: number;
  agent: string | null;
}

export interface BurstIntent {
  /** what the agent said it was trying to do */
  goal: string;
  /** alternatives it considered and rejected, if it said */
  ruledOut?: string;
  at: number;
  source: 'agent' | 'you';
}

export interface ChangeBurst {
  id: string;
  startedAt: number;
  /** time of the last file write in this burst */
  endedAt: number;
  /** the *tool* that made it: 'claude', 'you', or 'mixed' when we could not tell */
  agent: string;
  /**
   * Terminal-scoped identity, when the session could pin one down — two
   * `claude` sessions are two agents, and `agent` alone cannot say that.
   * Absent on bursts from before the terminal was known, so readers that care
   * about *who* should go through `agentIdOf` in shared/conflicts.ts.
   */
  agentId?: string;
  /**
   * Who it was — 'Claude 2' — when the write reached an MCP session we know.
   *
   * Separate from `agentLabel` because they answer different questions and a
   * review needs both: *who* did this, and *what* were they doing. Absent when
   * attribution never got past the tool name.
   */
  agentName?: string;
  /** What to call that agent: the board task it claimed, else the tool name. */
  agentLabel?: string;
  changed: string[];
  removed: string[];
  smells: Smell[];
  verification: VerificationState;
  verifiedBy: VerificationEvidence | null;
  /** verification commands seen for this burst, oldest first */
  checks: VerificationEvidence[];
  intent: BurstIntent | null;
  /** shadow snapshot taken right after the burst — the revert target */
  snapshotHash: string | null;
}

export const VERIFICATION_LABEL: Record<VerificationState, string> = {
  passed: 'verified',
  failed: 'checks failed',
  unknown: 'ran, no verdict',
  running: 'checking…',
  stale: 'checked, then edited again',
  'not-run': 'never checked',
};

/**
 * How a verification state reads as colour.
 *
 * Here rather than in the review panel because the time machine paints the
 * same verdict on the same change — a tick that says "green" over a burst the
 * list below calls "never checked" is worse than no colour at all.
 */
export const VERIFY_TONE: Record<VerificationState, 'good' | 'warn' | 'crit' | 'muted'> = {
  passed: 'good',
  failed: 'crit',
  'not-run': 'crit',
  stale: 'warn',
  unknown: 'warn',
  running: 'muted',
};

export const VERIFICATION_HINT: Record<VerificationState, string> = {
  passed: 'A test or type check ran after the last edit in this burst and passed.',
  failed: 'A test or type check ran after the last edit and failed. This change is known-broken.',
  unknown: 'Something ran after the last edit, but its output had no verdict we could read.',
  running: 'A verification command is still running.',
  stale: 'Checks ran during this burst, but files were edited afterwards — nothing has verified the final state.',
  'not-run': 'No test, type check or lint ran after these files changed. Nothing has checked this.',
};

/**
 * Decide whether a burst was verified, using the commands observed in the
 * terminals. `commands` may contain everything; only verification commands
 * that started at or after the burst are considered.
 */
export function verificationFor(
  burst: { startedAt: number; endedAt: number },
  commands: readonly CommandLogEntry[],
  /** commands started before this cutoff belong to the burst window */
  nextBurstAt = Infinity,
): { state: VerificationState; by: VerificationEvidence | null; checks: VerificationEvidence[] } {
  const inWindow = commands.filter(
    (c) => c.kind === 'verify' && c.time >= burst.startedAt && c.time < nextBurstAt,
  );
  const checks: VerificationEvidence[] = inWindow.map((c) => ({
    command: c.command,
    outcome: c.outcome ?? 'unknown',
    evidence: c.evidence ?? null,
    at: c.time,
    agent: c.agent,
  }));

  // only a run that started after the *last* edit can vouch for the final state
  const after = inWindow.filter((c) => c.time >= burst.endedAt);
  if (after.length === 0) {
    return { state: inWindow.length > 0 ? 'stale' : 'not-run', by: null, checks };
  }
  if (after.some((c) => c.endedAt === undefined)) {
    return { state: 'running', by: null, checks };
  }
  const latest = after.reduce((a, b) => (b.time >= a.time ? b : a));
  const by: VerificationEvidence = {
    command: latest.command,
    outcome: latest.outcome ?? 'unknown',
    evidence: latest.evidence ?? null,
    at: latest.time,
    agent: latest.agent,
  };
  // a failure anywhere after the last edit outranks a later pass: something
  // was broken and we cannot tell from the outside whether it was fixed
  const failed = after.find((c) => c.outcome === 'fail');
  if (failed) {
    return {
      state: 'failed',
      by: {
        command: failed.command,
        outcome: 'fail',
        evidence: failed.evidence ?? null,
        at: failed.time,
        agent: failed.agent,
      },
      checks,
    };
  }
  return { state: by.outcome === 'pass' ? 'passed' : 'unknown', by, checks };
}

/** Newest burst whose verification passed — the "back to last green" target. */
export function lastGreen(bursts: readonly ChangeBurst[]): ChangeBurst | null {
  for (let i = bursts.length - 1; i >= 0; i--) {
    if (bursts[i].verification === 'passed' && bursts[i].snapshotHash) return bursts[i];
  }
  return null;
}

/** One-line summary for the status bar / review header. */
export function unverifiedCount(bursts: readonly ChangeBurst[]): number {
  return bursts.filter((b) => b.verification === 'not-run' || b.verification === 'stale' || b.verification === 'failed')
    .length;
}
