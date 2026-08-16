import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_DEFAULT_MS,
  defaultHeartbeatCommand,
  defaultHeartbeatFields,
  dueForHeartbeat,
  heartbeatState,
  intervalLabel,
} from '../shared/heartbeat';

/**
 * One heartbeat, two mechanisms.
 *
 * The tests that matter are about when it must *not* fire: while the stop hook
 * is already covering it, into a terminal someone is using, into one with an
 * agent working in it, or twice in a row.
 */

/** the routine, in timer mode — the only mode that types anything */
const timer = {
  heartbeat: 'timer' as const,
  heartbeatEvery: 60_000,
  heartbeatCommand: 'carry on',
};

const base = {
  routine: timer,
  terminals: ['t1'],
  agents: { t1: null },
  agentSeenAt: { t1: 1_000 },
  promptedAt: {},
  now: 1_000 + 60_000,
};

describe('dueForHeartbeat', () => {
  it('prompts a terminal whose agent has been gone for the interval', () => {
    expect(dueForHeartbeat(base)).toEqual(['t1']);
  });

  it('stands down entirely while the stop hook is answering', () => {
    // enforced here and not only in the UI: the modes are exclusive in the
    // data, and this is what makes that true of behaviour as well
    expect(dueForHeartbeat({ ...base, routine: { ...timer, heartbeat: 'stop-hook' } })).toEqual([]);
  });

  it('never prompts a terminal that has not hosted an agent — that is your shell', () => {
    expect(dueForHeartbeat({ ...base, agentSeenAt: { t1: 0 } })).toEqual([]);
    expect(dueForHeartbeat({ ...base, agentSeenAt: {} })).toEqual([]);
  });

  it('leaves a working agent alone', () => {
    expect(dueForHeartbeat({ ...base, agents: { t1: 'claude' } })).toEqual([]);
  });

  it('waits out the interval rather than firing the moment it goes quiet', () => {
    expect(dueForHeartbeat({ ...base, now: 1_000 + 59_000 })).toEqual([]);
  });

  it('does not prompt twice in one interval', () => {
    expect(dueForHeartbeat({ ...base, promptedAt: { t1: base.now - 1 } })).toEqual([]);
    expect(dueForHeartbeat({ ...base, promptedAt: { t1: base.now - 60_000 } })).toEqual(['t1']);
  });

  it('is off unless it was turned on', () => {
    expect(dueForHeartbeat({ ...base, routine: { ...timer, heartbeat: 'off' } })).toEqual([]);
  });

  it('sends nothing when there is nothing to send', () => {
    expect(dueForHeartbeat({ ...base, routine: { ...timer, heartbeatCommand: '   ' } })).toEqual([]);
  });

  it('picks out only the idle terminals when several are open', () => {
    expect(
      dueForHeartbeat({
        ...base,
        terminals: ['t1', 't2', 't3'],
        agents: { t1: null, t2: 'codex', t3: null },
        agentSeenAt: { t1: 1_000, t2: 1_000, t3: 0 },
      }),
    ).toEqual(['t1']);
  });
});

describe('heartbeatState', () => {
  it('says what is set, in words', () => {
    expect(heartbeatState(timer).label).toBe('Heartbeat set — every 1 min');
    expect(heartbeatState({ ...timer, heartbeat: 'stop-hook' }).label).toBe(
      'Heartbeat set — when the agent stops',
    );
    expect(heartbeatState({ ...timer, heartbeat: 'off' }).label).toBe('No heartbeat');
  });

  it('has no state for "both", because the data cannot hold one', () => {
    // the whole point of the enum: there is no combination of inputs that
    // produces two live mechanisms, so there is nothing to block
    expect(heartbeatState({ ...timer, heartbeat: 'stop-hook' }).mode).toBe('stop-hook');
    expect(heartbeatState(timer).mode).toBe('timer');
  });

  it('is off when there is no routine at all', () => {
    expect(heartbeatState(null).mode).toBe('off');
  });

  it('quotes the command it will send, so it can be checked at a glance', () => {
    expect(heartbeatState(timer).detail).toContain('carry on');
    expect(heartbeatState({ ...timer, heartbeat: 'off' }).detail).toContain('Routine');
  });
});

describe('the default', () => {
  it('is off, and points at this project’s own board', () => {
    const d = defaultHeartbeatFields('http://127.0.0.1:7345/mcp/flare');
    expect(d.heartbeat).toBe('off');
    expect(d.heartbeatEvery).toBe(HEARTBEAT_DEFAULT_MS);
    expect(d.heartbeatCommand).toContain('http://127.0.0.1:7345/mcp/flare');
  });

  it('still says something useful before the endpoint is known', () => {
    expect(defaultHeartbeatCommand(null)).toContain('Flare board');
  });

  it('labels an interval', () => {
    expect(intervalLabel(HEARTBEAT_DEFAULT_MS)).toBe('10 min');
    expect(intervalLabel(7 * 60_000)).toBe('7 min');
  });
});
