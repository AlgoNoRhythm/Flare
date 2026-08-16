/**
 * Where the window should open.
 *
 * Pure, and separate from the shell, because every interesting case here is
 * one you cannot reproduce by launching the app: a monitor that has been
 * unplugged, a size saved on a screen twice this one, a default that changed
 * three versions ago and is still being restored.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoundsInput {
  /** the primary display's usable area */
  work: { width: number; height: number };
  /** every display's work area, for the still-visible check */
  displays: readonly Rect[];
  saved?: Rect;
  /** whether a human ever dragged or resized the window */
  userSet?: boolean;
}

/**
 * How much of the screen a window with no history should take.
 *
 * Nearly all of it. The graph is what this window is for and the first thing
 * to suffer when the window is small; the margin only exists so the window
 * still reads as a window.
 */
export const DEFAULT_FILL = 0.97;

/**
 * At least this much of the window has to land on a real display, or the
 * title bar comes up somewhere you cannot reach it.
 */
const VISIBLE_MARGIN_X = 80;
const VISIBLE_MARGIN_Y = 40;

export function stillVisible(saved: Rect, displays: readonly Rect[]): boolean {
  return displays.some(
    (a) =>
      saved.x + saved.width > a.x + VISIBLE_MARGIN_X &&
      saved.x < a.x + a.width - VISIBLE_MARGIN_X &&
      saved.y + VISIBLE_MARGIN_Y > a.y &&
      saved.y < a.y + a.height - VISIBLE_MARGIN_Y,
  );
}

/**
 * The bounds to open with.
 *
 * Remembered bounds are used only when `userSet` says a human chose them.
 * Bounds are saved on every close, so a window nobody ever touched persists
 * whatever the default was the day it was first opened — and that stale
 * default then outranks every later one, which is how a size cap that has
 * since been removed goes on applying forever.
 */
export function initialBounds(input: BoundsInput): { x?: number; y?: number; width: number; height: number } {
  const { work, displays, saved, userSet } = input;

  if (userSet && saved && saved.width > 0 && saved.height > 0 && stillVisible(saved, displays)) {
    return {
      x: saved.x,
      y: saved.y,
      // a size from a larger screen is clamped rather than discarded: the
      // position is still meaningful even when the size no longer fits
      width: Math.min(saved.width, work.width),
      height: Math.min(saved.height, work.height),
    };
  }

  return {
    width: Math.round(work.width * DEFAULT_FILL),
    height: Math.round(work.height * DEFAULT_FILL),
  };
}
