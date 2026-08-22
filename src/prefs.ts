/**
 * Settings that belong to the person rather than to the project.
 *
 * `localStorage`, like the theme choice: these follow the window, not the
 * repository. A browser tab pointed at someone else's machine keeps its own
 * answers, and switching projects does not ask you the same question again.
 * Anything per-project goes in the store instead, over IPC.
 *
 * Every read degrades to the default rather than throwing — a private window
 * with storage refused still gets a working app, it just cannot remember.
 */

const BRIEFING_KEY = 'flare.briefing';

/**
 * Whether to raise "while you were away" on arrival.
 *
 * On unless it has been turned off. The briefing already only appears after a
 * real absence with real agent activity behind it, so someone who has never
 * seen one has not been spared anything — but it *is* a full-screen sheet
 * between someone and their editor, and a surface like that needs an off
 * switch that is not "dismiss it again tomorrow".
 *
 * The answer is deliberately global rather than per-project: people who do
 * not want the interruption do not want it one repository at a time.
 */
export function briefingEnabled(): boolean {
  try {
    return localStorage.getItem(BRIEFING_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setBriefingEnabled(on: boolean): void {
  try {
    localStorage.setItem(BRIEFING_KEY, on ? 'on' : 'off');
  } catch {
    // storage refused: the choice holds for this session and no longer
  }
}
