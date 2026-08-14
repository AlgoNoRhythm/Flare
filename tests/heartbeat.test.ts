import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hookCommand, stopHookReply, syncStopHook } from '../electron/services/heartbeat';

/**
 * The heartbeat writes into someone's repository, which is the part worth
 * testing: everything else in Flare's routine is a string in its own state
 * file, and this is a settings file the user and their assistant also own.
 */

let root = '';
const settings = (): string => path.join(root, '.claude', 'settings.local.json');
const read = (): Record<string, any> => JSON.parse(fs.readFileSync(settings(), 'utf8'));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-hb-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the stop hook', () => {
  it('installs a Stop hook that forwards the payload to this session', () => {
    expect(syncStopHook(root, true, 7345, 'flare')).toBe(settings());
    const command = read().hooks.Stop[0].hooks[0].command;
    expect(command).toBe(hookCommand(7345, 'flare'));
    expect(command).toContain('/hook/flare/stop');
    // without the body the endpoint cannot see stop_hook_active, and the
    // heartbeat becomes a session that will not end
    expect(command).toContain('--data-binary @-');
  });

  it('leaves the rest of the file exactly as it was', () => {
    fs.mkdirSync(path.dirname(settings()), { recursive: true });
    fs.writeFileSync(
      settings(),
      JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
      }),
    );

    syncStopHook(root, true, 7345, 'flare');
    const after = read();
    expect(after.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(after.hooks.Stop).toHaveLength(2);
    expect(after.hooks.Stop[0].hooks[0].command).toBe('say done');
  });

  it('removes only its own hook when switched off', () => {
    fs.mkdirSync(path.dirname(settings()), { recursive: true });
    fs.writeFileSync(
      settings(),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }),
    );
    syncStopHook(root, true, 7345, 'flare');
    syncStopHook(root, false, 7345, 'flare');
    const after = read();
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0].hooks[0].command).toBe('say done');
  });

  it('leaves no empty scaffolding behind when its hook was the only one', () => {
    syncStopHook(root, true, 7345, 'flare');
    syncStopHook(root, false, 7345, 'flare');
    expect(read()).toEqual({});
  });

  it('writes nothing at all when there is nothing to change', () => {
    expect(syncStopHook(root, false, 7345, 'flare')).toBeNull();
    expect(fs.existsSync(settings())).toBe(false);
    syncStopHook(root, true, 7345, 'flare');
    // already installed: no rewrite, so no file mtime churn on every board edit
    expect(syncStopHook(root, true, 7345, 'flare')).toBeNull();
  });

  /*
   * A settings file we cannot parse belongs to someone who is mid-edit or
   * using a syntax we do not know about. Replacing it would take their work
   * away to install a convenience.
   */
  it('refuses to touch a settings file it cannot parse', () => {
    fs.mkdirSync(path.dirname(settings()), { recursive: true });
    fs.writeFileSync(settings(), '{ not json');
    expect(syncStopHook(root, true, 7345, 'flare')).toBeNull();
    expect(fs.readFileSync(settings(), 'utf8')).toBe('{ not json');
  });

  it('keeps the url current when the port or the project changes', () => {
    syncStopHook(root, true, 7345, 'flare');
    syncStopHook(root, true, 7399, 'flare');
    const commands = read().hooks.Stop.map((e: any) => e.hooks[0].command);
    expect(commands).toEqual([hookCommand(7399, 'flare')]);
  });
});

describe('the reply', () => {
  it('blocks with the reason the model will act on', () => {
    expect(stopHookReply(true, 'Take "Rewrite the resolver".')).toEqual({
      decision: 'block',
      reason: 'Take "Rewrite the resolver".',
    });
  });

  it('says nothing at all when the session may end', () => {
    expect(stopHookReply(false, 'Nothing left.')).not.toHaveProperty('decision');
  });
});
