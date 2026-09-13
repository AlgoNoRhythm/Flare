/**
 * Synchronized output, for a terminal emulator that does not have it.
 *
 * An inline TUI — Codex, and anything else drawing a composer on the main
 * screen rather than taking the alternate one — repaints by erasing the lines
 * it owns and writing them again. Between those two halves the screen is
 * genuinely wrong: the box is gone and nothing has replaced it yet. Every such
 * app therefore brackets a frame in DEC mode 2026, *begin* and *end
 * synchronized update*, which asks the terminal to hold the picture still
 * until the frame is complete.
 *
 * xterm.js does not implement 2026 (5.5 knows `?2004`, `?1004`, `?1049` and
 * not this one), so it ignores the brackets and paints whatever has arrived —
 * and because a pty hands us a frame in however many chunks the pipe felt like,
 * the erase and the redraw routinely land in different animation frames. That
 * is the flicker: not a rendering bug, a frame torn in half.
 *
 * So the brackets are honoured here instead. Everything between BSU and ESU is
 * held and released as one write, which xterm then parses in one go and paints
 * once. Nothing is dropped and nothing is reordered — the only thing that
 * changes is *when* the middle of a frame reaches the screen.
 *
 * Pure, bar the timer it is handed: a frame that never closes — a killed
 * agent, a truncated stream — must not wedge the display, so an unterminated
 * one is released on its own after a beat.
 */

/** `ESC [ ? 2026 h` — hold the picture. */
const BEGIN = '\x1b[?2026h';
/** `ESC [ ? 2026 l` — show it. */
const END = '\x1b[?2026l';

/**
 * A frame this big is not a frame, and something has gone wrong upstream:
 * release it rather than grow without bound.
 */
const MAX_FRAME = 256 * 1024;

export interface SyncFramesOptions {
  /** how long an unterminated frame may be held before it is shown anyway */
  maxHoldMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export class SyncFrames {
  /** the part of a frame that has arrived; null when not inside one */
  private held: string | null = null;
  private timer: unknown = null;
  private disposed = false;

  private readonly maxHoldMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    /** where a complete frame — or ordinary output — goes */
    private readonly emit: (data: string) => void,
    options: SyncFramesOptions = {},
  ) {
    this.maxHoldMs = options.maxHoldMs ?? 100;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number));
  }

  /** True while a frame is being held — the app is mid-repaint. */
  get framing(): boolean {
    return this.held !== null;
  }

  /**
   * Feed one chunk from the pty.
   *
   * The markers can arrive anywhere, including several per chunk and one
   * straddling two, so this walks the chunk rather than testing it: a frame
   * opened halfway through a chunk keeps the text before it flowing
   * immediately, which is what an app that mixes scrollback with a live
   * composer does on every line it prints.
   */
  write(chunk: string): void {
    if (this.disposed || chunk === '') {
      if (chunk !== '') this.emit(chunk);
      return;
    }
    let rest = chunk;
    while (rest !== '') {
      if (this.held === null) {
        const start = rest.indexOf(BEGIN);
        if (start === -1) {
          this.emit(rest);
          return;
        }
        // everything before the frame is ordinary output and need not wait
        if (start > 0) this.emit(rest.slice(0, start));
        this.held = BEGIN;
        rest = rest.slice(start + BEGIN.length);
        this.arm();
        continue;
      }
      const stop = rest.indexOf(END);
      if (stop === -1) {
        this.held += rest;
        // a frame that has stopped making sense is worth more on screen than held
        if (this.held.length > MAX_FRAME) this.flush();
        return;
      }
      this.held += rest.slice(0, stop + END.length);
      rest = rest.slice(stop + END.length);
      this.flush();
    }
  }

  /** Show whatever is being held, complete or not. */
  flush(): void {
    this.disarm();
    const frame = this.held;
    this.held = null;
    if (frame !== null && frame !== '') this.emit(frame);
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
  }

  private arm(): void {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, this.maxHoldMs);
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
