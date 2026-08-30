import { noticesFor, type Notice } from './channel';

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
 * So we do not pick by presence. We pick by what each agent *said*, and only
 * fall back to inference when nobody said anything. Five rungs, and it reports
 * which one answered rather than guessing past the end of what it knows:
 *
 * 1. **one recorded intent** — exactly one agent said "I am about to change
 *    things", and its MCP session id is the one identity here that nothing
 *    else can impersonate
 * 2. **several intents, separated by the channel** — two agents both
 *    announced, and exactly one of them told the room it was taking these
 *    particular files. What it said is what tells them apart; without it this
 *    write is honestly ambiguous.
 * 3. **the channel alone** — nobody announced an edit, but exactly one agent
 *    has said in the room that it is working on every file in this write
 * 4. **the board** — the written files belong to exactly one in-progress task
 * 5. **the only agent running**, then **`mixed`** — several agents live and
 *    nothing to separate them. Honest, and the detectors in
 *    shared/conflicts.ts skip it rather than inventing a crossing between an
 *    agent and itself.
 *
 * The order is the whole point, and it is *first-person statements first*. An
 * intent and a channel notice are both an identified session saying what it is
 * doing; the board is an inference from where a file happens to be listed, so
 * an agent editing a file on someone else's card would be recorded as that
 * other agent — silently erasing the crossing rather than reporting it.
 *
 * That is also why the intent still outranks the notice: saying "I am taking
 * this file" is not the same as writing it, and an agent writing a file
 * another agent had spoken for is precisely the crossing the review exists to
 * surface. Attributing that write to whoever spoke first would delete the
 * evidence of it.
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
  /** its roster name — 'Claude 2' — when it has one */
  name?: string | null;
  at: number;
}

export interface AttributionInput {
  /** the files in this write */
  paths: readonly string[];
  /** agents running right now, most recently seen first */
  live: readonly LiveAgentInfo[];
  /** tasks currently in progress */
  claims: readonly TaskClaim[];
  /**
   * Every `record_intent` still in force, one per MCP session.
   *
   * A list rather than "the latest": with two agents running, the most recent
   * intent belongs to whichever of them spoke last and speaks for the other's
   * writes for the next ten minutes — which is exactly the confident wrong
   * answer this module exists to avoid.
   */
  intents?: readonly RecordedIntent[];
  /**
   * Who has told the room they are working on what — see shared/channel.ts.
   *
   * Keyed by the path each agent actually named, folders included, which is
   * why the lookup here goes through `noticesFor` rather than `get`.
   */
  working?: ReadonlyMap<string, Notice[]>;
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
  /** who it is — 'Claude 2' — when the roster knows this session */
  agentName?: string;
  /** what it was doing: the task it claimed, or why it claimed the files */
  agentLabel?: string;
  /** which rung answered — for the tooltip that explains why it says what it says */
  basis: 'intent' | 'notice' | 'claim' | 'sole-agent' | 'unknown';
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
 * The one agent that has spoken for every file in this write.
 *
 * Null when nobody has, when two agents have — the room allows that, and it is
 * the contention the panel draws rather than a tie to break — or when only
 * some of the files are covered, which is not evidence about the rest of them.
 */
function soleSpeaker(
  working: ReadonlyMap<string, Notice[]> | undefined,
  paths: readonly string[],
): Notice | null {
  if (!working || working.size === 0) return null;
  let found: Notice | null = null;
  for (const path of paths) {
    const notices = noticesFor(working, path);
    if (notices.length === 0) return null;
    if (new Set(notices.map((n) => n.agentId)).size > 1) return null;
    if (found && found.agentId !== notices[0].agentId) return null;
    found = found ?? notices[0];
  }
  return found;
}

/** The rung-1 and rung-2 answer, built from whichever intent won. */
function fromIntent(intent: RecordedIntent, live: readonly LiveAgentInfo[]): Attributed {
  return {
    agent: intent.tool ?? live[0]?.agent ?? 'agent',
    agentId: `mcp:${intent.id}`,
    agentName: intent.name ?? undefined,
    agentLabel: intent.label ?? intent.name ?? intent.tool ?? 'agent',
    basis: 'intent',
  };
}

/**
 * Who to attribute a write to.
 *
 * A write spanning two claims is not attributed to either: an agent editing
 * files from someone else's task is precisely the situation the conflict
 * detectors exist to notice, and quietly picking one of them would erase it.
 */
export function attribute(input: AttributionInput): Attributed {
  const { paths, live, claims, intents, working, now = Date.now() } = input;

  const speaking = (intents ?? []).filter((i) => now - i.at < INTENT_TTL_MS);
  const spokenFor = soleSpeaker(working, paths);

  // 1. exactly one agent announced an edit
  if (speaking.length === 1) return fromIntent(speaking[0], live);

  // 2. several announced; the one that told the room it had these files meant this write
  if (speaking.length > 1 && spokenFor) {
    const owner = speaking.find((i) => `mcp:${i.id}` === spokenFor.agentId);
    if (owner) return fromIntent(owner, live);
  }

  // 3. nobody announced, but one agent said in the room it was taking these files
  if (spokenFor && speaking.length === 0) {
    return {
      agent: spokenFor.tool ?? live[0]?.agent ?? 'agent',
      agentId: spokenFor.agentId,
      agentName: spokenFor.agentName,
      agentLabel: spokenFor.text || spokenFor.agentName,
      basis: 'notice',
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

/** Why the app says what it says, in one line for a tooltip. */
export const BASIS_HINT: Record<Attributed['basis'], string> = {
  intent: 'This agent announced the edit over MCP before making it.',
  notice: 'This agent told the channel it was taking these files, and nobody else announced an edit.',
  claim: 'These files are listed on exactly one in-progress task, and that card was claimed by this agent.',
  'sole-agent': 'Only one agent was running when this landed, so it is the only candidate.',
  unknown: 'Several agents were live and nothing separated them — Flare will not guess between them.',
};
