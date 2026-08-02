import { describe, expect, it } from 'vitest';
import { classifyCommand, detectOutcome, normalizeCommand, shortenCommand, stripAnsi } from '../shared/commands';

describe('classifyCommand', () => {
  it('flags irreversible commands as destructive', () => {
    for (const cmd of [
      'rm -rf node_modules',
      'rm -r ./dist',
      'git reset --hard HEAD~3',
      'git clean -fd',
      'git push --force origin main',
      'git branch -D feature',
      'npm publish',
      'Remove-Item -Recurse -Force .\\build',
      'DROP TABLE users;',
      'kill -9 4321',
    ]) {
      expect(classifyCommand(cmd), cmd).toBe('destructive');
    }
  });

  it('does not call safe look-alikes destructive', () => {
    expect(classifyCommand('git push origin main')).toBe('network');
    expect(classifyCommand('git push --force-with-lease')).toBe('network');
    expect(classifyCommand('grep -r "rm -rf" .')).toBe('read');
    expect(classifyCommand('git status')).toBe('read');
  });

  it('recognises verification commands across ecosystems', () => {
    for (const cmd of [
      'npm test',
      'npm run typecheck',
      'pnpm run lint',
      'npx vitest run',
      'pytest -q tests/',
      'go test ./...',
      'cargo clippy',
      'tsc --noEmit',
      'eslint src --max-warnings 0',
      'make check',
    ]) {
      expect(classifyCommand(cmd), cmd).toBe('verify');
    }
  });

  it('separates network, write and read', () => {
    expect(classifyCommand('npm install react')).toBe('network');
    expect(classifyCommand('curl https://example.com')).toBe('network');
    expect(classifyCommand('git commit -m "wip"')).toBe('write');
    expect(classifyCommand('mkdir -p src/lib')).toBe('write');
    expect(classifyCommand('sed -i s/a/b/ file.ts')).toBe('write');
    expect(classifyCommand('ls -la')).toBe('read');
    expect(classifyCommand('git diff HEAD')).toBe('read');
    expect(classifyCommand('')).toBe('read');
  });

  it('reports the most severe aspect of a compound command', () => {
    // installs *and* wipes: the wipe is the part a human needs to see
    expect(classifyCommand('npm install && rm -rf dist')).toBe('destructive');
  });

  it('recognises what the process table actually shows, not what was typed', () => {
    // `npm test` on Windows surfaces as node running npm's CLI entry point
    expect(
      classifyCommand(
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs/node_modules/npm/bin/npm-cli.js" test',
      ),
    ).toBe('verify');
    // a local binary surfaces as its real entry point or its .bin shim
    expect(classifyCommand('node C:\\repo\\node_modules\\vitest\\vitest.mjs run')).toBe('verify');
    expect(classifyCommand('C:\\repo\\node_modules\\.bin\\tsc.cmd --noEmit')).toBe('verify');
    expect(classifyCommand('/repo/node_modules/.bin/eslint src')).toBe('verify');
  });

  it('does not mistake a directory named after a tool for the tool', () => {
    expect(classifyCommand('node scripts/jest/config.js')).toBe('read');
    expect(classifyCommand('cat /home/me/pytest-notes/todo.md')).toBe('read');
  });

  it('sees through shell trampolines', () => {
    expect(normalizeCommand('C:\\windows\\system32\\cmd.exe /d /s /c npm test')).toBe('npm test');
    expect(normalizeCommand("/bin/sh -c 'rm -rf build'")).toBe('rm -rf build');
    expect(classifyCommand('C:\\windows\\system32\\cmd.exe /d /s /c npm run lint')).toBe('verify');
    expect(classifyCommand("/bin/sh -c 'rm -rf build'")).toBe('destructive');
  });

  it('unwraps the shell forms agents actually spawn', () => {
    // Each of these logged as the wrapper with the real command buried in its
    // argument — the "bash without further command references" case.
    expect(normalizeCommand('"C:\\Program Files\\Git\\bin\\bash.exe" -c "git status"')).toBe(
      'git status',
    );
    expect(normalizeCommand('bash -lc "npm test"')).toBe('npm test');
    expect(normalizeCommand('bash --login -c "npm test"')).toBe('npm test');
    expect(normalizeCommand('/usr/bin/zsh -ic "pytest -q"')).toBe('pytest -q');
    expect(normalizeCommand('pwsh -NoProfile -Command "npm run build"')).toBe('npm run build');
    expect(normalizeCommand('env NODE_ENV=test FOO=1 npm test')).toBe('npm test');
    // and the classification has to follow the unwrapped command, not the shell
    expect(classifyCommand('bash -lc "rm -rf dist"')).toBe('destructive');
    expect(classifyCommand('"C:\\Program Files\\Git\\bin\\bash.exe" -c "npm test"')).toBe('verify');
  });

  it('leaves a command that merely mentions a shell alone', () => {
    expect(normalizeCommand('git commit -m "use bash -c here"')).toBe('git commit -m "use bash -c here"');
  });
});

describe('detectOutcome', () => {
  it('reads a vitest failure even though the line also says passed', () => {
    const out = ' Test Files  1 failed | 14 passed (15)\n      Tests  1 failed | 98 passed (99)\n';
    const result = detectOutcome(out);
    expect(result.outcome).toBe('fail');
    expect(result.evidence).toContain('1 failed');
  });

  it('reads a vitest success', () => {
    const out = ' Test Files  15 passed (15)\n      Tests  99 passed (99)\n  Duration  14.68s\n';
    expect(detectOutcome(out).outcome).toBe('pass');
  });

  it('handles jest, pytest, tsc and eslint shapes', () => {
    expect(detectOutcome('Tests:       3 failed, 8 passed, 11 total').outcome).toBe('fail');
    expect(detectOutcome('Tests:       11 passed, 11 total').outcome).toBe('pass');
    expect(detectOutcome('==== 4 passed in 0.31s ====').outcome).toBe('pass');
    expect(detectOutcome('src/a.ts(3,1): error TS2345: bad').outcome).toBe('fail');
    expect(detectOutcome('\u2716 3 problems (3 errors, 0 warnings)').outcome).toBe('fail');
    expect(detectOutcome('Traceback (most recent call last):\n  File "x.py"').outcome).toBe('fail');
  });

  it('says unknown rather than guessing', () => {
    expect(detectOutcome('some log output with no verdict').outcome).toBe('unknown');
    expect(detectOutcome('').outcome).toBe('unknown');
  });

  it('quotes the line it based the verdict on', () => {
    const result = detectOutcome('noise\nTests:       3 failed, 8 passed\nmore noise');
    expect(result.evidence).toBe('Tests:       3 failed, 8 passed');
  });

  it('stays conservative when a failure appears anywhere in the output', () => {
    const out = 'Tests:  2 failed, 1 passed\n...retrying...\nTests:  3 passed, 3 total\n';
    // a failure in the scrollback outranks a later success: better to send the
    // human to look than to green-light a run we misread
    expect(detectOutcome(out).outcome).toBe('fail');
  });

  it('strips ANSI colouring before matching', () => {
    const coloured = '\u001B[32m\u001B[1m 15 tests passed\u001B[0m';
    expect(stripAnsi(coloured)).toBe(' 15 tests passed');
    expect(detectOutcome(coloured).outcome).toBe('pass');
  });
});

describe('shortenCommand', () => {
  it('drops the interpreter path and collapses whitespace', () => {
    expect(shortenCommand('C:\\Program Files\\nodejs\\node.exe   scripts/run.mjs')).toBe(
      'node.exe scripts/run.mjs',
    );
  });

  it('reads an npm script invocation back as the npm command', () => {
    expect(
      shortenCommand(
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs/node_modules/npm/bin/npm-cli.js" run test:fail',
      ),
    ).toBe('npm run test:fail');
  });

  it('truncates with an ellipsis', () => {
    expect(shortenCommand('a'.repeat(120), 20)).toHaveLength(20);
  });
});
