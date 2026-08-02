import { describe, expect, it } from 'vitest';
import { lastGreen, unverifiedCount, verificationFor, type ChangeBurst } from '../shared/activity';
import type { CommandLogEntry } from '../shared/types';

function cmd(over: Partial<CommandLogEntry> & { time: number }): CommandLogEntry {
  return {
    pid: over.time,
    terminalId: 't1',
    command: 'npm test',
    agent: 'claude',
    kind: 'verify',
    endedAt: over.time + 1000,
    outcome: 'pass',
    evidence: 'Tests  99 passed',
    ...over,
  };
}

const burst = { startedAt: 1000, endedAt: 2000 };

describe('verificationFor', () => {
  it('reports not-run when nothing was executed', () => {
    expect(verificationFor(burst, []).state).toBe('not-run');
  });

  it('ignores non-verification commands', () => {
    const commands = [cmd({ time: 2500, kind: 'read', command: 'git status' })];
    expect(verificationFor(burst, commands).state).toBe('not-run');
  });

  it('passes when a check ran after the last edit and passed', () => {
    const result = verificationFor(burst, [cmd({ time: 2500 })]);
    expect(result.state).toBe('passed');
    expect(result.by?.command).toBe('npm test');
    expect(result.by?.evidence).toBe('Tests  99 passed');
  });

  it('fails when the check after the last edit failed', () => {
    const result = verificationFor(burst, [
      cmd({ time: 2500, outcome: 'fail', evidence: 'Tests  1 failed' }),
    ]);
    expect(result.state).toBe('failed');
    expect(result.by?.evidence).toBe('Tests  1 failed');
  });

  it('keeps a failure even when a later run passed', () => {
    // the agent ran tests, they failed, it ran them again and they passed —
    // we cannot tell from outside whether the fix was real, so stay red
    const result = verificationFor(burst, [
      cmd({ time: 2500, outcome: 'fail', evidence: 'Tests  1 failed' }),
      cmd({ time: 3000, outcome: 'pass' }),
    ]);
    expect(result.state).toBe('failed');
  });

  it('is stale when tests ran mid-burst but files changed afterwards', () => {
    // this is the "edited 6 files, ran the tests, edited 2 more" case
    const result = verificationFor(burst, [cmd({ time: 1500 })]);
    expect(result.state).toBe('stale');
    expect(result.by).toBeNull();
    expect(result.checks).toHaveLength(1);
  });

  it('is running while a check has not exited', () => {
    const result = verificationFor(burst, [cmd({ time: 2500, endedAt: undefined, outcome: undefined })]);
    expect(result.state).toBe('running');
  });

  it('says unknown when the output had no verdict', () => {
    const result = verificationFor(burst, [cmd({ time: 2500, outcome: 'unknown', evidence: null })]);
    expect(result.state).toBe('unknown');
  });

  it('ignores commands that belong to a later burst', () => {
    const result = verificationFor(burst, [cmd({ time: 9000 })], 5000);
    expect(result.state).toBe('not-run');
  });

  it('collects every check it saw, oldest first', () => {
    const result = verificationFor(burst, [cmd({ time: 1500 }), cmd({ time: 2500 })]);
    expect(result.checks.map((c) => c.at)).toEqual([1500, 2500]);
  });
});

function makeBurst(over: Partial<ChangeBurst>): ChangeBurst {
  return {
    id: 'b1',
    startedAt: 0,
    endedAt: 0,
    agent: 'claude',
    changed: [],
    removed: [],
    smells: [],
    verification: 'not-run',
    verifiedBy: null,
    checks: [],
    intent: null,
    snapshotHash: null,
    ...over,
  };
}

describe('lastGreen', () => {
  it('finds the newest passing burst that has a snapshot', () => {
    const bursts = [
      makeBurst({ id: 'a', verification: 'passed', snapshotHash: 'h1' }),
      makeBurst({ id: 'b', verification: 'passed', snapshotHash: 'h2' }),
      makeBurst({ id: 'c', verification: 'failed', snapshotHash: 'h3' }),
    ];
    expect(lastGreen(bursts)?.id).toBe('b');
  });

  it('skips a passing burst with no snapshot to restore', () => {
    expect(lastGreen([makeBurst({ verification: 'passed', snapshotHash: null })])).toBeNull();
  });

  it('returns null when nothing ever passed', () => {
    expect(lastGreen([makeBurst({ verification: 'not-run' })])).toBeNull();
  });
});

describe('unverifiedCount', () => {
  it('counts everything that is not-run, stale or failed', () => {
    const bursts = [
      makeBurst({ verification: 'passed' }),
      makeBurst({ verification: 'not-run' }),
      makeBurst({ verification: 'stale' }),
      makeBurst({ verification: 'failed' }),
      makeBurst({ verification: 'running' }),
    ];
    expect(unverifiedCount(bursts)).toBe(3);
  });
});
