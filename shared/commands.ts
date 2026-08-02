/**
 * What a shell command *does*, and — for verification commands — whether it
 * actually passed.
 *
 * The IDE owns the terminals, so it sees every command an agent runs. That is
 * only useful if we can say which of them were dangerous and which of them
 * were the tests. Both halves are pure string work, so they live here and are
 * unit-tested rather than guessed at inside the session.
 */

export type CommandKind = 'read' | 'write' | 'verify' | 'network' | 'destructive';

export type CommandOutcome = 'pass' | 'fail' | 'unknown';

/** Hard to undo: these are the ones worth a snapshot and an alert. */
const DESTRUCTIVE: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+/,
  /\brmdir\s+\/s/i,
  /\bRemove-Item\b[^|]*-Recurse/i,
  /\bdel\s+\/[sq]/i,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[a-zA-Z]*[fdx]/,
  /\bgit\s+checkout\s+(--\s+)?\.(\s|$)/,
  /\bgit\s+push\b[^|]*(--force(?!-with-lease)|\s-f\b)/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+filter-branch\b/,
  /\bnpm\s+publish\b/,
  /\b(yarn|pnpm)\s+publish\b/,
  /\bcargo\s+publish\b/,
  /\btwine\s+upload\b/,
  /\bdocker\s+system\s+prune\b/,
  /\bkubectl\s+delete\b/,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /\bkill\s+-9\b/,
  /\bshutdown\b/i,
  /\bchmod\s+-R\s+777\b/,
];

/** Reaches the network — worth seeing, not worth panicking about. */
const NETWORK: RegExp[] = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bInvoke-WebRequest\b|\biwr\b/i,
  /\bssh\b|\bscp\b|\bsftp\b/,
  /\bgit\s+(push|pull|fetch|clone|remote\s+add)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add|update|audit)\b/,
  /\bpip3?\s+install\b|\bpoetry\s+(add|install)\b|\buv\s+(pip\s+)?(add|install|sync)\b/,
  /\bcargo\s+(add|fetch|install)\b/,
  /\bgo\s+(get|mod\s+download)\b/,
  /\b(apt|apt-get|brew|choco|winget)\s+(install|upgrade)\b/,
  /\bdocker\s+(pull|push)\b/,
];

/**
 * A tool name used as a command: at the start, after whitespace, or as the
 * last path segment of an executable — and ending the token. Optionally with
 * a Windows/Node executable suffix, so `.bin\tsc.cmd` and `vitest.mjs` count.
 */
function tool(names: string): RegExp {
  return new RegExp(`(^|\\s|["'])([^\\s"']*[\\\\/])?(${names})(\\.(js|mjs|cjs|cmd|exe|ps1|bat))?["']?(\\s|$)`, 'i');
}

/**
 * Proves something: tests, type checks, linters, builds.
 *
 * These have to match what the *process table* shows, not what you typed.
 * `npm test` on Windows appears as
 *   "…\node.exe" "…\npm\bin\npm-cli.js" test
 * and a local binary appears as its real entry point
 *   node …\node_modules\vitest\vitest.mjs run
 * so the script name and the .bin shim both need to be recognised.
 */
const VERIFY: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)(\.(cmd|exe|ps1))?\s+(run\s+)?(test|tests|lint|typecheck|type-check|check|build|verify|e2e|ci)\b/,
  /\b(npm|pnpm|yarn)-cli\.(js|cjs|mjs)["']?\s+(run\s+)?(test|tests|lint|typecheck|type-check|check|build|verify|e2e|ci)\b/,
  // a tool name only counts as the *command*, not as part of a path or word:
  // `cat ~/pytest-notes/todo.md` is not a test run
  tool('vitest|jest|mocha|ava|tap|karma|playwright|cypress|nightwatch|jasmine'),
  tool('pytest|tox|unittest|nose2'),
  tool('tsc|eslint|biome|oxlint|ruff|mypy|pyright|flake8|pylint|rubocop|phpstan'),
  /\bpython\s+-m\s+(pytest|unittest)\b/,
  /\b(go|cargo)\s+test\b/,
  /\bcargo\s+(check|clippy|build)\b/,
  /\bblack\s+--check\b|\bprettier\s+--check\b/,
  /\bmake\s+(test|check|lint|verify)\b/,
  /\bdotnet\s+test\b|\bgradle\s+(test|check)\b|\bmvn\s+(test|verify)\b/,
  /\brspec\b|\bphpunit\b|\bswift\s+test\b/,
];

/** Changes the working tree, recoverably. */
const WRITE: RegExp[] = [
  /\bgit\s+(add|commit|merge|rebase|stash|apply|am|cherry-pick|revert|tag|switch|restore|mv|rm)\b/,
  /\bgit\s+checkout\s+-b\b/,
  /\b(mv|cp|mkdir|touch|ln)\s/,
  /\b(Move-Item|Copy-Item|New-Item|Set-Content|Add-Content|Out-File)\b/i,
  /\bsed\s+-i\b/,
  /\b(chmod|chown)\b/,
  /\b(npm|pnpm|yarn)\s+(uninstall|remove|link|init)\b/,
  /\bprettier\s+(--write|-w)\b|\beslint\s+--fix\b|\bruff\s+.*--fix\b/,
  />>?\s*[^\s|&]+$/,
];

function anyMatch(patterns: RegExp[], command: string): boolean {
  return patterns.some((re) => re.test(command));
}

/**
 * Unwrap the shell trampolines the process table shows instead of what the
 * user ran: `cmd.exe /d /s /c npm test` is an `npm test`.
 */
export function normalizeCommand(command: string): string {
  let cmd = command.trim();
  for (let i = 0; i < 4; i++) {
    const next = cmd
      .replace(/^"?[^"]*\bcmd(\.exe)?"?\s+(\/[a-z]\s+)*\/c\s+/i, '')
      /*
       * The shell wrapper an agent uses is not the command it ran.
       *
       * This previously matched only a bare `sh -c`, which meant the two forms
       * agents actually produce survived intact: a quoted interpreter path
       * (`"C:\Program Files\Git\bin\bash.exe" -c …`, where the `.exe` was not
       * allowed for) and a combined login flag (`bash -lc …`). Those logged as
       * the wrapper with the real command buried in its argument, which is the
       * "bash without further command references" case.
       */
      .replace(/^"?[^"]*\b(ba|z|da|k)?sh(\.exe)?"?\s+(--?[a-z-]+\s+)*-[a-z]*c\s+/i, '')
      .replace(/^"?[^"]*\b(powershell|pwsh)(\.exe)?"?\s+(-\w+(\s+\S+)?\s+)*-C(ommand)?\s+/i, '')
      .replace(/^(env\s+([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+)/, '')
      .replace(/^['"](.*)['"]$/s, '$1')
      .trim();
    if (next === cmd) break;
    cmd = next;
  }
  return cmd;
}

/**
 * Classify a command line. Order is severity-first: a command that both
 * installs from the network and deletes a tree is reported as destructive,
 * because that is the part a human needs to see.
 */
export function classifyCommand(rawCommand: string): CommandKind {
  const cmd = normalizeCommand(rawCommand);
  if (cmd === '') return 'read';
  if (anyMatch(DESTRUCTIVE, cmd)) return 'destructive';
  if (anyMatch(VERIFY, cmd)) return 'verify';
  if (anyMatch(NETWORK, cmd)) return 'network';
  if (anyMatch(WRITE, cmd)) return 'write';
  return 'read';
}

/** Short human label for the command log's risk column. */
export const KIND_LABEL: Record<CommandKind, string> = {
  read: 'read',
  write: 'writes',
  verify: 'verify',
  network: 'network',
  destructive: 'destructive',
};

const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B[()][AB0]|\u001B[=>]|\r/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Failure evidence, checked first: a vitest failure line mentions both
 * "failed" and "passed", so anything that matches here wins.
 */
const FAIL_PATTERNS: RegExp[] = [
  /\b[1-9]\d*\s+(tests?|specs?|examples?|files?|suites?)\s+failed/i,
  /\bTests?:?\s+[1-9]\d*\s+failed/i,
  /\b[1-9]\d*\s+failed\b/i,
  /^\s*(FAIL|FAILED|ERROR)\b/,
  /\berror\s+TS\d+/,
  /\bnpm\s+ERR!/,
  /\bTraceback \(most recent call last\)/,
  /\bAssertionError\b/,
  /\b(build|compilation) failed\b/i,
  /\bexit(ed)?\s+(with\s+)?(code\s+)?[1-9]\d*/i,
  /\u2716|\u2717|\u274C/,
  /\b[1-9]\d*\s+(problems?|errors?)\b/i,
  /\bfailures=[1-9]/i,
];

/** Success evidence. Deliberately conservative — "unknown" is a fine answer. */
const PASS_PATTERNS: RegExp[] = [
  /\b\d+\s+(tests?|specs?|examples?|files?|suites?)\s+passed/i,
  /\bTests?:?\s+\d+\s+passed/i,
  /\bTest Files\s+\d+\s+passed/i,
  /\ball tests passed/i,
  /\b\d+\s+passed\b/i,
  /^\s*(PASS|OK)\b/,
  /\b0\s+(problems?|errors?|failures?)\b/i,
  /\bcompiled successfully/i,
  /\bbuilt in\s+[\d.]+/i,
  /\u2713\s+\d+\s+passed/i,
  /\bno issues found/i,
];

/**
 * Decide whether a verification command passed, from whatever it printed.
 *
 * Returns the matching line as `evidence` so the UI can show *why* we said
 * this — a claim like "your tests failed" has to be checkable.
 */
export function detectOutcome(output: string): { outcome: CommandOutcome; evidence: string | null } {
  const lines = stripAnsi(output)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  // scan newest-first: a re-run's summary should beat an earlier one
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const re of FAIL_PATTERNS) {
      if (re.test(lines[i])) return { outcome: 'fail', evidence: lines[i].trim().slice(0, 200) };
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const re of PASS_PATTERNS) {
      if (re.test(lines[i])) return { outcome: 'pass', evidence: lines[i].trim().slice(0, 200) };
    }
  }
  return { outcome: 'unknown', evidence: null };
}

/** Collapse a noisy command line to something readable in a narrow column. */
export function shortenCommand(command: string, max = 90): string {
  const cmd = normalizeCommand(command).replace(/\s+/g, ' ');
  // Strip the interpreter's absolute path so what you read is the argv:
  //   C:\Program Files\nodejs\node.exe scripts/run.mjs -> node.exe scripts/run.mjs
  // Windows paths can contain spaces, so anchor on a known executable suffix;
  // POSIX paths can't be told from arguments that way, so match the whole
  // leading absolute path instead.
  const stripped = cmd
    // `node.exe "…/npm/bin/npm-cli.js" run test` is, to a human, `npm run test`
    .replace(/^.*[\\/](npm|pnpm|yarn)-cli\.[cm]?js"?\s*/i, '$1 ')
    .replace(/^"?(?:[A-Za-z]:)?[\\/][^"]*?[\\/]([^\\/"]+\.(?:exe|cmd|bat|com|ps1))"?/i, '$1')
    .replace(/^\/(?:[^\s"]*\/)([^\s"/]+)/, '$1')
    // quoted absolute paths in the arguments collapse to their basename
    .replace(/"(?:[A-Za-z]:)?[\\/][^"]*[\\/]([^\\/"]+)"/g, '$1')
    .trim();
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}
