import { execFile } from 'node:child_process';
import * as pty from '@lydell/node-pty';

export interface PtyEvents {
  onData: (id: string, data: string) => void;
  onExit: (id: string, exitCode: number) => void;
}

export class PtyService {
  private terms = new Map<string, pty.IPty>();
  /**
   * Output waiting to go out, per terminal.
   *
   * A pty hands over what it has in small pieces — a redraw arrives as a
   * dozen of them — and each piece used to become its own event, its own
   * JSON frame and its own websocket write. They are gathered until the
   * event loop has drained this turn's I/O, which is at most a millisecond
   * later and in practice the same instant: a lone keystroke's echo goes out
   * as fast as before, and a burst of output goes out as one frame instead
   * of forty.
   */
  private outbox = new Map<string, string[]>();
  private flushScheduled = false;

  constructor(private events: PtyEvents) {}

  private queueOutput(id: string, data: string): void {
    const chunks = this.outbox.get(id);
    if (chunks) chunks.push(data);
    else this.outbox.set(id, [data]);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flushOutput());
  }

  private flushOutput(): void {
    this.flushScheduled = false;
    const ready = [...this.outbox];
    this.outbox.clear();
    for (const [id, chunks] of ready) this.events.onData(id, chunks.join(''));
  }

  create(id: string, cwd: string, cols = 80, rows = 24): void {
    this.dispose(id);
    const shell =
      process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });
    term.onData((data) => this.queueOutput(id, data));
    term.onExit(({ exitCode }) => {
      this.terms.delete(id);
      // whatever it printed last goes out before the news that it is gone
      this.flushOutput();
      this.events.onExit(id, exitCode);
    });
    this.terms.set(id, term);
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.write(data);
  }

  /** terminal id -> shell pid, for process-tree agent detection. */
  getPids(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, term] of this.terms) out.set(id, term.pid);
    return out;
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.terms.get(id)?.resize(cols, rows);
  }

  dispose(id: string): void {
    const term = this.terms.get(id);
    if (term) {
      this.terms.delete(id);
      // on Windows, killing only the shell orphans its children (and their
      // ConPTY handles can keep the app alive) — kill the whole tree
      if (process.platform === 'win32') {
        try {
          execFile('taskkill', ['/pid', String(term.pid), '/T', '/F'], { windowsHide: true });
        } catch {
          // best effort
        }
      }
      try {
        term.kill();
      } catch {
        // already dead
      }
    }
  }

  disposeAll(): void {
    for (const id of [...this.terms.keys()]) this.dispose(id);
  }
}

