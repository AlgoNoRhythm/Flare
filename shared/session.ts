import type { ChangeBurst } from './activity';
import { covers } from './channel';

/**
 * What an agent says it did, checked against what Flare watched it do.
 *
 * Everything else in the review answers a question about *one change*: what
 * did this burst touch, did anything verify it, which of its files deserve
 * attention. Nothing answers the question a person actually arrives with —
 * **what happened while I was away** — because that answer does not exist in
 * any single burst. It exists only as a story, and the only participant that
 * knows the story is the agent that lived it.
 *
 * So it is asked for. An agent calls `session_summary` as it finishes and
 * writes the session down as *chapters*: a line of prose per piece of work,
 * and the files each one covers.
 *
 *     Moved the workspace lookup into the graph builder
 *       shared/graph.ts, shared/resolver.ts — the resolver was reading
 *       package.json itself, which meant two places knew the monorepo layout.
 *
 * Which would be worth very little on its own, because a summary is a claim
 * and an agent grading its own homework is the oldest failure mode there is.
 * The value is in the second half: Flare *watched the writes*, so it can bind
 * every chapter to the bursts underneath it and report the three ways a
 * summary and a session disagree —
 *
 * - a chapter names files that **never changed**, so it is describing work
 *   that did not happen;
 * - files changed that **no chapter accounts for**, which is the important
 *   one, because that is where a summary quietly omits the part you would
 *   most want to read;
 * - a chapter's own files were **never verified**, so the prose is confident
 *   about something nothing has checked.
 *
 * The audit goes back to the agent in the tool's reply as well as onto the
 * screen, so the usual outcome is that it fixes its own summary before anyone
 * reads it.
 *
 * Pure, so all of that is testable without a session.
 */

export type ChapterOutcome = 'done' | 'partial' | 'abandoned';

export interface Chapter {
  /** one line: the piece of work, as a person would name it */
  title: string;
  /** why, and what it commits the codebase to */
  detail: string;
  /** the files it covers — what binds the prose to the diff */
  paths: string[];
  outcome: ChapterOutcome;
}

export interface SessionSummary {
  id: string;
  /** the roster identity of whoever wrote it — `mcp:<session>` or 'you' */
  by: string;
  byName: string;
  at: number;
  /**
   * The window it speaks for: its author's first write of the session to its
   * last. Derived rather than claimed — an agent asked for the times would
   * have to guess them, and a summary whose window is wrong audits against
   * the wrong changes.
   */
  from: number;
  to: number;
  headline: string;
  chapters: Chapter[];
}

export const OUTCOME_LABEL: Record<ChapterOutcome, string> = {
  done: 'done',
  partial: 'partly done',
  abandoned: 'abandoned',
};

/** Which bursts a summary is answerable for: its author's, in its window. */
export function burstsFor(
  summary: Pick<SessionSummary, 'by' | 'from' | 'to'>,
  bursts: readonly ChangeBurst[],
): ChangeBurst[] {
  return bursts.filter((b) => {
    if (b.endedAt < summary.from || b.endedAt > summary.to) return false;
    return b.agentId ? b.agentId === summary.by : b.agent === summary.by;
  });
}

export interface ChapterAudit {
  chapter: Chapter;
  /** files it named that really did change */
  changed: string[];
  /** files it named that never changed — work it describes that did not happen */
  absent: string[];
  /** whether anything ran after the last of those changes */
  verified: 'passed' | 'failed' | 'unchecked';
}

export interface SummaryAudit {
  chapters: ChapterAudit[];
  /**
   * Files this author changed that no chapter mentions.
   *
   * The line that makes the rest of it worth reading: a summary is only as
   * good as what it leaves out, and this is the only way to see what it left
   * out.
   */
  unaccounted: string[];
  /** how much of the session the prose actually covers */
  accounted: number;
  total: number;
}

export function auditSummary(
  summary: SessionSummary,
  bursts: readonly ChangeBurst[],
): SummaryAudit {
  const mine = burstsFor(summary, bursts);
  const changedAt = new Map<string, number>();
  for (const burst of mine) {
    for (const path of [...burst.changed, ...burst.removed]) {
      const at = changedAt.get(path);
      if (at === undefined || burst.endedAt > at) changedAt.set(path, burst.endedAt);
    }
  }

  const claimed = new Set<string>();
  const chapters = summary.chapters.map((chapter): ChapterAudit => {
    const changed: string[] = [];
    const absent: string[] = [];
    for (const named of chapter.paths) {
      // a chapter may name a folder; everything under it that changed counts
      const hits = [...changedAt.keys()].filter((p) => covers(named, p));
      if (hits.length === 0) absent.push(named);
      for (const hit of hits) {
        claimed.add(hit);
        if (!changed.includes(hit)) changed.push(hit);
      }
    }
    return { chapter, changed, absent, verified: verdictFor(changed, changedAt, mine) };
  });

  return {
    chapters,
    unaccounted: [...changedAt.keys()].filter((p) => !claimed.has(p)),
    accounted: claimed.size,
    total: changedAt.size,
  };
}

/**
 * Did anything check the files in this chapter?
 *
 * Read off the burst that last wrote each of them, because that is where
 * verification is already decided — a chapter is confident prose, and prose
 * over an unverified change is the combination worth marking.
 */
function verdictFor(
  changed: readonly string[],
  changedAt: ReadonlyMap<string, number>,
  bursts: readonly ChangeBurst[],
): ChapterAudit['verified'] {
  let sawPass = false;
  for (const path of changed) {
    const at = changedAt.get(path);
    const burst = bursts.find((b) => b.endedAt === at && [...b.changed, ...b.removed].includes(path));
    if (!burst) continue;
    if (burst.verification === 'failed') return 'failed';
    if (burst.verification === 'passed') sawPass = true;
    else return 'unchecked';
  }
  return sawPass ? 'passed' : 'unchecked';
}

/**
 * The audit as the sentence the agent is handed back.
 *
 * Written to be acted on rather than filed: an agent that reads "you did not
 * mention 3 files" while it is still running can say what they were, and the
 * summary a person eventually reads is the corrected one.
 */
export function formatAudit(audit: SummaryAudit): string {
  const lines: string[] = [];
  lines.push(
    audit.total === 0
      ? 'Flare did not attribute any file changes to you in this window, so there is nothing to check this against.'
      : `Your chapters account for ${audit.accounted} of the ${audit.total} files you changed.`,
  );
  for (const entry of audit.chapters) {
    if (entry.absent.length > 0) {
      const one = entry.absent.length === 1;
      lines.push(
        `  "${entry.chapter.title}" names ${entry.absent.join(', ')}, which never changed — say what you actually did to ${
          one ? 'it' : 'them'
        }, or drop ${one ? 'it' : 'them'}.`,
      );
    }
    if (entry.verified === 'failed') {
      lines.push(`  "${entry.chapter.title}" covers files whose last check FAILED.`);
    } else if (entry.verified === 'unchecked' && entry.changed.length > 0) {
      lines.push(`  "${entry.chapter.title}" covers files nothing has checked since they changed.`);
    }
  }
  if (audit.unaccounted.length > 0) {
    lines.push(
      `  Not mentioned anywhere: ${audit.unaccounted.slice(0, 12).join(', ')}${
        audit.unaccounted.length > 12 ? ` +${audit.unaccounted.length - 12}` : ''
      }. Add a chapter for ${audit.unaccounted.length === 1 ? 'it' : 'them'}, or say why ${
        audit.unaccounted.length === 1 ? 'it' : 'they'
      } changed.`,
    );
  }
  return lines.join('\n');
}
