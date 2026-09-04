/**
 * Predictive echo for a terminal whose shell is on the far side of a network.
 *
 * Every keystroke still goes to the shell the moment it is pressed — a shell
 * completes on Tab, searches history on Ctrl+R and hands raw keys to whatever
 * agent is running in it, none of which survives a client that holds a line
 * back until Enter. What does not have to wait is *seeing* the key. Served
 * from another machine the character you typed used to appear one round trip
 * later, because the only thing that put it on screen was the shell echoing
 * it back, and at 80ms that is a terminal that feels like it is underwater.
 *
 * So the character is drawn here first, at the cursor, and the shell's echo
 * is treated as the confirmation. The scheme is mosh's, cut down:
 *
 * - a prediction is drawn only where it can be undone without a trace: at a
 *   visible cursor, on the main screen, over blank cells, short of the last
 *   column. Full-screen programs hide the cursor or take the alternate screen,
 *   and never see a prediction;
 * - before any output from the shell is applied, every drawn prediction is
 *   erased. The output then lands on exactly the screen the shell believes
 *   it is writing to, and whatever it did not echo is drawn again afterwards.
 *   Nothing the shell prints can be doubled or shifted by a guess;
 * - a prediction is confirmed when the typed text turns up in the output,
 *   colour codes and cursor movement stripped, *and* the cursor comes to rest
 *   where echoing it would leave it. Either alone is fooled — a background
 *   job printing a word that happens to contain the letter, a cursor moved
 *   by an arrow key. Until the first one confirms nothing is drawn, and a
 *   prediction that stays unconfirmed is wrong — a password prompt, a program
 *   that reads keys silently — so it is erased and drawing stops until an
 *   echo is seen again;
 * - the echo's own delay is measured on the way, and nothing is drawn while
 *   it is short. In a desktop window, or on a LAN, this whole file is
 *   bookkeeping and the screen behaves exactly as before.
 *
 * Pure, so it is testable: it talks to the terminal through `EchoScreen` and
 * to the clock through its options.
 */

export interface ScreenLook {
  /** the cursor's column */
  x: number;
  /** the cursor's line, counted through the scrollback so a newline moves it */
  y: number;
  cols: number;
  /** the alternate screen is a full-screen program's, and never predicted on */
  alternate: boolean;
  /** consecutive blank cells from the cursor to the right margin */
  blankRight: number;
}

export interface EchoScreen {
  /** queue data for the terminal; `done` fires once it has been parsed */
  write(data: string, done?: () => void): void;
  /** the cursor and its surroundings, as the terminal has them right now */
  look(): ScreenLook;
}

export interface EchoOptions {
  /** an echo faster than this is not worth predicting ahead of */
  minLatencyMs?: number;
  /** how many keys to keep guessing about before deciding nothing echoes */
  maxPending?: number;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface Prediction {
  ch: string;
  /** on screen right now, courtesy of this file rather than the shell */
  drawn: boolean;
  at: number;
}

/** The part of the output that would be visible: no escapes, no controls. */
export function visibleText(data: string): string {
  return data
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b[0-~]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

const MODE_RE = /\x1b\[\?([\d;]+)([hl])/g;

export class PredictiveEcho {
  private pending: Prediction[] = [];
  private cursorHidden = false;
  private mouse = false;
  /** shell output written to the screen and not yet parsed */
  private inflight = 0;
  /**
   * A key went out whose effect on the cursor only the shell's output can
   * tell us — an arrow, a paste, Enter. Nothing is drawn until it has.
   */
  private unsettled = false;
  private controls = 0;
  /** a prediction has confirmed since the last one that did not */
  private confident = false;
  private latency: number | null = null;
  /** the cursor as of the last output parsed — where the shell believes it is */
  private look: ScreenLook;
  private timer: unknown = null;
  private disposed = false;

  private readonly minLatency: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly screen: EchoScreen,
    options: EchoOptions = {},
  ) {
    this.minLatency = options.minLatencyMs ?? 30;
    this.maxPending = options.maxPending ?? 48;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number));
    this.look = screen.look();
  }

  /** the measured delay between a key and its echo, once one has been seen */
  get echoLatency(): number | null {
    return this.latency;
  }

  /** Call for every key before it goes to the shell. */
  input(data: string): void {
    if (this.disposed) return;
    if (data.length === 1) {
      const code = data.charCodeAt(0);
      if (code >= 0x20 && code <= 0x7e) {
        this.predict(data);
        return;
      }
      if (code === 0x7f || code === 0x08) {
        this.backspace();
        return;
      }
    }
    this.unsettle();
  }

  /** Call with the shell's output, instead of writing it to the terminal. */
  output(chunk: string): void {
    if (this.disposed) {
      this.screen.write(chunk);
      return;
    }
    this.trackModes(chunk);

    // undo every guess, so the output lands on the screen the shell expects
    const drawn = this.drawnCount();
    if (drawn > 0) {
      this.screen.write('\b'.repeat(drawn) + ' '.repeat(drawn) + '\b'.repeat(drawn));
      for (const p of this.pending) p.drawn = false;
    }

    const controlsBefore = this.controls;
    const plain = this.pending.length > 0 ? visibleText(chunk) : '';
    this.inflight++;
    this.screen.write(chunk, () => {
      this.inflight--;
      if (this.disposed) return;
      // where the shell's cursor was before this output, and is now
      const before = this.look;
      this.look = this.screen.look();

      const confirmed = this.confirmedBy(plain, before, this.look);
      if (confirmed > 0) {
        const sample = this.now() - this.pending[0].at;
        this.latency = this.latency === null ? sample : this.latency * 0.7 + sample * 0.3;
        this.pending.splice(0, confirmed);
        this.confident = true;
      }

      // a key sent after this output arrived is still unanswered
      if (this.controls === controlsBefore) this.unsettled = false;
      if (this.inflight === 0 && this.pending.length > 0 && this.canDraw(this.pending.length)) {
        this.screen.write(this.pending.map((p) => p.ch).join(''));
        for (const p of this.pending) p.drawn = true;
      }
      if (this.pending.length === 0) this.disarm();
    });

    if (this.pending.length > 0) this.arm();
    else this.disarm();
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
  }

  // ------------------------------------------------------------------

  private predict(ch: string): void {
    if (this.pending.length >= this.maxPending) return;
    const entry: Prediction = { ch, drawn: false, at: this.now() };
    this.pending.push(entry);
    // drawn ones are always the leading run, so a backspace knows what it undoes
    if (this.drawnCount() === this.pending.length - 1 && this.canDraw(this.pending.length)) {
      this.screen.write(ch);
      entry.drawn = true;
    }
    this.arm();
  }

  private backspace(): void {
    const last = this.pending.pop();
    if (!last) {
      this.unsettle();
      return;
    }
    if (last.drawn) this.screen.write('\b \b');
    if (this.pending.length === 0) this.disarm();
  }

  private unsettle(): void {
    this.unsettled = true;
    this.controls++;
  }

  private drawnCount(): number {
    let n = 0;
    for (const p of this.pending) if (p.drawn) n++;
    return n;
  }

  /** Whether `count` predicted characters may sit on screen from the cursor. */
  private canDraw(count: number): boolean {
    return (
      this.confident &&
      !this.unsettled &&
      this.inflight === 0 &&
      !this.cursorHidden &&
      !this.mouse &&
      !this.look.alternate &&
      this.latency !== null &&
      this.latency >= this.minLatency &&
      this.look.x + count < this.look.cols &&
      count <= this.look.blankRight
    );
  }

  /**
   * How many of the pending characters, from the first, this output echoed.
   *
   * The text has to be there, and the cursor has to have moved past exactly
   * that many cells from where it stood — across a wrap if the line ran out.
   */
  private confirmedBy(plain: string, before: ScreenLook, after: ScreenLook): number {
    if (this.pending.length === 0 || plain === '') return 0;
    for (let k = this.pending.length; k > 0; k--) {
      const typed = this.pending
        .slice(0, k)
        .map((p) => p.ch)
        .join('');
      if (!plain.includes(typed)) continue;
      const cell = before.x + k;
      const y = before.y + Math.floor(cell / before.cols);
      const x = cell % before.cols;
      if (after.y === y && after.x === x) return k;
    }
    return 0;
  }

  private trackModes(chunk: string): void {
    if (!chunk.includes('\x1b[?')) return;
    MODE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MODE_RE.exec(chunk)) !== null) {
      const on = m[2] === 'h';
      for (const mode of m[1].split(';')) {
        if (mode === '25') this.cursorHidden = !on;
        else if (mode === '1000' || mode === '1002' || mode === '1003') this.mouse = on;
      }
    }
  }

  /** How long a guess may stand unconfirmed: a few echoes' worth. */
  private timeout(): number {
    const rtt = this.latency ?? 150;
    return Math.min(1000, Math.max(300, rtt * 3));
  }

  private arm(): void {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => this.tick(), this.timeout());
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.timer = null;
    if (this.disposed || this.pending.length === 0) return;
    const age = this.now() - this.pending[0].at;
    if (age < this.timeout()) {
      this.timer = this.setTimer(() => this.tick(), this.timeout() - age);
      return;
    }
    // nothing echoed it: the guess was wrong, and so is guessing here
    const drawn = this.drawnCount();
    if (drawn > 0) this.screen.write('\b'.repeat(drawn) + ' '.repeat(drawn) + '\b'.repeat(drawn));
    this.pending = [];
    this.confident = false;
  }
}
