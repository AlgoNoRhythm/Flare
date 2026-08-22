import { afterEach, describe, expect, it } from 'vitest';
import { briefingEnabled, setBriefingEnabled } from '../src/prefs';

/**
 * These run in Node, where there is no `localStorage` — which is exactly the
 * case worth pinning down. A preference module that throws when storage is
 * missing takes the whole app down with it, so the no-storage path is tested
 * first and the stub is installed after.
 */

function stubStorage(impl?: Partial<Storage>): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    ...impl,
  };
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('briefing preference', () => {
  it('is on when there is no storage at all', () => {
    expect(briefingEnabled()).toBe(true);
  });

  it('is on until it has been turned off, and survives being turned back on', () => {
    stubStorage();
    expect(briefingEnabled()).toBe(true);
    setBriefingEnabled(false);
    expect(briefingEnabled()).toBe(false);
    setBriefingEnabled(true);
    expect(briefingEnabled()).toBe(true);
  });

  it('stays usable when storage refuses to write', () => {
    stubStorage({
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() => setBriefingEnabled(false)).not.toThrow();
    expect(briefingEnabled()).toBe(true);
  });
});
