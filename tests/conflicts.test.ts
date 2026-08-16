import { describe, expect, it } from 'vitest';
import type { ChangeBurst } from '../shared/activity';
import type { Decision } from '../shared/tasks';
import {
  CONCURRENT_MS,
  agentIdOf,
  agentLabelOf,
  changedRanges,
  conflictMarks,
  conflicts,
  contestedBy,
  dependentsMap,
  overlapLines,
} from '../shared/conflicts';

/**
 * Where two agents got in each other's way.
 *
 * The bar matters in both directions, as it does for risk alerts: a mark on
 * the map for every pair of edits is noise, and an agent silently rewriting
 * another one's work is the whole reason this exists.
 */

function burst(over: Partial<ChangeBurst> & Pick<ChangeBurst, 'id' | 'changed'>): ChangeBurst {
  const at = over.endedAt ?? 1_000;
  return {
    startedAt: at - 100,
    endedAt: at,
    agent: 'claude',
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

/** Two agents, told apart by terminal — the thing `agent` alone cannot do. */
const one = { agentId: 'claude:t1', agentLabel: 'Refactor auth' };
const two = { agentId: 'claude:t2', agentLabel: 'Add OAuth' };

describe('agent identity', () => {
  it('prefers the terminal-scoped id over the tool name', () => {
    const b = burst({ id: 'b1', changed: [], ...one });
    expect(agentIdOf(b)).toBe('claude:t1');
    expect(agentLabelOf(b)).toBe('Refactor auth');
  });

  it('falls back to the tool name when the session could not pin a terminal down', () => {
    const b = burst({ id: 'b1', changed: [] });
    expect(agentIdOf(b)).toBe('claude');
    expect(agentLabelOf(b)).toBe('claude');
  });
});

describe('changedRanges', () => {
  it('is empty for an unchanged file', () => {
    expect(changedRanges('a\nb\nc', 'a\nb\nc')).toEqual([]);
  });

  it('trims the common prefix and suffix', () => {
    expect(changedRanges('a\nb\nc', 'a\nX\nc')).toEqual([[2, 2]]);
  });

  it('covers the whole file when it is new', () => {
    expect(changedRanges(null, 'a\nb')).toEqual([[1, 2]]);
  });

  it('marks the seam when lines are only deleted', () => {
    expect(changedRanges('a\nb\nc', 'a\nc')).toEqual([[2, 2]]);
  });
});

describe('overlapLines', () => {
  it('counts the lines two writes have in common', () => {
    expect(overlapLines([[1, 10]], [[5, 20]])).toBe(6);
  });

  it('is zero for writes that do not touch', () => {
    expect(overlapLines([[1, 4]], [[5, 9]])).toBe(0);
  });
});

describe('contested files', () => {
  const bursts = [
    burst({ id: 'b1', changed: ['auth/session.py'], endedAt: 1_000, ...one }),
    burst({ id: 'b2', changed: ['auth/session.py'], endedAt: 2_000, ...two }),
  ];

  it('flags a file two agents both wrote', () => {
    const [c] = conflicts({ bursts });
    expect(c.kind).toBe('contested-file');
    expect(c.paths).toEqual(['auth/session.py']);
    expect(c.summary).toContain('Add OAuth');
    expect(c.summary).toContain('Refactor auth');
  });

  it('says nothing when the same agent edits a file twice', () => {
    const same = [
      burst({ id: 'b1', changed: ['auth/session.py'], endedAt: 1_000, ...one }),
      burst({ id: 'b2', changed: ['auth/session.py'], endedAt: 2_000, ...one }),
    ];
    expect(conflicts({ bursts: same })).toEqual([]);
  });

  it('does not tell two concurrent claudes apart without a terminal id', () => {
    const blind = [
      burst({ id: 'b1', changed: ['auth/session.py'], endedAt: 1_000 }),
      burst({ id: 'b2', changed: ['auth/session.py'], endedAt: 2_000 }),
    ];
    expect(conflicts({ bursts: blind })).toEqual([]);
  });

  it('ignores the human editing after an agent, unless asked', () => {
    const withYou = [
      burst({ id: 'b1', changed: ['auth/session.py'], endedAt: 1_000, ...one }),
      burst({ id: 'b2', changed: ['auth/session.py'], endedAt: 2_000, agent: 'you', agentId: 'you' }),
    ];
    expect(conflicts({ bursts: withYou })).toEqual([]);
    expect(conflicts({ bursts: withYou, includeHuman: true })).toHaveLength(1);
  });

  it('ignores bursts it could not attribute', () => {
    const mixed = [
      burst({ id: 'b1', changed: ['a.ts'], endedAt: 1_000, agent: 'mixed', agentId: 'mixed' }),
      burst({ id: 'b2', changed: ['a.ts'], endedAt: 2_000, ...two }),
    ];
    expect(conflicts({ bursts: mixed })).toEqual([]);
  });

  it('reports one standing fact per pair per file, however many times they trade', () => {
    const traded = [
      burst({ id: 'b1', changed: ['a.ts'], endedAt: 1_000, ...one }),
      burst({ id: 'b2', changed: ['a.ts'], endedAt: 2_000, ...two }),
      burst({ id: 'b3', changed: ['a.ts'], endedAt: 3_000, ...one }),
      burst({ id: 'b4', changed: ['a.ts'], endedAt: 4_000, ...two }),
    ];
    const out = conflicts({ bursts: traded });
    expect(out).toHaveLength(1);
    expect(out[0].at).toBe(4_000); // the newest crossing — the one still on disk
  });

  it('offers the two agents for the ring on the graph', () => {
    const out = conflicts({ bursts });
    expect(contestedBy(out, 'auth/session.py').map((p) => p.label).sort()).toEqual([
      'Add OAuth',
      'Refactor auth',
    ]);
    expect(contestedBy(out, 'untouched.ts')).toEqual([]);
  });
});

describe('overwritten work', () => {
  const bursts = [
    burst({ id: 'b1', changed: ['db/pool.py'], endedAt: 1_000, ...one }),
    burst({ id: 'b2', changed: ['db/pool.py'], endedAt: 2_000, ...two }),
  ];

  it('quantifies the loss when the two writes share lines', () => {
    const [c] = conflicts({
      bursts,
      edits: [
        { burstId: 'b1', path: 'db/pool.py', ranges: [[10, 23]] },
        { burstId: 'b2', path: 'db/pool.py', ranges: [[12, 30]] },
      ],
    });
    expect(c.kind).toBe('overwritten');
    expect(c.severity).toBe('critical');
    expect(c.summary).toBe('Add OAuth replaced 12 of the 14 lines Refactor auth wrote in db/pool.py');
  });

  it('stays a contested file when the two writes are in different places', () => {
    const [c] = conflicts({
      bursts,
      edits: [
        { burstId: 'b1', path: 'db/pool.py', ranges: [[10, 20]] },
        { burstId: 'b2', path: 'db/pool.py', ranges: [[80, 90]] },
      ],
    });
    expect(c.kind).toBe('contested-file');
    expect(c.severity).toBe('warning');
  });

  it('outranks a contested file in the ordering', () => {
    const both = [
      burst({ id: 'b1', changed: ['a.ts'], endedAt: 1_000, ...one }),
      burst({ id: 'b2', changed: ['a.ts'], endedAt: 2_000, ...two }),
      burst({ id: 'b3', changed: ['b.ts'], endedAt: 3_000, ...one }),
      burst({ id: 'b4', changed: ['b.ts'], endedAt: 4_000, ...two }),
    ];
    const out = conflicts({
      bursts: both,
      edits: [
        { burstId: 'b1', path: 'a.ts', ranges: [[1, 5]] },
        { burstId: 'b2', path: 'a.ts', ranges: [[1, 5]] },
      ],
    });
    expect(out.map((c) => c.kind)).toEqual(['overwritten', 'contested-file']);
  });
});

describe('blast collisions', () => {
  const dependents = new Map([['auth/session.py', ['routes.ts', 'oauth/flow.py']]]);

  it('flags an agent changing a module another agent is building on', () => {
    const bursts = [
      burst({ id: 'b1', changed: ['auth/session.py'], endedAt: 1_000, ...one }),
      burst({ id: 'b2', changed: ['oauth/flow.py'], endedAt: 1_500, startedAt: 1_400, ...two }),
    ];
    const [c] = conflicts({ bursts, dependents });
    expect(c.kind).toBe('blast-collision');
    expect(c.summary).toBe("Refactor auth changed auth/session.py, which Add OAuth's work imports");
    expect(c.paths).toEqual(['auth/session.py', 'oauth/flow.py']);
  });

  it('says nothing when the second agent was nowhere near in time', () => {
    const bursts = [
      burst({ id: 'b1', changed: ['auth/session.py'], endedAt: 1_000, ...one }),
      burst({
        id: 'b2',
        changed: ['oauth/flow.py'],
        startedAt: 1_000 + CONCURRENT_MS + 1,
        endedAt: 1_000 + CONCURRENT_MS + 100,
        ...two,
      }),
    ];
    expect(conflicts({ bursts, dependents })).toEqual([]);
  });

  it('says nothing when nothing downstream was being edited', () => {
    const bursts = [
      burst({ id: 'b1', changed: ['auth/session.py'], endedAt: 1_000, ...one }),
      burst({ id: 'b2', changed: ['unrelated.ts'], startedAt: 1_400, endedAt: 1_500, ...two }),
    ];
    expect(conflicts({ bursts, dependents })).toEqual([]);
  });

  it('is critical when the file is load-bearing', () => {
    const bursts = [
      burst({ id: 'b1', changed: ['auth/session.py'], endedAt: 1_000, ...one }),
      burst({ id: 'b2', changed: ['oauth/flow.py'], startedAt: 1_400, endedAt: 1_500, ...two }),
    ];
    const metrics = new Map([
      [
        'auth/session.py',
        {
          path: 'auth/session.py',
          risk: 90,
          blastRadius: 31,
          fanIn: 9,
          coveragePct: null,
          testedBy: 0,
          complexity: 20,
          inCycle: false,
          isTest: false,
        },
      ],
    ]);
    const [c] = conflicts({ bursts, dependents, metrics });
    expect(c.severity).toBe('critical');
    expect(c.detail).toContain('31 files break');
  });
});

describe('contradictory decisions', () => {
  function decision(over: Partial<Decision> & Pick<Decision, 'id' | 'title' | 'by' | 'paths'>): Decision {
    return {
      detail: '',
      alternatives: '',
      status: 'proposed',
      at: 1_000,
      verdict: '',
      decidedAt: null,
      ...over,
    };
  }

  it('flags two agents proposing different calls on the same files', () => {
    const [c] = conflicts({
      bursts: [],
      decisions: [
        decision({ id: 'd1', title: 'Session store in Redis', by: 'claude:t1', paths: ['db/pool.py'], at: 1_000 }),
        decision({ id: 'd2', title: 'Session store in Postgres', by: 'claude:t2', paths: ['db/pool.py'], at: 2_000 }),
      ],
    });
    expect(c.kind).toBe('contradictory-decision');
    expect(c.detail).toContain('Session store in Postgres');
    expect(c.detail).toContain('Session store in Redis');
  });

  it('leaves settled decisions alone', () => {
    expect(
      conflicts({
        bursts: [],
        decisions: [
          decision({ id: 'd1', title: 'A', by: 'claude:t1', paths: ['a.ts'], status: 'agreed' }),
          decision({ id: 'd2', title: 'B', by: 'claude:t2', paths: ['a.ts'] }),
        ],
      }),
    ).toEqual([]);
  });

  it('leaves one agent revising its own proposal alone', () => {
    expect(
      conflicts({
        bursts: [],
        decisions: [
          decision({ id: 'd1', title: 'A', by: 'claude:t1', paths: ['a.ts'] }),
          decision({ id: 'd2', title: 'B', by: 'claude:t1', paths: ['a.ts'] }),
        ],
      }),
    ).toEqual([]);
  });
});

describe('divergent duplicates', () => {
  /*
   * The crossing that leaves no other trace: nothing overwritten, no shared
   * file, no dependency disturbed — so if this detector is wrong in either
   * direction there is no second chance to catch it.
   */
  const bursts = [
    burst({ id: 'b1', changed: ['auth/refresh.ts'], endedAt: 1_000, ...one }),
    burst({ id: 'b2', changed: ['oauth/token.ts'], endedAt: 2_000, ...two }),
  ];
  const added = [
    { burstId: 'b1', path: 'auth/refresh.ts', ranges: [[1, 20] as const], added: true },
    { burstId: 'b2', path: 'oauth/token.ts', ranges: [[1, 18] as const], added: true },
  ];
  const shape = (exports: string[], fanIn = 0) => ({ exports, fanIn });

  it('flags two new files that export the same thing', () => {
    const [c] = conflicts({
      bursts,
      edits: added,
      nodes: new Map([
        ['auth/refresh.ts', shape(['refreshToken'])],
        ['oauth/token.ts', shape(['refreshToken'])],
      ]),
    });
    expect(c.kind).toBe('divergent-duplicate');
    expect(c.summary).toBe('Add OAuth and Refactor auth each wrote a new refreshToken');
    expect(c.paths.sort()).toEqual(['auth/refresh.ts', 'oauth/token.ts']);
  });

  it('says nothing when the files were edited rather than created', () => {
    expect(
      conflicts({
        bursts,
        edits: added.map((e) => ({ ...e, added: false })),
        nodes: new Map([
          ['auth/refresh.ts', shape(['refreshToken'])],
          ['oauth/token.ts', shape(['refreshToken'])],
        ]),
      }),
    ).toEqual([]);
  });

  it('says nothing once something imports one of them — the codebase has picked', () => {
    expect(
      conflicts({
        bursts,
        edits: added,
        nodes: new Map([
          ['auth/refresh.ts', shape(['refreshToken'], 3)],
          ['oauth/token.ts', shape(['refreshToken'])],
        ]),
      }),
    ).toEqual([]);
  });

  it('says nothing when two new files merely share one name out of many', () => {
    expect(
      conflicts({
        bursts,
        edits: added,
        nodes: new Map([
          ['auth/refresh.ts', shape(['a', 'b', 'c', 'init'])],
          ['oauth/token.ts', shape(['x', 'y', 'z', 'init'])],
        ]),
      }),
    ).toEqual([]);
  });

  it('still catches a small helper duplicated inside a larger new module', () => {
    const [c] = conflicts({
      bursts,
      edits: added,
      nodes: new Map([
        ['auth/refresh.ts', shape(['refreshToken'])],
        ['oauth/token.ts', shape(['refreshToken', 'a', 'b', 'c', 'd', 'e'])],
      ]),
    });
    expect(c?.kind).toBe('divergent-duplicate');
  });

  it('leaves one agent creating two similar files alone', () => {
    expect(
      conflicts({
        bursts: [
          burst({ id: 'b1', changed: ['auth/refresh.ts'], endedAt: 1_000, ...one }),
          burst({ id: 'b2', changed: ['oauth/token.ts'], endedAt: 2_000, ...one }),
        ],
        edits: added,
        nodes: new Map([
          ['auth/refresh.ts', shape(['refreshToken'])],
          ['oauth/token.ts', shape(['refreshToken'])],
        ]),
      }),
    ).toEqual([]);
  });

  it('ignores new files that export nothing', () => {
    expect(
      conflicts({
        bursts,
        edits: added,
        nodes: new Map([
          ['auth/refresh.ts', shape([])],
          ['oauth/token.ts', shape([])],
        ]),
      }),
    ).toEqual([]);
  });

  it('needs the graph: without shapes it cannot tell duplicates from new files', () => {
    expect(conflicts({ bursts, edits: added })).toEqual([]);
  });
});

describe('dependentsMap', () => {
  const edges = [
    { source: 'routes.ts', target: 'auth/session.py' },
    { source: 'app.ts', target: 'routes.ts' },
    { source: 'unrelated.ts', target: 'other.ts' },
  ];

  it('follows imports transitively', () => {
    const map = dependentsMap(edges, ['auth/session.py']);
    expect(map.get('auth/session.py')?.sort()).toEqual(['app.ts', 'routes.ts']);
  });

  it('is empty for a file nothing imports', () => {
    expect(dependentsMap(edges, ['app.ts']).get('app.ts')).toEqual([]);
  });

  it('does not loop forever on an import cycle', () => {
    const cyclic = [
      { source: 'a.ts', target: 'b.ts' },
      { source: 'b.ts', target: 'a.ts' },
    ];
    expect(dependentsMap(cyclic, ['a.ts']).get('a.ts')).toEqual(['b.ts']);
  });
});

describe('conflictMarks', () => {
  /*
   * Three graph views draw these, so the indexing lives in one place. What
   * matters here is that the two shapes stay separate: a contested file is a
   * fact about a *node*, a collision is a fact about an *edge*, and swapping
   * them would paint the wrong thing on the map.
   */
  it('indexes contested files by path and collisions by edge', () => {
    const bursts = [
      burst({ id: 'b1', changed: ['auth/session.py'], endedAt: 1_000, ...one }),
      burst({ id: 'b2', changed: ['auth/session.py'], endedAt: 2_000, ...two }),
      burst({ id: 'b3', changed: ['db/pool.py'], endedAt: 3_000, ...one }),
      burst({ id: 'b4', changed: ['cache.ts'], startedAt: 3_100, endedAt: 3_200, ...two }),
    ];
    const { contested, collisions } = conflictMarks(
      conflicts({ bursts, dependents: new Map([['db/pool.py', ['cache.ts']]]) }),
    );

    expect(contested.get('auth/session.py')?.map((p) => p.label).sort()).toEqual([
      'Add OAuth',
      'Refactor auth',
    ]);
    expect(contested.has('db/pool.py')).toBe(false);
    expect(collisions.get('cache.ts\ndb/pool.py')).toContain('db/pool.py');
    expect(collisions.has('db/pool.py\ncache.ts')).toBe(false); // direction matters
  });

  it('is empty when nothing crossed', () => {
    expect(conflictMarks([])).toEqual({ contested: new Map(), collisions: new Map() });
  });
});

describe('the queue', () => {
  it('drops what has been dismissed', () => {
    const bursts = [
      burst({ id: 'b1', changed: ['a.ts'], endedAt: 1_000, ...one }),
      burst({ id: 'b2', changed: ['a.ts'], endedAt: 2_000, ...two }),
    ];
    const [c] = conflicts({ bursts });
    expect(conflicts({ bursts, dismissed: new Set([c.id]) })).toEqual([]);
  });

  it('keeps the id stable whichever way round the pair is read', () => {
    const forward = conflicts({
      bursts: [
        burst({ id: 'b1', changed: ['a.ts'], endedAt: 1_000, ...one }),
        burst({ id: 'b2', changed: ['a.ts'], endedAt: 2_000, ...two }),
      ],
    });
    const backward = conflicts({
      bursts: [
        burst({ id: 'b1', changed: ['a.ts'], endedAt: 1_000, ...two }),
        burst({ id: 'b2', changed: ['a.ts'], endedAt: 2_000, ...one }),
      ],
    });
    expect(forward[0].id).toBe(backward[0].id);
  });

  it('caps the queue', () => {
    const many: ChangeBurst[] = [];
    for (let i = 0; i < 60; i++) {
      many.push(burst({ id: `a${i}`, changed: [`f${i}.ts`], endedAt: i * 10, ...one }));
      many.push(burst({ id: `b${i}`, changed: [`f${i}.ts`], endedAt: i * 10 + 5, ...two }));
    }
    expect(conflicts({ bursts: many, limit: 20 })).toHaveLength(20);
  });
});
