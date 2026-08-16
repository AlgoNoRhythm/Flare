/**
 * The palette the canvas draws with — read from the stylesheet, not restated.
 *
 * These used to be hard-coded hexes here, which meant a colour existed in two
 * places (this file and styles.css) with nothing keeping them in step but
 * attention. A theme could then only ever cover the chrome: the graph, which is
 * the thing the app is actually for, would stay dark whatever the CSS said.
 *
 * So the stylesheet is the single source of truth and this reads it. The
 * exported objects are live — mutated in place when the theme changes rather
 * than replaced — so the fifty-odd call sites that say `STATUS.critical` keep
 * working and pick up the new value on their next render.
 */

/** What is actually painted. */
export type ThemeName = 'dark' | 'light';
/** What was chosen — which may be "whatever the machine says". */
export type ThemeChoice = ThemeName | 'system';

/*
 * System is offered rather than assumed.
 *
 * Falling back to the OS silently is the right default and the wrong secret:
 * someone whose desktop is light would open the app light, find no light mode
 * switched on anywhere, and have no way to know why. Naming it makes the
 * default explainable and pinning it a deliberate act.
 */
export const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'Match System' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
];

/** Where the choice is remembered. A theme belongs to whoever is looking. */
const STORAGE_KEY = 'flare.theme';

/*
 * Defaults, for the moment before the stylesheet can be read.
 *
 * Tests and the node-side code import this module without a document; so does
 * the first tick of the app, before the sheet is parsed. These are the dark
 * values, and they are overwritten by the real ones as soon as there is a
 * document to read them from.
 */
export const CATEGORICAL = [
  '#7c9fca', // blue
  '#c78e77', // orange
  '#69c2a3', // aqua
  '#c3a66d', // yellow
  '#ca7e9a', // magenta
  '#60be60', // green
  '#938bd0', // violet
  '#cd8585', // red
];

export const STATUS = {
  good: '#4ac94a',
  warning: '#d1ae64',
  serious: '#d58d72',
  critical: '#d03b3b',
};

/**
 * The same four meanings, a step down in saturation, for panels and tables.
 *
 * On the graph a colour *is* the datum — one red card among ninety has to
 * carry across the board. In a details panel or a metrics table the same
 * values arrive dozens at a time next to running text, and full-strength
 * status colours turn a calm surface into a warning light.
 */
export const UI_STATUS = {
  good: '#63ab7a',
  warning: '#d3a44e',
  serious: '#cf8f68',
  critical: '#d97b7b',
};

export const INK = {
  primary: '#e6e9ee',
  secondary: '#c5cbd4',
  muted: '#828a97',
  grid: '#2d333e',
};

/** Surfaces and lines the canvas paints itself, rather than inheriting. */
const CANVAS = {
  surface: '#15181e',
  panel: '#111318',
  neutralSeries: '#8a8f98',
  info: '#86b6ef',
};

/*
 * Functions rather than constants for the four that are plain strings: a
 * string export cannot be updated in place, and a stale surface colour is the
 * one that shows — every ramp in lensColor mixes toward it.
 */
export const surface = (): string => CANVAS.surface;
export const panel = (): string => CANVAS.panel;
export const neutralSeries = (): string => CANVAS.neutralSeries;
export const info = (): string => CANVAS.info;

/** What the stylesheet currently says a token is. */
function readToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

/**
 * Pull the palette out of the stylesheet, in place.
 *
 * Called once at startup and again on every theme change. In place because the
 * alternative is exporting getters and touching all fifty call sites — and
 * because every one of them reads at render time, so a mutated object is seen
 * by the next paint and by nothing earlier.
 */
export function refreshPalette(): void {
  for (let i = 0; i < CATEGORICAL.length; i++) {
    CATEGORICAL[i] = readToken(`--cat-${i + 1}`, CATEGORICAL[i]);
  }
  STATUS.good = readToken('--sig-good', STATUS.good);
  STATUS.warning = readToken('--sig-warn', STATUS.warning);
  STATUS.serious = readToken('--sig-serious', STATUS.serious);
  STATUS.critical = readToken('--sig-crit', STATUS.critical);

  UI_STATUS.good = readToken('--good', UI_STATUS.good);
  UI_STATUS.warning = readToken('--warn', UI_STATUS.warning);
  UI_STATUS.serious = readToken('--accent-muted', UI_STATUS.serious);
  UI_STATUS.critical = readToken('--crit', UI_STATUS.critical);

  // the graph's ink and grid come off the ramp, so they cannot drift from the
  // panel they sit next to
  INK.primary = readToken('--n13', INK.primary);
  INK.secondary = readToken('--n12', INK.secondary);
  INK.muted = readToken('--n10', INK.muted);
  INK.grid = readToken('--n6', INK.grid);

  CANVAS.surface = readToken('--n2', CANVAS.surface);
  CANVAS.panel = readToken('--n1', CANVAS.panel);
  CANVAS.neutralSeries = readToken('--cat-neutral', CANVAS.neutralSeries);
  CANVAS.info = readToken('--info', CANVAS.info);
}

// ---------------------------------------------------------------- switching

type Listener = (theme: ThemeName) => void;
const listeners = new Set<Listener>();

export function currentTheme(): ThemeName {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** What the machine says, when the choice is to follow it. */
function systemTheme(): ThemeName {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function resolveChoice(choice: ThemeChoice): ThemeName {
  return choice === 'system' ? systemTheme() : choice;
}

/**
 * Put a theme on, and tell everything that cannot read CSS about it.
 *
 * The attribute is what actually repaints the app — every rule in the
 * stylesheet resolves against whichever palette block matches. The rest of
 * this is for the three places that draw outside CSS: the canvas, Monaco and
 * the terminal.
 */
export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  const theme = resolveChoice(choice);
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // a viewer with storage disabled still gets the theme, just not next time
  }
  refreshPalette();
  for (const listener of listeners) listener(theme);
}

/**
 * Follow the desktop when it changes, for as long as that is the choice.
 *
 * Someone on a machine that switches at sunset expects the editor to switch
 * with it. Registered once, at startup, and it does nothing unless the stored
 * choice is still "system".
 */
export function watchSystemTheme(): void {
  try {
    window
      .matchMedia('(prefers-color-scheme: light)')
      .addEventListener('change', () => {
        if (storedChoice() === 'system') applyTheme('system');
      });
  } catch {
    // no matchMedia: the choice is whatever was pinned
  }
}

/**
 * The remembered choice, or what the machine already prefers.
 *
 * Falling back to the OS rather than to dark: someone running a light desktop
 * has already answered this question once, and an IDE that ignores it is the
 * one window on the screen that does. `public/early-theme.js` decides the same
 * thing a few milliseconds earlier, before anything is painted — the two have
 * to agree.
 */
export function storedChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    /*
     * Dark unless you said otherwise.
     *
     * This used to fall back to 'system', so the app wore whatever the desktop
     * preferred and a light desktop never saw the palette the product is
     * designed in. Dark is the default identity; 'system' is still a choice
     * you can make, it is just no longer made for you.
     */
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark';
  } catch {
    return 'dark';
  }
}

export function onThemeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable cluster -> color assignment in first-seen order; overflow is neutral. */
export function makeClusterColors(): (cluster: string) => string {
  const assigned = new Map<string, number>();
  return (cluster: string) => {
    let slot = assigned.get(cluster);
    if (slot === undefined) {
      slot = assigned.size < CATEGORICAL.length ? assigned.size : -1;
      assigned.set(cluster, slot);
    }
    // resolved on every call, not when the cluster was first seen: the
    // assignment is what has to be stable across a theme change, not the hex
    return slot === -1 ? CANVAS.neutralSeries : CATEGORICAL[slot];
  };
}

/** Mix two hex colors; t in [0,1] toward `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}
