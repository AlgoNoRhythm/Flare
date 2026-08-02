import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_CHANNELS } from '../shared/channels';

const ROOT = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Flare runs on the desktop and, over a websocket, in a browser. Both are
 * transports over one implementation — `electron/core.ts` — and the value of
 * that only holds if neither transport starts carrying behaviour of its own.
 * The moment a shell knows what `file:write` means, changing the desktop app
 * silently stops changing the web app, which is exactly the drift these tests
 * exist to prevent.
 */
describe('one implementation, several transports', () => {
  const core = read('electron/core.ts');

  /** Every `'namespace:name'` string literal in a file. */
  function channelLiterals(source: string): string[] {
    return [...source.matchAll(/'([a-z]+:[a-zA-Z]+)'/g)].map((m) => m[1]);
  }

  const coreChannels = new Set(
    [...core.matchAll(/^ {2}on\('([^']+)'/gm)].map((m) => m[1]),
  );

  it('registers every channel in the core, and only there', () => {
    // a sanity floor: if this collapses, the regex above stopped matching
    expect(coreChannels.size).toBeGreaterThan(40);

    /*
     * A transport may name the channels it bootstraps itself from — opening
     * the folder it was launched with, the macOS menu's Open Folder, and the
     * re-fetch a browser does after its socket reconnects. Those are about
     * starting a session, not about what any feature does. Anything else is a
     * transport that has grown behaviour of its own.
     */
    const shellAllows = new Set(['project:open', 'project:openDialog', 'project:get']);
    const inMain = channelLiterals(read('electron/main.ts')).filter(
      (c) => coreChannels.has(c) && !shellAllows.has(c),
    );
    expect(inMain).toEqual([]);

    // the preload forwards; it does not enumerate the API
    expect(channelLiterals(read('electron/preload.ts')).filter((c) => coreChannels.has(c))).toEqual(
      [],
    );

    // and neither does the browser server: it is the same kind of adapter, so
    // a feature added to the core reaches a browser tab with no edit there
    for (const file of ['server/index.ts', 'server/web.ts', 'src/webTransport.ts']) {
      const named = channelLiterals(read(file)).filter(
        (c) => coreChannels.has(c) && !shellAllows.has(c),
      );
      expect(named, `${file} should not name channels`).toEqual([]);
    }
  });

  it('turns method names into channels in exactly one place', () => {
    const api = read('src/api.ts');
    for (const channel of coreChannels) {
      // every channel the core answers is reachable from the typed client
      expect(api, `${channel} has no caller in src/api.ts`).toContain(`'${channel}'`);
    }
    // and nothing else in the app talks to a channel directly
    const others = fs
      .readdirSync(path.join(ROOT, 'src', 'components'))
      .filter((f) => /\.tsx?$/.test(f))
      .flatMap((f) => channelLiterals(read(path.join('src', 'components', f))))
      .filter((c) => coreChannels.has(c));
    expect(others).toEqual([]);
  });

  it('names event channels once, and emits only names it declares', () => {
    const declared = new Set<string>(EVENT_CHANNELS);
    const emitted = [...core.matchAll(/onEvent\('([^']+)'/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(10);
    for (const channel of emitted) expect(declared.has(channel)).toBe(true);

    // the shell emits window events of its own; those are declared here too
    for (const channel of channelLiterals(read('electron/main.ts'))) {
      if (channel.startsWith('evt:')) expect(declared.has(channel)).toBe(true);
    }

    // the preload filters events through the shared list rather than its own
    expect(read('electron/preload.ts')).toContain('isEventChannel');
  });

  it('keeps Electron out of everything but the desktop shell', () => {
    for (const file of fs.readdirSync(path.join(ROOT, 'electron'))) {
      if (!/\.ts$/.test(file) || file === 'main.ts' || file === 'preload.ts') continue;
      expect(read(path.join('electron', file)), file).not.toMatch(/from 'electron'/);
    }
  });
});
