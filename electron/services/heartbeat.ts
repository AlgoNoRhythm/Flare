import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The heartbeat: Flare answering the assistant's stop hook.
 *
 * Every other rule in the routine is something the agent has to remember —
 * they are prose in a document it read at the start of a long session. This one
 * is not: it is a `Stop` hook in the project's Claude Code settings, pointed at
 * this Flare session, so when the agent decides it is finished the board gets
 * the last word. If a card is still workable, the hook hands it back.
 *
 * It goes in `settings.local.json` rather than `settings.json` because what it
 * contains is a loopback URL for *this machine's* Flare — committing it would
 * hand every colleague a hook pointing at a port they are not running.
 */

const SETTINGS_DIR = '.claude';
const SETTINGS_FILE = 'settings.local.json';

/** How Flare recognises its own hook among whatever else is in there. */
const MARK = '/hook/';

export function hookCommand(port: number, slug: string): string {
  /*
   * `--data-binary @-` forwards the hook's own JSON payload to us, which is
   * the only way to see `stop_hook_active` — the flag that says this stop was
   * already caused by a hook. Without it the endpoint cannot tell a first stop
   * from the fourth, and "go back to the board" becomes a loop.
   *
   * curl rather than node: a hook is a shell command run in whatever
   * environment the assistant has, and curl is present on Windows 10+, macOS
   * and every Linux that has an assistant on it. `-m 5` because a hook that
   * hangs stops the session dead, which is worse than a missed heartbeat.
   */
  return `curl -sS -m 5 -X POST --data-binary @- http://127.0.0.1:${port}${MARK}${slug}/stop`;
}

interface HookEntry {
  hooks?: { type?: string; command?: string }[];
}

/**
 * Add or remove Flare's stop hook, leaving everything else in the file alone.
 *
 * Merged rather than written: this file belongs to the user, and an IDE that
 * replaces a settings file it did not create has taken something away that
 * nobody asked it to. Returns the path it touched, or null if nothing changed.
 */
export function syncStopHook(root: string, on: boolean, port: number, slug: string): string | null {
  const dir = path.join(root, SETTINGS_DIR);
  const file = path.join(dir, SETTINGS_FILE);

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      // unparseable settings are the user's, and a heartbeat is not worth
      // overwriting them for
      return null;
    }
  } else if (!on) {
    return null;
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const stop = Array.isArray(hooks.Stop) ? (hooks.Stop as HookEntry[]) : [];
  const mine = (entry: HookEntry): boolean =>
    (entry.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(MARK));

  const others = stop.filter((entry) => !mine(entry));
  const next = on
    ? [...others, { hooks: [{ type: 'command', command: hookCommand(port, slug) }] }]
    : others;

  const before = JSON.stringify(stop);
  if (before === JSON.stringify(next)) return null;

  if (next.length > 0) hooks.Stop = next;
  else delete hooks.Stop;
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

/**
 * The reply the assistant's stop hook expects.
 *
 * `decision: block` is Claude Code's "do not stop, here is why" — the reason is
 * handed straight back to the model, which is why it has to name the card
 * rather than just refuse. Anything else lets the session end.
 */
export function stopHookReply(keepGoing: boolean, reason: string): Record<string, unknown> {
  return keepGoing ? { decision: 'block', reason } : { suppressOutput: true };
}
