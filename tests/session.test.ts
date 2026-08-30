import { describe, expect, it } from 'vitest';
import type { ChangeBurst } from '../shared/activity';
import {
  auditSummary,
  burstsFor,
  formatAudit,
  type Chapter,
  type SessionSummary,
} from '../shared/session';

/**
 * What an agent says it did, checked against what Flare watched it do.
 *
 * A summary is a claim, and an agent grading its own homework is the oldest
 * failure mode there is — so the only part of this worth testing is the part
 * that disagrees with it. Three ways it can, and each has to survive:
 *
 * - a chapter naming files that never changed (work described that did not
 *   happen),
 * - files that changed and no chapter mentions (the omission, which is the
 *   one a reader cannot catch for themselves),
 * - a chapter whose files nothing has verified.
 */

const T0 = 1_700_000_000_000;

function burst(over: Partial<ChangeBurst> & Pick<ChangeBurst, 'id' | 'changed'>): ChangeBurst {
  const at = over.endedAt ?? T0 + 1_000;
  return {
    startedAt: at - 100,
    endedAt: at,
    agent: 'claude',
    agentId: 'mcp:a',
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

function chapter(over: Partial<Chapter> & Pick<Chapter, 'title'>): Chapter {
  return { detail: '', paths: [], outcome: 'done', ...over };
}

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    by: 'mcp:a',
    byName: 'Claude 1',
    at: T0 + 5_000,
    from: T0,
    to: T0 + 5_000,
    headline: 'Moved the workspace lookup into the graph builder',
    chapters: [],
    ...over,
  };
}

describe('burstsFor', () => {
  it('is its own author, inside its own window', () => {
    const mine = burst({ id: 'b1', changed: ['a.ts'] });
    const theirs = burst({ id: 'b2', changed: ['b.ts'], agentId: 'mcp:b' });
    const later = burst({ id: 'b3', changed: ['c.ts'], endedAt: T0 + 90_000 });
    expect(burstsFor(summary(), [mine, theirs, later]).map((b) => b.id)).toEqual(['b1']);
  });

  it('falls back to the tool name for a burst with no session id', () => {
    const yours = burst({ id: 'b1', changed: ['a.ts'], agent: 'you', agentId: undefined });
    expect(burstsFor(summary({ by: 'you' }), [yours]).map((b) => b.id)).toEqual(['b1']);
  });
});

describe('auditSummary', () => {
  it('binds a chapter to the files it named that really changed', () => {
    const audit = auditSummary(
      summary({ chapters: [chapter({ title: 'The lookup', paths: ['shared/graph.ts'] })] }),
      [burst({ id: 'b1', changed: ['shared/graph.ts'] })],
    );
    expect(audit.chapters[0].changed).toEqual(['shared/graph.ts']);
    expect(audit.chapters[0].absent).toEqual([]);
    expect(audit).toMatchObject({ accounted: 1, total: 1, unaccounted: [] });
  });

  /*
   * Prose describing work that did not happen is the one kind of wrong a
   * reader cannot catch from the diff, because there is no diff to catch it
   * in.
   */
  it('marks a file a chapter names and never changed', () => {
    const audit = auditSummary(
      summary({
        chapters: [chapter({ title: 'The lookup', paths: ['shared/graph.ts', 'shared/resolver.ts'] })],
      }),
      [burst({ id: 'b1', changed: ['shared/graph.ts'] })],
    );
    expect(audit.chapters[0].absent).toEqual(['shared/resolver.ts']);
  });

  /*
   * The line that makes the rest of it worth reading: a summary is only as
   * good as what it leaves out.
   */
  it('reports the files that changed and no chapter mentions', () => {
    const audit = auditSummary(
      summary({ chapters: [chapter({ title: 'The lookup', paths: ['shared/graph.ts'] })] }),
      [burst({ id: 'b1', changed: ['shared/graph.ts', 'server/index.ts', 'src/App.tsx'] })],
    );
    expect(audit.unaccounted.sort()).toEqual(['server/index.ts', 'src/App.tsx']);
    expect(audit).toMatchObject({ accounted: 1, total: 3 });
  });

  it('lets a chapter cover a folder', () => {
    const audit = auditSummary(
      summary({ chapters: [chapter({ title: 'All of shared', paths: ['shared'] })] }),
      [burst({ id: 'b1', changed: ['shared/graph.ts', 'shared/resolver.ts'] })],
    );
    expect(audit.chapters[0].changed.sort()).toEqual(['shared/graph.ts', 'shared/resolver.ts']);
    expect(audit.unaccounted).toEqual([]);
  });

  it('counts a deletion as accounted for', () => {
    const audit = auditSummary(
      summary({ chapters: [chapter({ title: 'Dropped the shim', paths: ['shared/shim.ts'] })] }),
      [burst({ id: 'b1', changed: [], removed: ['shared/shim.ts'] })],
    );
    expect(audit.chapters[0].changed).toEqual(['shared/shim.ts']);
    expect(audit.unaccounted).toEqual([]);
  });

  it('does not audit against another agents writes', () => {
    const audit = auditSummary(
      summary({ chapters: [chapter({ title: 'Mine', paths: ['a.ts'] })] }),
      [burst({ id: 'b1', changed: ['a.ts'] }), burst({ id: 'b2', changed: ['b.ts'], agentId: 'mcp:b' })],
    );
    expect(audit.unaccounted).toEqual([]);
    expect(audit.total).toBe(1);
  });

  describe('verification', () => {
    it('is passed only when the burst that last wrote the files passed', () => {
      const audit = auditSummary(
        summary({ chapters: [chapter({ title: 'The lookup', paths: ['a.ts'] })] }),
        [burst({ id: 'b1', changed: ['a.ts'], verification: 'passed' })],
      );
      expect(audit.chapters[0].verified).toBe('passed');
    });

    it('is failed if any of them last landed on a failed check', () => {
      const audit = auditSummary(
        summary({ chapters: [chapter({ title: 'Both', paths: ['a.ts', 'b.ts'] })] }),
        [
          burst({ id: 'b1', changed: ['a.ts'], verification: 'passed' }),
          burst({ id: 'b2', changed: ['b.ts'], endedAt: T0 + 2_000, verification: 'failed' }),
        ],
      );
      expect(audit.chapters[0].verified).toBe('failed');
    });

    it('is unchecked when nothing ran, however confident the prose', () => {
      const audit = auditSummary(
        summary({ chapters: [chapter({ title: 'The lookup', paths: ['a.ts'] })] }),
        [burst({ id: 'b1', changed: ['a.ts'] })],
      );
      expect(audit.chapters[0].verified).toBe('unchecked');
    });
  });
});

describe('formatAudit', () => {
  /*
   * Written to be acted on rather than filed: an agent that reads this while
   * it is still running can fix its own summary, and the version a human
   * eventually reads is the corrected one.
   */
  it('tells the agent exactly what it left out', () => {
    const text = formatAudit(
      auditSummary(
        summary({
          chapters: [chapter({ title: 'The lookup', paths: ['shared/graph.ts', 'never.ts'] })],
        }),
        [burst({ id: 'b1', changed: ['shared/graph.ts', 'server/index.ts'] })],
      ),
    );
    expect(text).toContain('account for 1 of the 2 files');
    expect(text).toContain('never.ts');
    expect(text).toContain('Not mentioned anywhere: server/index.ts');
    expect(text).toContain('nothing has checked');
  });

  it('says so plainly when there is nothing to check it against', () => {
    expect(formatAudit(auditSummary(summary(), []))).toContain('did not attribute any file changes');
  });
});
