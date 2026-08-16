import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  /*
   * One retry, because both spec files are `mode: 'serial'`.
   *
   * Serial mode is right here — these tests build on one another's state, and
   * a project that failed to open makes the next forty assertions meaningless.
   * But it also means a single flake *skips* everything after it, so one bad
   * moment in test 7 reports "1 failed, 6 passed" out of 78 and tells you
   * nothing about the other 71. That is not a slow suite, it is a suite with
   * no signal.
   *
   * A retry re-runs the whole serial group, and Playwright reports what it
   * retried as **flaky** rather than folding it into "passed" — so this
   * recovers the other 71 results without hiding the fact that something is
   * unstable. It is not a substitute for fixing the races, which is why the
   * two known ones are fixed rather than retried away.
   */
  retries: 1,
  reporter: [['list']],
  expect: { timeout: 15_000 },
});
