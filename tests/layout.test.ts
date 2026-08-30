import { describe, expect, it } from 'vitest';
import { clampTerminal, openingTerminalHeight } from '../src/layout';

/**
 * The graph keeps a floor.
 *
 * A terminal height is saved from one window and restored into another. The
 * splitter clamped while you dragged it and nothing clamped what came back off
 * disk, so a height sized on a maximised screen reopened on a laptop covered
 * the whole workspace — and the first thing a graph-first IDE showed you was a
 * shell.
 */

describe('clampTerminal', () => {
  it('leaves a usable graph above a terminal restored from a bigger window', () => {
    // 900px saved on a 1400px-tall screen, reopened at 800
    expect(clampTerminal(900, 800)).toBe(800 - 260);
  });

  it('leaves a height that already fits alone', () => {
    expect(clampTerminal(240, 1000)).toBe(240);
  });

  it('keeps the terminal usable even on a window too short for both', () => {
    // the floor for the terminal wins over the floor for the graph: a window
    // this small cannot satisfy both, and a 0px terminal is not a terminal
    expect(clampTerminal(400, 300)).toBe(120);
  });

  it('never goes below the drag floor', () => {
    expect(clampTerminal(10, 1000)).toBe(80);
  });
});

/**
 * The graph has the bigger half on open.
 *
 * A saved height is honoured, but only up to a third of the window: the
 * terminal dragged tall to read yesterday's log is not what a graph-first IDE
 * should greet a project with today.
 */
describe('openingTerminalHeight', () => {
  it('gives a fresh window a fifth of its height', () => {
    expect(openingTerminalHeight(undefined, 1000)).toBe(180);
  });

  it('caps a tall saved height at a third of the window', () => {
    expect(openingTerminalHeight(600, 1000)).toBe(300);
  });

  it('keeps a saved height that already leaves the graph the room', () => {
    expect(openingTerminalHeight(200, 1000)).toBe(200);
  });

  it('never opens a fresh window past the default ceiling', () => {
    expect(openingTerminalHeight(undefined, 2400)).toBe(320);
  });

  it('still respects the floors on a short window', () => {
    expect(openingTerminalHeight(undefined, 400)).toBe(clampTerminal(150, 400));
  });
});
