import type { HeartbeatMode } from './tasks';

/**
 * The heartbeat: what keeps an agent working after it would have stopped.
 *
 * There is **one** heartbeat, with two mechanisms, and they must never both
 * run — an agent answered by its stop hook *and* typed at by a timer is told
 * to pick up work twice, with the second one arriving in the middle of
 * whatever the first one started.
 *
 * - **On stop** — Flare answers the assistant's stop hook with the state of
 *   the board, so a session that tries to end while a card is workable is
 *   handed that card instead. Set from the Routine wizard. Strictly the better
 *   mechanism: it fires at exactly the moment that matters, polls nothing, and
 *   never types into a shell you might be using.
 * - **On a timer** — when a terminal that was running an agent goes quiet for
 *   long enough, the chosen line is typed into it. This exists for agents with
 *   no such hook, and for sessions that ended because the model simply decided
 *   it was done.
 *
 * They cannot both run because they cannot both be *stored*: the routine holds
 * one `heartbeat` field with three values, so "both on" is not a state the
 * data can express. That is deliberate — the earlier shape was two independent
 * switches kept apart by a rule, and a rule enforced only by a disabled
 * checkbox breaks the first time something else sets the value.
 *
 * This module owns the *policy* — which mechanism is live, and what it is
 * called on screen. `electron/services/heartbeat.ts` is the stop-hook reply
 * itself, and the Routine wizard is where a human sets it.
 */

/**
 * The slice of the routine this module needs.
 *
 * Structural rather than an import of `Routine`, so the policy stays testable
 * without building a whole board — and so it is obvious that these three
 * fields are the entire input.
 */
export interface HeartbeatRoutine {
  heartbeat: HeartbeatMode;
  heartbeatEvery: number;
  heartbeatCommand: string;
}

/**
 * Ten minutes.
 *
 * Long enough that an agent pausing to think is never interrupted, short
 * enough that a night does not go to waste. The failure it guards against is
 * measured in hours, so precision here buys nothing.
 */
export const HEARTBEAT_DEFAULT_MS = 10 * 60_000;

export const HEARTBEAT_INTERVALS = [
  { ms: 2 * 60_000, label: '2 min' },
  { ms: 5 * 60_000, label: '5 min' },
  { ms: HEARTBEAT_DEFAULT_MS, label: '10 min' },
  { ms: 30 * 60_000, label: '30 min' },
  { ms: 60 * 60_000, label: '1 hour' },
];

/**
 * What to send when you have not said otherwise.
 *
 * It names this project's own MCP endpoint rather than saying "carry on",
 * because an agent that has stopped has usually lost the thread — telling it
 * where the board is costs nothing and answers the first question it would
 * otherwise have to ask.
 */
export function defaultHeartbeatCommand(mcpUrl: string | null): string {
  return mcpUrl
    ? `Pick up available tasks from ${mcpUrl}`
    : 'Pick up available tasks from the Flare board';
}

/** A routine's heartbeat fields as they start life: off, with a usable command. */
export function defaultHeartbeatFields(mcpUrl: string | null): HeartbeatRoutine {
  return {
    heartbeat: 'off',
    heartbeatEvery: HEARTBEAT_DEFAULT_MS,
    heartbeatCommand: defaultHeartbeatCommand(mcpUrl),
  };
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

export interface HeartbeatState {
  mode: HeartbeatMode;
  /** the control's own sentence — what is set, in words */
  label: string;
  /** why, and what it will do */
  detail: string;
}

/** "10 min", for the control's label. */
export function intervalLabel(ms: number): string {
  return HEARTBEAT_INTERVALS.find((i) => i.ms === ms)?.label ?? `${Math.round(ms / 60_000)} min`;
}

/**
 * What the heartbeat is, right now, in one sentence.
 *
 * One place answers this so the terminal bar and the Routine wizard can never
 * describe the same setting differently — they are two views of one field, not
 * two settings that happen to agree.
 */
export function heartbeatState(routine: HeartbeatRoutine | null): HeartbeatState {
  const mode = routine?.heartbeat ?? 'off';

  if (mode === 'stop-hook') {
    return {
      mode,
      label: 'Heartbeat set — when the agent stops',
      detail:
        'Flare answers your assistant’s stop hook with the state of the board, so a session that tries to end while a card is workable is handed that card instead. Nothing is typed into a terminal.',
    };
  }

  if (mode === 'timer') {
    const every = intervalLabel(routine?.heartbeatEvery ?? HEARTBEAT_DEFAULT_MS);
    return {
      mode,
      label: `Heartbeat set — every ${every}`,
      detail: `A terminal whose agent has stopped is sent “${routine?.heartbeatCommand ?? ''}” once it has been quiet for ${every}. Only ever a terminal an agent has already used.`,
    };
  }

  return {
    mode,
    label: 'No heartbeat',
    detail:
      'When an agent stops, it stays stopped. Set one in ⚙︎ Routine: answering your assistant’s stop hook where it has one, or prompting a quiet terminal on a timer where it does not.',
  };
}

// ---------------------------------------------------------------------------
// the timer
// ---------------------------------------------------------------------------

export interface HeartbeatInput {
  /** the routine — the single field that says which mechanism is live */
  routine: HeartbeatRoutine | null;
  /** every open terminal */
  terminals: readonly string[];
  /** terminal id -> the agent running in it right now, if any */
  agents: Readonly<Record<string, string | null>>;
  /** terminal id -> when an agent was last seen there (0 = never) */
  agentSeenAt: Readonly<Record<string, number>>;
  /** terminal id -> when we last prompted it (0 = never) */
  promptedAt: Readonly<Record<string, number>>;
  now: number;
}

/**
 * Which terminals are due a prompt.
 *
 * Returns ids rather than doing anything, so the decision is separable from
 * the act of typing into someone's shell.
 *
 * Four gates, and the last two are the ones that matter:
 *
 * - the heartbeat's mode is the timer — the hook covers itself
 * - nothing is running in that terminal — the trigger is "the agent stopped"
 * - the interval has actually elapsed, so a terminal that ignores it is not
 *   prompted again a minute later
 * - **the terminal has hosted an agent at some point this session.** This
 *   types into a live shell, and a shell *you* are working in must never
 *   receive it; having run an agent is the evidence that it is not yours.
 */
export function dueForHeartbeat(input: HeartbeatInput): string[] {
  const { routine, terminals, agents, agentSeenAt, promptedAt, now } = input;
  // not merely "the hook is off": the mode has to be the timer. Anything else
  // — including a mode this build does not know — types nothing into a shell.
  if (routine?.heartbeat !== 'timer') return [];
  if (routine.heartbeatCommand.trim() === '') return [];
  const every = routine.heartbeatEvery > 0 ? routine.heartbeatEvery : HEARTBEAT_DEFAULT_MS;

  return terminals.filter((id) => {
    if (agents[id]) return false;

    const seen = agentSeenAt[id] ?? 0;
    if (seen === 0) return false;

    const since = Math.max(seen, promptedAt[id] ?? 0);
    return now - since >= every;
  });
}
