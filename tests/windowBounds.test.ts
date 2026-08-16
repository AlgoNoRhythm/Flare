import { describe, expect, it } from 'vitest';
import { DEFAULT_FILL, initialBounds, stillVisible } from '../electron/services/windowBounds';

/**
 * Where the window opens.
 *
 * Every case worth testing here is one you cannot reproduce by launching the
 * app: a monitor since unplugged, a size saved on a screen twice this one, and
 * a default from three versions ago that is still being restored.
 */

const HD = { width: 1920, height: 1080 };
const UHD = { width: 3840, height: 2160 };
const one = [{ x: 0, y: 0, width: 1920, height: 1080 }];

describe('a window nobody has sized', () => {
  it('takes the screen it is given, however big that is', () => {
    expect(initialBounds({ work: UHD, displays: one })).toEqual({
      width: Math.round(3840 * DEFAULT_FILL),
      height: Math.round(2160 * DEFAULT_FILL),
    });
  });

  it('opens centred — no x/y — so the shell can place it', () => {
    expect(initialBounds({ work: HD, displays: one }).x).toBeUndefined();
  });

  /*
   * The bug this rule exists for. Bounds are saved on every close, so an
   * untouched window persists whatever the default was the day it first ran;
   * without `userSet` that stale default outranks every later one, and a size
   * cap removed in one version goes on applying forever.
   */
  it('ignores bounds it saved itself, so an old default cannot outlive its version', () => {
    const stale = { x: 40, y: 40, width: 2400, height: 1500 };
    expect(initialBounds({ work: UHD, displays: one, saved: stale })).toEqual({
      width: Math.round(3840 * DEFAULT_FILL),
      height: Math.round(2160 * DEFAULT_FILL),
    });
  });
});

describe('a window someone sized', () => {
  const saved = { x: 100, y: 80, width: 1200, height: 800 };

  it('is left exactly where they put it', () => {
    expect(initialBounds({ work: HD, displays: one, saved, userSet: true })).toEqual(saved);
  });

  it('is clamped, not discarded, when it came from a bigger screen', () => {
    const huge = { x: 10, y: 10, width: 3400, height: 1900 };
    expect(initialBounds({ work: HD, displays: one, saved: huge, userSet: true })).toEqual({
      x: 10,
      y: 10,
      width: 1920,
      height: 1080,
    });
  });

  it('falls back to the default when its monitor is gone', () => {
    // saved on a second display off to the right that is no longer plugged in
    const offscreen = { x: 2600, y: 200, width: 1200, height: 800 };
    const out = initialBounds({ work: HD, displays: one, saved: offscreen, userSet: true });
    expect(out.x).toBeUndefined();
    expect(out.width).toBe(Math.round(1920 * DEFAULT_FILL));
  });
});

describe('stillVisible', () => {
  it('accepts a window with a real corner on a display', () => {
    expect(stillVisible({ x: 1800, y: 900, width: 800, height: 600 }, one)).toBe(true);
  });

  it('rejects one that is entirely past the right edge', () => {
    expect(stillVisible({ x: 2000, y: 100, width: 800, height: 600 }, one)).toBe(false);
  });

  it('rejects one hanging below the bottom', () => {
    expect(stillVisible({ x: 100, y: 1100, width: 800, height: 600 }, one)).toBe(false);
  });

  it('finds it on a second display when there is one', () => {
    const two = [...one, { x: 1920, y: 0, width: 1920, height: 1080 }];
    expect(stillVisible({ x: 2400, y: 100, width: 800, height: 600 }, two)).toBe(true);
  });
});
