/**
 * Rules about how much room each part of the workspace may take.
 *
 * Separate from the component that applies them because a restored size is
 * arithmetic on a number from a *different window*, and that is the kind of
 * thing that is wrong in exactly one direction and only on someone else's
 * screen.
 */

/**
 * The graph's floor, in pixels, whatever the terminal wants.
 *
 * Enough to read a few cards and the edges between them — below this the map
 * stops being a map, and a workspace where the graph is a sliver is not this
 * app.
 */
export const GRAPH_MIN_H = 260;

/** The terminal's own floor: below this it is a decoration, not a shell. */
export const TERMINAL_MIN_H = 80;

/**
 * A terminal height that leaves the graph usable.
 *
 * Applied both while dragging the splitter and to whatever comes back off
 * disk. Only the drag was clamped before, so a height saved on a maximised
 * screen and restored on a laptop covered the whole workspace: opening a
 * project showed a shell where the map should be.
 *
 * When the window is too short to satisfy both floors the terminal wins, on
 * the grounds that the graph degrades into a smaller map while a terminal
 * below its floor stops being usable at all.
 */
export function clampTerminal(height: number, windowHeight: number): number {
  return Math.max(TERMINAL_MIN_H, Math.min(height, Math.max(120, windowHeight - GRAPH_MIN_H)));
}
