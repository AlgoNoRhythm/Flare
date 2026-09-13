import { describe, expect, it } from 'vitest';
import { SyncFrames } from '../src/terminalFrames';

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';

/** A framer whose timer is under the test's control. */
function harness(maxHoldMs = 100) {
  const out: string[] = [];
  let fire: (() => void) | null = null;
  const frames = new SyncFrames((data) => out.push(data), {
    maxHoldMs,
    setTimer: (fn) => {
      fire = fn;
      return 1;
    },
    clearTimer: () => {
      fire = null;
    },
  });
  return { frames, out, expire: () => fire?.() };
}

describe('SyncFrames', () => {
  it('passes output that is not framed straight through', () => {
    const { frames, out } = harness();
    frames.write('$ ls\r\n');
    frames.write('a.ts  b.ts\r\n');
    expect(out).toEqual(['$ ls\r\n', 'a.ts  b.ts\r\n']);
  });

  it('holds a frame split across chunks and releases it whole', () => {
    const { frames, out } = harness();
    // the erase half of a repaint on its own is exactly what used to flicker
    frames.write(`${BSU}\x1b[2K`);
    expect(out).toEqual([]);
    frames.write('› hello');
    expect(out).toEqual([]);
    frames.write(ESU);
    expect(out).toEqual([`${BSU}\x1b[2K› hello${ESU}`]);
  });

  it('does not make scrollback wait for the frame that follows it', () => {
    const { frames, out } = harness();
    frames.write(`done in 2s\r\n${BSU}› `);
    expect(out).toEqual(['done in 2s\r\n']);
    frames.write(ESU);
    expect(out[1]).toBe(`${BSU}› ${ESU}`);
  });

  it('separates two frames that arrive in one chunk', () => {
    const { frames, out } = harness();
    frames.write(`${BSU}one${ESU}${BSU}two${ESU}`);
    expect(out).toEqual([`${BSU}one${ESU}`, `${BSU}two${ESU}`]);
  });

  it('keeps what trails the last frame flowing', () => {
    const { frames, out } = harness();
    frames.write(`${BSU}box${ESU}after`);
    expect(out).toEqual([`${BSU}box${ESU}`, 'after']);
  });

  it('shows a frame that never closes rather than holding the screen', () => {
    const { frames, out, expire } = harness();
    frames.write(`${BSU}half a repaint`);
    expect(out).toEqual([]);
    expire();
    expect(out).toEqual([`${BSU}half a repaint`]);
    // and the framer is out of the frame, not stuck in it
    frames.write('plain\r\n');
    expect(out[1]).toBe('plain\r\n');
  });

  it('reports whether a frame is open', () => {
    const { frames } = harness();
    expect(frames.framing).toBe(false);
    frames.write(BSU);
    expect(frames.framing).toBe(true);
    frames.write(ESU);
    expect(frames.framing).toBe(false);
  });

  it('releases a held frame when the terminal goes away', () => {
    const { frames, out } = harness();
    frames.write(`${BSU}mid`);
    frames.dispose();
    expect(out).toEqual([`${BSU}mid`]);
  });
});
