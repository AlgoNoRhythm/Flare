import { randomUUID } from 'node:crypto';
import {
  post,
  unreadFor,
  workingOn,
  type ChannelMessage,
  type Notice,
  type PostKind,
} from '../../shared/channel';
import {
  liveAgents,
  presenceOf,
  register,
  sortRoster,
  touch,
  type AgentRecord,
} from '../../shared/roster';

/**
 * The live side of the collaboration: who is connected, and what they said.
 *
 * Everything the two pure modules underneath cannot do — mint ids, read the
 * clock, decide when to tell the UI — happens here, and nothing else does. Who
 * an agent is and what its name is live in shared/roster.ts; what a message
 * means and which files it speaks for live in shared/channel.ts, where they
 * can be tested without a server.
 *
 * Per-session and deliberately not persisted. An agent's identity *is* its MCP
 * session: when Flare restarts every socket has closed, so a roster restored
 * from disk would list agents that cannot possibly still be there, and a
 * channel restored with it would be a conversation none of the participants
 * remember having.
 */

function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export interface AgentsSnapshot {
  agents: AgentRecord[];
  /** the room, oldest first */
  channel: ChannelMessage[];
  /** the moment this was taken, so a renderer can age it without a clock skew */
  at: number;
}

export class AgentRegistry {
  private agents: AgentRecord[] = [];
  private feed: ChannelMessage[] = [];
  private ticker: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;

  constructor(
    private onChange: (snapshot: AgentsSnapshot) => void,
    /**
     * Which tools the process monitor can see. Used only as a fallback for a
     * client that did not name itself on `initialize`, and only when it is
     * unanimous — with two tools running it says nothing rather than guessing.
     */
    private runningTools: () => string[] = () => [],
  ) {}

  /**
   * Presence decays with the clock, not with events.
   *
   * Without a tick, an agent that went quiet stays "working" on screen until
   * some unrelated thing happens to recompute the snapshot — and a notice that
   * has gone stale keeps its mark on the graph for the same reason.
   */
  start(everyMs = 30_000): void {
    this.stop();
    this.ticker = setInterval(() => this.tick(), everyMs);
    if (typeof this.ticker.unref === 'function') this.ticker.unref();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    if (this.pending) clearTimeout(this.pending);
    this.ticker = null;
    this.pending = null;
  }

  // ------------------------------------------------------------------
  // who is here
  // ------------------------------------------------------------------

  /** An MCP session said hello, or said hello again. */
  noteAgent(callerId: string | null, client: string | null): AgentRecord | null {
    if (!callerId) return null;
    const id = `mcp:${callerId}`;
    const before = this.agents.find((a) => a.id === id);
    const result = register(this.agents, {
      id,
      client,
      running: this.runningTools(),
      now: Date.now(),
    });
    this.agents = result.roster;
    this.emit(!before || before.name !== result.agent.name);
    return result.agent;
  }

  /**
   * An MCP session did something. Registers it if this is the first we hear of
   * it — a client that skips `initialize` still gets an identity, because the
   * alternative is a nameless agent editing files.
   */
  noteCall(
    callerId: string | null,
    patch: Partial<Pick<AgentRecord, 'doing' | 'task' | 'lastReadAt'>> = {},
  ): AgentRecord | null {
    if (!callerId) return null;
    const id = this.ensure(callerId).id;
    this.agents = touch(this.agents, id, Date.now(), patch);
    this.emit();
    return this.agents.find((a) => a.id === id) ?? null;
  }

  /**
   * The record for a session, registering it if this is the first sight of it.
   *
   * Unlike `noteCall` this does not count as activity: the tools that post and
   * read are already counted by the dispatcher, and counting them twice would
   * make the talkative agents look busier than they are.
   */
  private ensure(callerId: string): AgentRecord {
    const id = `mcp:${callerId}`;
    return this.agents.find((a) => a.id === id) ?? this.noteAgent(callerId, null)!;
  }

  /** Files written, counted from the bursts so the panel can say "wrote 12". */
  noteWrites(agentId: string | undefined, files: number): void {
    if (!agentId || files <= 0) return;
    if (!this.agents.some((a) => a.id === agentId)) return;
    this.agents = this.agents.map((a) => (a.id === agentId ? { ...a, files: a.files + files } : a));
    this.emit();
  }

  get(callerId: string | null): AgentRecord | null {
    if (!callerId) return null;
    return this.agents.find((a) => a.id === `mcp:${callerId}`) ?? null;
  }

  /** Find an agent by whatever an agent typed into a `to` field. */
  resolve(who: string | null | undefined): AgentRecord | null {
    if (!who) return null;
    const wanted = who.trim().toLowerCase().replace(/^@/, '');
    if (wanted === '') return null;
    return (
      this.agents.find((a) => a.id.toLowerCase() === wanted) ??
      this.agents.find((a) => a.name.toLowerCase() === wanted) ??
      // 'claude 2' typed as 'claude2', and a bare tool name when there is one
      this.agents.find((a) => a.name.toLowerCase().replace(/\s+/g, '') === wanted.replace(/\s+/g, '')) ??
      null
    );
  }

  list(): AgentRecord[] {
    return sortRoster(this.agents, Date.now());
  }

  // ------------------------------------------------------------------
  // the room
  // ------------------------------------------------------------------

  messages(): ChannelMessage[] {
    return [...this.feed];
  }

  /** Who has said they are working on what, right now. */
  working(): Map<string, Notice[]> {
    return workingOn(this.feed, Date.now());
  }

  /** An agent posts. */
  say(
    callerId: string,
    input: { text: string; kind?: PostKind; paths?: readonly string[]; to?: string | null },
  ): { message: ChannelMessage; unread: ChannelMessage[]; agent: AgentRecord } {
    const agent = this.ensure(callerId);
    const target = this.resolve(input.to);
    const now = Date.now();
    /*
     * Posting is also reading.
     *
     * An agent that says "taking shared/graph.ts" and is told in the same
     * breath what it missed has no reason to call `chat_read` first, and the
     * one call it was always going to make is the one that catches it up.
     */
    const unread = unreadFor(this.feed, agent.id, agent.lastReadAt);
    this.feed = post(this.feed, {
      id: newId('m'),
      from: agent.id,
      fromName: agent.name,
      fromTool: agent.tool,
      to: target?.id ?? (input.to ? String(input.to) : null),
      toName: target?.name ?? (input.to ? String(input.to) : null),
      kind: input.kind,
      text: input.text,
      paths: input.paths,
      now,
    });
    /*
     * Only a `taking` says what an agent is doing.
     *
     * An aside — "heads up, don't rename those exports" — is a useful thing to
     * say and a terrible answer to "what is Claude 2 working on", and it was
     * overwriting the answer on the roster the moment anyone made small talk.
     *
     * A `done` only clears it if the agent has *nothing left*: handing back one
     * of the three files you took is not finishing, and reporting it as "has
     * not said what it is doing" is worse than saying nothing.
     */
    const stillWorking = [...workingOn(this.feed, now).values()].some((notices) =>
      notices.some((n) => n.agentId === agent.id),
    );
    const doing =
      input.kind === 'taking'
        ? (input.text.trim() || null)
        : input.kind === 'done' && !stillWorking
          ? null
          : undefined;
    this.agents = this.agents.map((a) =>
      a.id === agent.id ? { ...a, ...(doing === undefined ? {} : { doing }), lastReadAt: now } : a,
    );
    this.emit(true);
    return { message: this.feed[this.feed.length - 1], unread, agent };
  }

  /** The human posts, from the panel. */
  sayAsHuman(input: { text: string; kind?: PostKind; paths?: readonly string[]; to?: string | null }): void {
    const target = this.resolve(input.to);
    this.feed = post(this.feed, {
      id: newId('m'),
      from: 'you',
      fromName: 'You',
      fromTool: 'you',
      to: target?.id ?? null,
      toName: target?.name ?? null,
      kind: input.kind,
      text: input.text,
      paths: input.paths,
      now: Date.now(),
    });
    this.emit(true);
  }

  /** What this agent has not seen, and a mark that it now has. */
  read(callerId: string, all = false): { messages: ChannelMessage[]; unread: number; agent: AgentRecord } {
    const agent = this.ensure(callerId);
    const unread = unreadFor(this.feed, agent.id, agent.lastReadAt);
    this.agents = this.agents.map((a) => (a.id === agent.id ? { ...a, lastReadAt: Date.now() } : a));
    this.emit();
    return { messages: all ? [...this.feed] : unread, unread: unread.length, agent };
  }

  // ------------------------------------------------------------------

  private tick(): void {
    const now = Date.now();
    if (this.agents.some((a) => presenceOf(a, now) !== 'working')) this.emit();
    else if (liveAgents(this.agents, now).length !== this.agents.length) this.emit();
  }

  snapshot(): AgentsSnapshot {
    return { agents: this.list(), channel: [...this.feed], at: Date.now() };
  }

  /**
   * Tell the UI, without telling it forty times a second.
   *
   * A working agent calls tools constantly and each call moves `lastSeen`,
   * which is a real change and a pointless render. So the two kinds are
   * separated: something structural — an agent arriving, anything said in the
   * room — goes out at once, because that is what someone is watching for;
   * everything else rides the next coalescing tick.
   */
  private emit(immediate = false): void {
    if (immediate) {
      if (this.pending) clearTimeout(this.pending);
      this.pending = null;
      this.onChange(this.snapshot());
      return;
    }
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.onChange(this.snapshot());
    }, 1500);
    if (typeof this.pending.unref === 'function') this.pending.unref();
  }
}
