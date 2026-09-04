import { describe, expect, it } from 'vitest';
import { PredictiveEcho, visibleText, type EchoScreen, type ScreenLook } from '../src/terminalEcho';

/**
 * A terminal that remembers what was written and parses when told to, the
 * way xterm's write queue does — a write's callback fires later, not inline.
 * It keeps just enough of a screen to know where the cursor ends up: printed
 * characters advance it, backspace and CSI moves take it back, a newline
 * drops a row.
 */
class FakeScreen implements EchoScreen {
  writes: string[] = [];
  x = 10;
  y = 0;
  cols = 80;
  alternate = false;
  /** set to force a crowded line; otherwise everything right of the cursor is blank */
  blankRight: number | null = null;
  private queue: { data: string; done?: () => void }[] = [];

  write(data: string, done?: () => void): void {
    this.writes.push(data);
    this.queue.push({ data, done });
  }

  look(): ScreenLook {
    return {
      x: this.x,
      y: this.y,
      cols: this.cols,
      alternate: this.alternate,
      blankRight: this.blankRight ?? Math.max(0, this.cols - this.x),
    };
  }

  /** everything queued has now been parsed, in order — including what a callback queues */
  parse(): void {
    while (this.queue.length > 0) {
      const { data, done } = this.queue.shift()!;
      this.apply(data);
      done?.();
    }
  }

  take(): string[] {
    const out = this.writes;
    this.writes = [];
    return out;
  }

  private apply(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') {
        const rest = data.slice(i);
        const csi = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(rest);
        if (csi) {
          const n = Number(csi[1] || '1');
          if (csi[2] === 'D') this.x = Math.max(0, this.x - n);
          else if (csi[2] === 'C') this.x = Math.min(this.cols - 1, this.x + n);
          i += csi[0].length;
          continue;
        }
        const osc = /^\x1b\][^\x07]*\x07/.exec(rest);
        i += osc ? osc[0].length : 2;
        continue;
      }
      if (ch === '\b') this.x = Math.max(0, this.x - 1);
      else if (ch === '\r') this.x = 0;
      else if (ch === '\n') this.y++;
      else if (ch >= ' ') {
        this.x++;
        if (this.x >= this.cols) {
          this.x = 0;
          this.y++;
        }
      }
      i++;
    }
  }
}

class FakeClock {
  t = 0;
  private timers: { fn(): void; at: number }[] = [];

  now = (): number => this.t;

  setTimer = (fn: () => void, ms: number): unknown => {
    const handle = { fn, at: this.t + ms };
    this.timers.push(handle);
    return handle;
  };

  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((h) => h !== handle);
  };

  advance(ms: number): void {
    const until = this.t + ms;
    for (;;) {
      const due = this.timers.filter((h) => h.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((h) => h !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = until;
  }
}

function setup(): { screen: FakeScreen; clock: FakeClock; echo: PredictiveEcho } {
  const screen = new FakeScreen();
  const clock = new FakeClock();
  const echo = new PredictiveEcho(screen, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { screen, clock, echo };
}

/** One key, echoed `rtt` later: what teaches the echo how slow the shell is. */
function measure({ screen, clock, echo }: ReturnType<typeof setup>, ch: string, rtt: number): void {
  echo.input(ch);
  clock.advance(rtt);
  echo.output(ch);
  screen.parse();
  screen.take();
}

describe('visibleText', () => {
  it('keeps what a person would see and drops the rest', () => {
    expect(visibleText('\x1b[2D\x1b[93mgit\x1b[0m')).toBe('git');
    expect(visibleText('\x1b]0;title\x07ok\r\n')).toBe('ok');
    expect(visibleText('\x1b7a\x1b8\x1b[?25l')).toBe('a');
  });
});

describe('PredictiveEcho', () => {
  it('draws nothing until it has seen an echo, and not then if the echo was fast', () => {
    const s = setup();
    s.echo.input('a');
    expect(s.screen.take()).toEqual([]); // sent, not guessed
    s.clock.advance(4);
    s.echo.output('a');
    s.screen.parse();
    expect(s.screen.take()).toEqual(['a']); // the echo itself, nothing erased first
    expect(s.echo.echoLatency).toBe(4);

    s.echo.input('b');
    expect(s.screen.take()).toEqual([]); // 4ms is not worth guessing ahead of
  });

  it('draws the key at once when the echo is slow, then lets the echo replace it', () => {
    const s = setup();
    measure(s, 'a', 100);
    expect(s.echo.echoLatency).toBe(100);

    s.echo.input('b');
    expect(s.screen.take()).toEqual(['b']);

    s.clock.advance(100);
    s.echo.output('b');
    s.screen.parse();
    // the guess is undone before the shell's own 'b' lands, so it never doubles
    expect(s.screen.take()).toEqual(['\b \b', 'b']);
    expect(s.screen.x).toBe(12);
  });

  it('gets out of the way of unrelated output and comes back after it', () => {
    const s = setup();
    measure(s, 'a', 100);
    s.echo.input('b');
    s.screen.take();

    // a word with a 'b' in it, printed by something else, is not the echo
    s.echo.output('\r\n[job 1 done]\r\n$ ');
    expect(s.screen.take()).toEqual(['\b \b', '\r\n[job 1 done]\r\n$ ']);
    s.screen.parse();
    expect(s.screen.take()).toEqual(['b']); // still unconfirmed, drawn again at the new cursor

    s.echo.output('b');
    s.screen.parse();
    expect(s.screen.take()).toEqual(['\b \b', 'b']);
  });

  it('confirms through the colour codes a line editor wraps its echo in', () => {
    const s = setup();
    measure(s, 'x', 100);
    for (const ch of 'git') s.echo.input(ch);
    expect(s.screen.take()).toEqual(['g', 'i', 't']);

    // two come back plainly; the third arrives as the whole word recoloured
    s.echo.output('gi');
    s.screen.parse();
    expect(s.screen.take()).toEqual(['\b\b\b   \b\b\b', 'gi', 't']);
    s.echo.output('\x1b[2D\x1b[93mgit\x1b[0m');
    s.screen.parse();
    expect(s.screen.take()).toEqual(['\b \b', '\x1b[2D\x1b[93mgit\x1b[0m']);
    // nothing left to redraw: all three were accounted for
    s.echo.output('!');
    expect(s.screen.take()).toEqual(['!']);
  });

  it('takes back its own guess on backspace without waiting', () => {
    const s = setup();
    measure(s, 'a', 100);
    s.echo.input('b');
    s.screen.take();
    s.echo.input('\x7f');
    expect(s.screen.take()).toEqual(['\b \b']);
    // the shell echoes both and they cancel; nothing of ours is in the way
    s.echo.output('b\b \b');
    expect(s.screen.take()).toEqual(['b\b \b']);
  });

  it('never guesses while the cursor is hidden, and catches up when it shows', () => {
    const s = setup();
    measure(s, 'a', 100);
    s.echo.output('\x1b[?25l');
    s.screen.parse();
    s.screen.take();

    s.echo.input('b');
    expect(s.screen.take()).toEqual([]);

    s.echo.output('\x1b[?25h');
    s.screen.parse();
    expect(s.screen.take()).toEqual(['\x1b[?25h', 'b']);
    s.echo.input('c');
    expect(s.screen.take()).toEqual(['c']);
  });

  it('leaves the alternate screen and mouse-tracking programs alone', () => {
    const s = setup();
    measure(s, 'a', 100);
    s.screen.alternate = true;
    s.echo.output('\x1b[?1049h');
    s.screen.parse();
    s.screen.take();
    s.echo.input('j');
    expect(s.screen.take()).toEqual([]);

    const t = setup();
    measure(t, 'a', 100);
    t.echo.output('\x1b[?1000h');
    t.screen.parse();
    t.screen.take();
    t.echo.input('j');
    expect(t.screen.take()).toEqual([]);
  });

  it('erases a guess nothing echoed, and stops guessing until an echo returns', () => {
    const s = setup();
    measure(s, 'a', 100);
    s.echo.input('p');
    expect(s.screen.take()).toEqual(['p']);

    s.clock.advance(1000);
    expect(s.screen.take()).toEqual(['\b \b']);

    // a password prompt echoes nothing; the next key is sent and not shown
    s.echo.input('q');
    expect(s.screen.take()).toEqual([]);
    // an echo restores confidence
    s.clock.advance(100);
    s.echo.output('q');
    s.screen.parse();
    s.screen.take();
    s.echo.input('r');
    expect(s.screen.take()).toEqual(['r']);
  });

  it('only draws over blank cells, and never in the last column', () => {
    const s = setup();
    measure(s, 'a', 100);

    s.screen.blankRight = 0;
    s.echo.output('');
    s.screen.parse();
    s.echo.input('b');
    expect(s.screen.take()).toEqual(['']);

    const t = setup();
    measure(t, 'a', 100);
    t.screen.x = 79;
    t.echo.output('');
    t.screen.parse();
    t.echo.input('c');
    expect(t.screen.take()).toEqual(['']);
  });

  it('waits for the shell after a key whose effect it cannot guess', () => {
    const s = setup();
    measure(s, 'a', 100);
    s.echo.input('\x1b[D'); // left arrow
    s.echo.input('b');
    expect(s.screen.take()).toEqual([]);

    s.echo.output('\x1b[D');
    s.screen.parse();
    expect(s.screen.take()).toEqual(['\x1b[D', 'b']);
  });

  it('does not guess about a paste', () => {
    const s = setup();
    measure(s, 'a', 100);
    s.echo.input('echo pasted');
    expect(s.screen.take()).toEqual([]);
  });

  it('passes output straight through once disposed', () => {
    const s = setup();
    measure(s, 'a', 100);
    s.echo.input('b');
    s.screen.take();
    s.echo.dispose();
    s.echo.output('zzz');
    expect(s.screen.take()).toEqual(['zzz']);
  });
});
