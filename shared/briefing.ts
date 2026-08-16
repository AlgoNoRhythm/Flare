import type { ChangeBurst } from './activity';
import { agentIdOf, type Conflict } from './conflicts';
import type { Decision, Question } from './tasks';

/**
 * What happened while you were away.
 *
 * Every other surface in this app answers "what is true now?". This one
 * answers a different question — *what changed since I last looked* — and it
 * is the question several agents working overnight actually leave you with.
 * Reconstructing it from the review list means reading forty bursts to find
 * the three that matter.
 *
 * The whole design pressure here is **subtraction**. A digest that lists
 * everything is the review panel with worse typography; what makes it worth
 * opening is that it is short enough to finish. So:
 *
 * - **Five rows, hard.** Not "five by default" — five. The counts line says
 *   how much there was; the rows say what to do about it. A sixth row is how
 *   this becomes a dashboard.
 * - **Every row is something that wants an answer**, ranked by whether
 *   ignoring it costs you anything. Crossings first, because they are the only
 *   thing here that no other view would have shown you; then questions, which
 *   are agents actually blocked; then one ✓ line for everything that went
 *   fine, because "83 files changed and all of it passed" is information too.
 * - **Never a stat tile.** The counts are one sentence of prose. The moment
 *   they become a row of numbers in boxes, the eye reads the boxes and the
 *   rows stop being the point.
 *
 * It returns `null` when there is nothing to say, and the caller shows
 * nothing. An "inbox" you can navigate to and find empty stops being read
 * within a week, which is why this is a state you *arrive* in rather than a
 * tab you can visit.
 */

export type BriefingRowKind = 'conflict' | 'question' | 'clear';

export interface BriefingRow {
  id: string;
  kind: BriefingRowKind;
  /** the headline, quantified — one line, never wrapped past two */
  text: string;
  /** the sentence under it */
  detail: string;
  /** where clicking it goes */
  paths: string[];
  conflict?: Conflict;
  question?: Question;
}

export interface Briefing {
  /** the moment you were last here */
  since: number;
  /** how many distinct agents wrote anything */
  agents: number;
  /** first write to last write */
  workedMs: number;
  files: number;
  changes: number;
  decisions: number;
  conflicts: number;
  questions: number;
  /** rows, worst first, capped */
  rows: BriefingRow[];
  /** how many things want an answer — may exceed the rows shown */
  needsYou: number;
  /** nothing wants an answer: the calm version, still worth showing */
  quiet: boolean;
}

export interface BriefingInput {
  since: number;
  bursts: readonly ChangeBurst[];
  conflicts: readonly Conflict[];
  questions: readonly Question[];
  decisions: readonly Decision[];
}

/** Five. See the note above — this is the point of the whole surface. */
export const BRIEFING_ROWS = 5;

/**
 * How long you have to have been gone before there is a "while you were away".
 *
 * Twenty minutes: long enough that stepping out for coffee does not produce a
 * ceremony, short enough that it catches the case this is for.
 */
export const ABSENCE_MS = 20 * 60_000;

/**
 * Whether anything happened worth greeting you with.
 *
 * Both halves matter. Being away is not enough — an empty repo you left open
 * overnight has nothing to report — and neither is activity, because changes
 * you sat and watched an agent make are not news.
 */
export function shouldBrief(input: { since: number; now: number; bursts: readonly ChangeBurst[] }): boolean {
  const { since, now, bursts } = input;
  if (since <= 0) return false;
  if (now - since < ABSENCE_MS) return false;
  return bursts.some((b) => b.endedAt > since && b.agent !== 'you');
}

export function briefing(input: BriefingInput): Briefing | null {
  const { since, bursts, conflicts, questions, decisions } = input;

  const fresh = bursts.filter((b) => b.endedAt > since && b.agent !== 'you');
  if (fresh.length === 0) return null;

  const files = new Set<string>();
  const agents = new Set<string>();
  for (const burst of fresh) {
    for (const path of burst.changed) files.add(path);
    agents.add(agentIdOf(burst));
  }

  const freshConflicts = conflicts.filter((c) => c.at > since);
  const openQuestions = questions.filter((q) => q.answeredAt === null && q.at > since);
  const freshDecisions = decisions.filter((d) => d.at > since);

  const rows: BriefingRow[] = [];
  for (const conflict of freshConflicts) {
    rows.push({
      id: conflict.id,
      kind: 'conflict',
      text: conflict.summary,
      detail: conflict.detail,
      paths: conflict.paths,
      conflict,
    });
  }
  for (const question of openQuestions) {
    rows.push({
      id: question.id,
      kind: 'question',
      text: question.text,
      detail:
        question.blocks.length > 0
          ? `${question.blocks.length} task${question.blocks.length === 1 ? '' : 's'} parked on this`
          : question.detail,
      paths: [],
      question,
    });
  }

  const needsYou = rows.length;

  /*
   * The good news is one row, not a section.
   *
   * It exists so the briefing is not only ever bad news — an agent that
   * finished four cards cleanly should be visible — but it is the last thing
   * that gets space, and it is never allowed to push out something that wants
   * an answer.
   */
  const verified = fresh.filter((b) => b.verification === 'passed').length;
  const trimmed = rows.slice(0, needsYou >= BRIEFING_ROWS ? BRIEFING_ROWS : BRIEFING_ROWS - 1);
  if (trimmed.length < BRIEFING_ROWS) {
    trimmed.push({
      id: 'clear',
      kind: 'clear',
      text:
        verified > 0
          ? `${verified} of ${fresh.length} change${fresh.length === 1 ? '' : 's'} verified`
          : `${fresh.length} change${fresh.length === 1 ? '' : 's'}, none verified`,
      detail:
        verified === fresh.length
          ? 'Everything that ran, passed.'
          : 'The rest had no test run after the last edit — the review panel says which.',
      paths: [],
    });
  }

  return {
    since,
    agents: agents.size,
    workedMs: fresh[fresh.length - 1].endedAt - fresh[0].startedAt,
    files: files.size,
    changes: fresh.length,
    decisions: freshDecisions.length,
    conflicts: freshConflicts.length,
    questions: openQuestions.length,
    rows: trimmed,
    needsYou,
    quiet: needsYou === 0,
  };
}

/** "6h 20m", "45m" — the shape of the night, not a duration to the second. */
export function spanLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
