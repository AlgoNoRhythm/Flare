/**
 * Who is working on this project, and what to call them.
 *
 * Everything multi-agent in Flare rests on one thing being true: that two
 * `claude` sessions are two *different* agents. The process list cannot say
 * that — both are equally present in every sample — and the board cannot
 * either, because it attributes by path. What can is the MCP session: minted on
 * `initialize`, echoed back on every later request, and impossible for another
 * client to answer to. So the roster is keyed by that, and every agent-shaped
 * fact in the app hangs off it.
 *
 * The names are the other half of the job. `mcp:9f3c1a…` is a correct identity
 * and a useless label; a review that says *"Claude 2 rewrote the parser while
 * Claude 1 was in it"* is a sentence a person can act on. So each session is
 * given the tool it is running under and the next free ordinal for that tool —
 * **Claude 1**, **Claude 2**, **Codex 1** — and keeps it for as long as the
 * project is open. Ordinals are never reused inside a session: a "Claude 1"
 * that exits and a new session arriving are two different agents, and giving
 * the newcomer the old name would silently merge them in every burst, ring and
 * conflict that mentions it.
 *
 * Pure: no server, no clock of its own, no state outside what it is handed.
 */

/** The tool a session is running under, as this app has always spelled them. */
export const KNOWN_TOOLS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  aider: 'Aider',
  gemini: 'Gemini',
  goose: 'Goose',
  amp: 'Amp',
  cursor: 'Cursor',
  cline: 'Cline',
  continue: 'Continue',
  windsurf: 'Windsurf',
  zed: 'Zed',
};

export interface AgentRecord {
  /** `mcp:<session id>` — the same string the bursts and claims carry */
  id: string;
  /** the tool: 'claude', 'codex', … lowercase, as the agent monitor spells it */
  tool: string;
  /** 'Claude 2' — what every surface in the app calls this agent */
  name: string;
  /** its number within its tool, from 1 */
  ordinal: number;
  /** what the client called itself on `initialize`, when it said */
  client: string | null;
  firstSeen: number;
  /** the last time it did anything over MCP — what presence is read from */
  lastSeen: number;
  /** what it last said it was doing: its own words, from the channel or an intent */
  doing: string | null;
  /** the board card it claimed, when it claimed one */
  task: string | null;
  /** how far it has read the channel — what makes "since you last looked" real */
  lastReadAt: number;
  /** MCP calls made this session — the cheapest honest measure of activity */
  calls: number;
  /** files it has written this session, counted from the bursts */
  files: number;
}

/** No call in this long and it is probably thinking, or gone. */
export const AGENT_IDLE_MS = 3 * 60_000;
/** No call in this long and we stop claiming it is here. */
export const AGENT_GONE_MS = 20 * 60_000;

export type Presence = 'working' | 'idle' | 'gone';

export const PRESENCE_LABEL: Record<Presence, string> = {
  working: 'working',
  idle: 'idle',
  gone: 'gone',
};

export const PRESENCE_HINT: Record<Presence, string> = {
  working: 'Called Flare over MCP in the last few minutes.',
  idle: 'Still connected, but has not asked Flare anything recently.',
  gone: 'Silent long enough that we no longer count it as here. Its claims have been released.',
};

export function presenceOf(agent: Pick<AgentRecord, 'lastSeen'>, now: number): Presence {
  const quiet = now - agent.lastSeen;
  if (quiet < AGENT_IDLE_MS) return 'working';
  return quiet < AGENT_GONE_MS ? 'idle' : 'gone';
}

/**
 * Which tool a client is, from the name it gave on `initialize`.
 *
 * MCP clients identify themselves — `claude-code`, `codex-cli`, `opencode` —
 * and that is the only first-person answer available: the process tree knows
 * what is *running* in a terminal, not which of them opened this socket. A
 * client that gives nothing falls back to the process tree, and then to a
 * generic name rather than to a guess between two live tools.
 */
export function toolFromClient(client: string | null, running: readonly string[] = []): string {
  const raw = (client ?? '').toLowerCase();
  for (const tool of Object.keys(KNOWN_TOOLS)) {
    // 'claude-code', 'claude_desktop', 'anthropic-claude' all read as claude
    if (new RegExp(`(^|[^a-z])${tool}([^a-z]|$)`).test(raw)) return tool;
  }
  // an unrecognised client still gets to be itself, provided it said something
  const cleaned = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned !== '' && cleaned !== 'mcp' && cleaned !== 'client') return cleaned;
  // nothing from the client: the process tree can answer only if it is unanimous
  const distinct = [...new Set(running)];
  return distinct.length === 1 ? distinct[0] : 'agent';
}

/** 'claude' + 2 -> 'Claude 2'. */
export function displayName(tool: string, ordinal: number): string {
  const label =
    KNOWN_TOOLS[tool] ??
    tool
      .split(/[-_ ]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  return `${label || 'Agent'} ${ordinal}`;
}

/**
 * The next number for a tool.
 *
 * Counted over *every* record ever registered this session, gone ones
 * included. Reusing 1 after a Claude 1 exits would make two different agents
 * share a name in the same review, which is the one thing the names exist to
 * prevent.
 */
export function nextOrdinal(roster: readonly AgentRecord[], tool: string): number {
  let max = 0;
  for (const agent of roster) if (agent.tool === tool && agent.ordinal > max) max = agent.ordinal;
  return max + 1;
}

export interface RegisterInput {
  id: string;
  /** what the client called itself, if it said */
  client?: string | null;
  /** tools the process monitor can see running, for a client that did not say */
  running?: readonly string[];
  now: number;
}

/**
 * Register a session, or hand back the one already registered under that id.
 *
 * Idempotent because `initialize` is not the only place this is reachable from:
 * a client that reconnects, or one that never initialised and simply started
 * calling tools, should land in the roster once and keep the name it was given.
 */
export function register(
  roster: readonly AgentRecord[],
  input: RegisterInput,
): { roster: AgentRecord[]; agent: AgentRecord } {
  const existing = roster.find((a) => a.id === input.id);
  if (existing) {
    /*
     * A late identification is worth taking. An agent that called a tool before
     * it initialised was registered from the process tree, which may have said
     * 'agent'; the moment the client names itself, the roster should say so —
     * but the *ordinal* stays, so nothing that already printed the old name
     * disagrees with what it printed.
     */
    const client = input.client ?? existing.client;
    const tool = existing.tool === 'agent' ? toolFromClient(client, input.running) : existing.tool;
    if (tool === existing.tool && client === existing.client) {
      const agent = { ...existing, lastSeen: input.now };
      return { roster: roster.map((a) => (a.id === agent.id ? agent : a)), agent };
    }
    const ordinal = nextOrdinal(
      roster.filter((a) => a.id !== existing.id),
      tool,
    );
    const agent: AgentRecord = {
      ...existing,
      tool,
      client,
      ordinal,
      name: displayName(tool, ordinal),
      lastSeen: input.now,
    };
    return { roster: roster.map((a) => (a.id === agent.id ? agent : a)), agent };
  }

  const tool = toolFromClient(input.client ?? null, input.running);
  const ordinal = nextOrdinal(roster, tool);
  const agent: AgentRecord = {
    id: input.id,
    tool,
    name: displayName(tool, ordinal),
    ordinal,
    client: input.client ?? null,
    firstSeen: input.now,
    lastSeen: input.now,
    doing: null,
    task: null,
    /*
     * A new agent has read nothing rather than everything.
     *
     * Zero, not `now`: an agent arriving into a conversation that has been
     * running for an hour needs the hour, and it is the one moment where the
     * whole backlog is exactly what it should be handed.
     */
    lastReadAt: 0,
    calls: 0,
    files: 0,
  };
  return { roster: [...roster, agent], agent };
}

/** Note that an agent is still there, and anything new it told us. */
export function touch(
  roster: readonly AgentRecord[],
  id: string,
  now: number,
  patch: Partial<Pick<AgentRecord, 'doing' | 'task' | 'files' | 'lastReadAt'>> = {},
): AgentRecord[] {
  return roster.map((agent) =>
    agent.id === id
      ? { ...agent, ...patch, lastSeen: now, calls: agent.calls + 1 }
      : agent,
  );
}

/** Everyone still counted as here, busiest first. */
export function liveAgents(roster: readonly AgentRecord[], now: number): AgentRecord[] {
  return roster
    .filter((a) => presenceOf(a, now) !== 'gone')
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * The roster in the order a person reads it: here first, then by arrival.
 *
 * Arrival rather than recency for the ones that are here, so the list does not
 * reshuffle itself under the cursor every time an agent calls a tool — "Claude
 * 1" above "Claude 2" is also the order the names imply.
 */
export function sortRoster(roster: readonly AgentRecord[], now: number): AgentRecord[] {
  const rank: Record<Presence, number> = { working: 0, idle: 1, gone: 2 };
  return [...roster].sort(
    (a, b) => rank[presenceOf(a, now)] - rank[presenceOf(b, now)] || a.firstSeen - b.firstSeen,
  );
}

/** Look an agent up by the id a burst, a claim or a conflict carries. */
export function agentById(roster: readonly AgentRecord[], id: string | undefined): AgentRecord | null {
  if (!id) return null;
  return roster.find((a) => a.id === id) ?? null;
}

/**
 * What to call whoever made a change, given whatever identity it carries.
 *
 * Bursts predate the roster and are attributed down a ladder that does not
 * always reach an MCP session, so this has to degrade: a roster name if the id
 * is one we know, otherwise whatever the burst already said, otherwise the
 * tool. Never an opaque id — a review row reading `mcp:9f3c1a…` is worse than
 * one reading `claude`.
 */
export function nameFor(
  roster: readonly AgentRecord[],
  id: string | undefined,
  fallback: string,
): string {
  return agentById(roster, id)?.name ?? fallback;
}
