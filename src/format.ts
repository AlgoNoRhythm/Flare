/**
 * Number and label formatting for anything the user reads.
 *
 * The rule this file exists to enforce: a number shown on its own has to carry
 * its own meaning. A count needs a unit, a composite score needs its scale, and
 * a raw metric needs something to compare it against — otherwise "complexity
 * 131" is a fact the reader cannot act on.
 */

/**
 * Grouped thousands, always in the same style.
 *
 * `toLocaleString()` with no argument follows the OS locale, so on an
 * Italian-configured machine 17024 rendered as "17.024" — which in an
 * English-language UI reads as seventeen. The app's copy is English, so its
 * numbers are grouped in English regardless of the host.
 */
export function num(n: number): string {
  return n.toLocaleString('en-US');
}

/** "1 file" / "2 files" — plural agreement, since off-by-one copy reads as a bug. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${num(n)} ${n === 1 ? singular : pluralForm}`;
}

/**
 * "12s ago" / "4m ago" / "2h ago", then the date.
 *
 * Anything from this session is worth reading as an elapsed time — "did that
 * happen while I was looking at this file?" is the question being asked — and
 * anything older is worth reading as a date.
 */
export function ago(time: number): string {
  const s = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(time).toLocaleDateString();
}

/**
 * Where `value` sits in `values`, 0..1. Used to turn a raw metric into a
 * statement about this repo: 131 means nothing, "higher than 94% of files
 * here" means something.
 */
export function percentileOf(values: readonly number[], value: number): number {
  if (values.length === 0) return 0;
  let below = 0;
  for (const v of values) if (v < value) below++;
  return below / values.length;
}

/** The percentile as copy, or null when the comparison would not be worth making. */
export function rankNote(values: readonly number[], value: number): string | null {
  if (values.length < 8) return null;
  const pct = Math.round(percentileOf(values, value) * 100);
  if (pct >= 90) return `higher than ${pct}% of files here`;
  if (pct <= 40) return 'in the ordinary range here';
  return `higher than ${pct}% of files here`;
}

export type Band = 'low' | 'elevated' | 'high' | 'severe';

/**
 * The word for a 0–100 composite. The bands match the colour thresholds used
 * by the metrics table, so the word and the colour never disagree.
 */
export function band(score: number): Band {
  if (score >= 85) return 'severe';
  if (score >= 70) return 'high';
  if (score >= 40) return 'elevated';
  return 'low';
}

/** "61/100 · high" — the scale and the reading, so neither has to be guessed. */
export function scoreLabel(score: number): string {
  return `${score}/100 · ${band(score)}`;
}
