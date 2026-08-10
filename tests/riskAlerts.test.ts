import { describe, expect, it } from 'vitest';
import type { ChangeBurst } from '../shared/activity';
import type { TierInput } from '../shared/review';
import { alertId, riskAlerts, ALERT_LIMIT } from '../shared/riskAlerts';

/**
 * Which changes earn an interruption.
 *
 * The bar matters in both directions: a popup for every edit is noise nobody
 * reads, and a load-bearing file rewritten while you were on another tab is
 * exactly the thing this exists to catch.
 */

function burst(id: string, changed: string[], at = 1_000): ChangeBurst {
  return {
    id,
    startedAt: at - 100,
    endedAt: at,
    agent: 'claude',
    changed,
    removed: [],
    smells: [],
    verification: 'not-run',
    verifiedBy: null,
    checks: [],
    intent: null,
    snapshotHash: null,
  };
}

/** A file that is load-bearing and untested — careful, on concrete grounds. */
function risky(path: string, over: Partial<TierInput> = {}): TierInput {
  return {
    path,
    risk: 100,
    blastRadius: 9,
    fanIn: 4,
    coveragePct: null,
    testedBy: 0,
    complexity: 20,
    inCycle: false,
    isTest: false,
    ...over,
  };
}

const metrics = (...files: TierInput[]): Map<string, TierInput> =>
  new Map(files.map((f) => [f.path, f]));

describe('what queues', () => {
  it('queues a load-bearing untested file, with the reasons the review rows give', () => {
    const [alert, ...rest] = riskAlerts({
      bursts: [burst('b1', ['src/types.ts'])],
      metrics: metrics(risky('src/types.ts')),
    });
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({
      id: alertId('b1', 'src/types.ts'),
      path: 'src/types.ts',
      burstId: 'b1',
      agent: 'claude',
      at: 1_000,
    });
    expect(alert.reasons).toEqual(['9 files break if this is wrong', 'no test covers it']);
  });

  it('carries when the burst began, so answering it can find the state before it', () => {
    const [alert] = riskAlerts({
      bursts: [burst('b1', ['src/types.ts'], 5_000)],
      metrics: metrics(risky('src/types.ts')),
    });
    expect(alert.startedAt).toBe(4_900);
  });

  it('says nothing about an ordinary edit', () => {
    // a leaf file nothing imports: the review tab lists it, and that is enough
    const leaf = risky('src/leaf.ts', { risk: 10, blastRadius: 0, fanIn: 0 });
    expect(riskAlerts({ bursts: [burst('b1', ['src/leaf.ts'])], metrics: metrics(leaf) })).toEqual([]);
  });

  it('does not fire just because a file is the worst one in a quiet repo', () => {
    /*
     * risk is a ranking within the repo, so its top file scores 100 even when
     * the repo is three files and none of them matter. Without an absolute
     * second gate, opening any project and touching anything would pop an
     * alert — which teaches people to close the thing unread.
     */
    const topOfATinyRepo = risky('src/only.ts', {
      risk: 100,
      blastRadius: 1,
      fanIn: 1,
      complexity: 4,
      coveragePct: 90,
      testedBy: 1,
    });
    expect(
      riskAlerts({ bursts: [burst('b1', ['src/only.ts'])], metrics: metrics(topOfATinyRepo) }),
    ).toEqual([]);
  });

  it('queues a file in an import cycle, and one that is simply enormous', () => {
    const cyclic = risky('src/a.ts', { risk: 40, blastRadius: 1, fanIn: 1, inCycle: true });
    const huge = risky('src/b.ts', { risk: 70, blastRadius: 0, fanIn: 0, complexity: 90 });
    const queued = riskAlerts({
      bursts: [burst('b1', ['src/a.ts', 'src/b.ts'])],
      metrics: metrics(cyclic, huge),
    });
    expect(queued.map((a) => a.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('leaves tests and vanished files alone', () => {
    const spec = risky('src/util.test.ts', { isTest: true });
    const queued = riskAlerts({
      bursts: [burst('b1', ['src/util.test.ts', 'src/gone.ts'])],
      metrics: metrics(spec),
    });
    expect(queued).toEqual([]);
  });
});

describe('the queue itself', () => {
  it('shows one card per file, for its most recent change', () => {
    const queued = riskAlerts({
      bursts: [burst('b1', ['src/types.ts'], 1_000), burst('b2', ['src/types.ts'], 2_000)],
      metrics: metrics(risky('src/types.ts')),
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ burstId: 'b2', at: 2_000 });
  });

  it('puts the newest first', () => {
    const queued = riskAlerts({
      bursts: [burst('b1', ['src/old.ts'], 1_000), burst('b2', ['src/new.ts'], 2_000)],
      metrics: metrics(risky('src/old.ts'), risky('src/new.ts')),
    });
    expect(queued.map((a) => a.path)).toEqual(['src/new.ts', 'src/old.ts']);
  });

  it('drops what has been dismissed, and only that', () => {
    const bursts = [burst('b1', ['src/a.ts', 'src/b.ts'])];
    const all = { bursts, metrics: metrics(risky('src/a.ts'), risky('src/b.ts')) };
    const queued = riskAlerts({ ...all, dismissed: new Set([alertId('b1', 'src/a.ts')]) });
    expect(queued.map((a) => a.path)).toEqual(['src/b.ts']);
  });

  it('brings the same file back when it changes again after being dismissed', () => {
    // the answer was "I have seen that edit", not "stop telling me about this file"
    const dismissed = new Set([alertId('b1', 'src/types.ts')]);
    const queued = riskAlerts({
      bursts: [burst('b1', ['src/types.ts'], 1_000), burst('b2', ['src/types.ts'], 2_000)],
      metrics: metrics(risky('src/types.ts')),
      dismissed,
    });
    expect(queued.map((a) => a.burstId)).toEqual(['b2']);
  });

  it('drops a file approved since the burst, but not one approved before it', () => {
    const bursts = [burst('b1', ['src/a.ts'], 2_000)];
    const input = { bursts, metrics: metrics(risky('src/a.ts')) };
    expect(riskAlerts({ ...input, approvedAt: { 'src/a.ts': 3_000 } })).toEqual([]);
    expect(riskAlerts({ ...input, approvedAt: { 'src/a.ts': 1_000 } })).toHaveLength(1);
  });

  it('stops queueing rather than growing without bound', () => {
    const paths = Array.from({ length: ALERT_LIMIT + 5 }, (_, i) => `src/f${i}.ts`);
    const queued = riskAlerts({
      bursts: [burst('b1', paths)],
      metrics: metrics(...paths.map((p) => risky(p))),
    });
    expect(queued).toHaveLength(ALERT_LIMIT);
    expect(riskAlerts({ bursts: [burst('b1', paths)], metrics: metrics(...paths.map((p) => risky(p))), limit: 3 })).toHaveLength(3);
  });

  it('is empty when nothing has happened', () => {
    expect(riskAlerts({ bursts: [], metrics: new Map() })).toEqual([]);
  });
});
