/**
 * Which agent wrote this.
 *
 * The watcher sees a file change; it does not see who changed it. Everything
 * downstream — conflict detection, the coloured rings, the time machine's
 * lanes — rests on an answer to that, and the obvious answer is wrong in the
 * one case that matters: process presence proves an agent is *running*, not
 * that it *wrote*, so two live `claude` sessions are both equally "present"
 * in every sample and neither can be picked at a 150ms poll's resolution.
 *
 * So we do not pick by presence. We pick by *work*: an agent claims a task by
 * moving it to in-progress, the task names the files it concerns, and a write
 * to one of those files belongs to whoever claimed it. That is a semantic
 * identity rather than a process one, which makes it both more accurate and
 * better to read — "Add OAuth" is a more useful thing to see on a node ring
 * than "claude:t2".
 *
 * Four rungs, and it says which one it used rather than guessing past the end
 * of what it knows:
 *
 * 1. **a recorded intent** — an agent said "I am about to change this" over
 *    MCP, and its session id is the one identity here that nothing else can
 *    impersonate
 * 2. **the claim** — the written files belong to exactly one in-progress task
 * 3. **the only agent running** — no claim to go on, but only one candidate
 * 4. **`mixed`** — several agents live and nothing to separate them. Honest,
 *    and the detectors in shared/conflicts.ts skip it rather than inventing a
 *    crossing between an agent and itself.
 *
 * Intent outranks the claim, and that order is the whole point. The claim
 * attributes by *path*, so an agent editing a file listed on someone else's
 * card gets recorded as that other agent — which silently erases the crossing
 * rather than reporting it. An agent that announced the edit has said who it
 * is, and that beats an inference from where the file lives.
 */

/** One agent seen running, and where. Structurally what the monitor reports. */
export interface LiveAgentInfo {
  terminalId: string;
  /** the tool: 'claude', 'codex', … */
  agent: string;
  at: number;
}

/** An in-progress task — a claimed piece of work, with the files it covers. */
export interface TaskClaim {
  id: string;
  title: string;
  paths: readonly string[];
  /** who last wrote to it: an agent name, or 'you' */
  by: string;
}

/**
 * An agent that announced an edit over MCP and has not yet been overtaken.
 *
 * `id` is its MCP session — the only handle here that another agent cannot
 * accidentally answer to. `label` is whatever task that same session claimed,
 * so the ring on the graph can say "Add OAuth" instead of an opaque id.
 */
export interface RecordedIntent {
  id: string;
  label: string | null;
  /** the tool it is running under, when the process list could say */
  tool: string | null;
  at: number;
}

export interface AttributionInput {
  /** the files in this write */
  paths: readonly string[];
  /** agents running right now, most recently seen first */
  live: readonly LiveAgentInfo[];
  /** tasks currently in progress */
  claims: readonly TaskClaim[];
  /** the most recent `record_intent`, if one is still in force */
  intent?: RecordedIntent | null;
  /** now, injected so this stays pure */
  now?: number;
}

/**
 * How long a recorded intent speaks for the writes that follow it.
 *
 * Long enough to cover an agent thinking between edits in one piece of work,
 * short enough that an intent from an hour ago stops claiming writes made by
 * whoever came next. An agent that keeps working keeps calling it.
 */
export const INTENT_TTL_MS = 10 * 60_000;

export interface Attributed {
  /** the tool, as the rest of the app has always understood it */
  agent: string;
  /** stable identity for this agent session, absent when we could not tell */
  agentId?: string;
  /** what to call it on screen */
  agentLabel?: string;
  /** which rung answered — for the tooltip that explains why it says what it says */
  basis: 'intent' | 'claim' | 'sole-agent' | 'unknown';
}

/** Does a task's path list cover this file? Directory entries cover what is under them. */
export function claimCovers(claimPaths: readonly string[], path: string): boolean {
  for (const p of claimPaths) {
    if (p === path) return true;
    if (path.startsWith(p.endsWith('/') ? p : `${p}/`)) return true;
  }
  return false;
}

/**
 * Who to attribute a write to.
 *
 * A write spanning two claims is not attributed to either: an agent editing
 * files from someone else's task is precisely the situation the conflict
 * detectors exist to notice, and quietly picking one of them would erase it.
 */
export function attribute(input: AttributionInput): Attributed {
  const { paths, live, claims, intent, now = Date.now() } = input;

  /*
   * An agent that said it was about to do this outranks everything below.
   *
   * Note it does *not* have to be editing its own card's files — that is the
   * point. A write to a file on another agent's card is a crossing, and the
   * only way to report one is to record who actually made it.
   */
  if (intent && now - intent.at < INTENT_TTL_MS) {
    return {
      agent: intent.tool ?? live[0]?.agent ?? 'agent',
      agentId: `mcp:${intent.id}`,
      agentLabel: intent.label ?? intent.tool ?? 'agent',
      basis: 'intent',
    };
  }

  const matched = claims.filter((c) => paths.some((p) => claimCovers(c.paths, p)));
  if (matched.length === 1) {
    const claim = matched[0];
    const by = claim.by !== 'you' ? claim.by : (live[0]?.agent ?? 'you');
    return { agent: by, agentId: `task:${claim.id}`, agentLabel: claim.title, basis: 'claim' };
  }

  if (live.length === 1) {
    const only = live[0];
    return {
      agent: only.agent,
      agentId: `${only.agent}:${only.terminalId}`,
      agentLabel: only.agent,
      basis: 'sole-agent',
    };
  }

  if (live.length === 0) return { agent: 'you', basis: 'unknown' };
  return { agent: 'mixed', basis: 'unknown' };
}
