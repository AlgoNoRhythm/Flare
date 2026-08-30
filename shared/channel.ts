import { normalizePosix } from './paths';

/**
 * The room the agents talk in.
 *
 * Several agents on one repo do not collide because they are careless; they
 * collide because nothing tells them what the others are already inside. Each
 * one sees a clean working tree, picks the file its task points at, and finds
 * out about the other only when a human reads a diff where two changes have
 * been folded into one file with no seam.
 *
 * The fix is not a lock. Flare watches a filesystem; it does not sit in front
 * of one, so a "lock" here could only ever be a request an agent is free to
 * ignore — a lock that silently fails open is worse than no lock, because
 * everyone downstream believes it held. What Flare can do is give the agents
 * somewhere to *talk*, and then draw what was said on the map:
 *
 *     Claude 2  taking   shared/graph.ts, shared/resolver.ts
 *               "moving the workspace lookup out of the resolver"
 *     Codex 1   asking   @Claude 2 — is shared/graph.ts free? I need the
 *               edge builder for the cycle fix
 *     Claude 2  done     shared/resolver.ts — all yours
 *
 * Three habits are all the protocol needs, and they are what the tool
 * descriptions ask for: **say what you are taking before you start**, **read
 * the room when you finish something**, and **ask the agent by name** when you
 * want a file it has spoken for. Nothing is enforced and nothing is refused;
 * two agents may both say they are taking the same file, and when that happens
 * it is drawn as contention rather than resolved behind their backs — because
 * the two of them settling it is the only thing that actually settles it.
 *
 * The human is in the room too, on equal terms: the panel posts as `you`, and
 * an agent reading the feed sees that alongside everything else.
 *
 * Pure, so the whole protocol is testable without a session, a server or an
 * agent.
 */

/**
 * What a message is doing, which is the part the graph can act on.
 *
 * Deliberately four and not more: an agent choosing between fifteen speech
 * acts is an agent getting the tag wrong. `taking` and `done` bracket a piece
 * of work and are what paints the map; `asking` is a question aimed at someone
 * and is what the roster shows as waiting; `saying` is everything else and is
 * the default, so an agent that ignores the tag still ends up in the room.
 */
export type PostKind = 'taking' | 'done' | 'asking' | 'saying';

export const POST_LABEL: Record<PostKind, string> = {
  taking: 'taking',
  done: 'done with',
  asking: 'asking',
  saying: 'says',
};

export interface ChannelMessage {
  id: string;
  at: number;
  /** roster id (`mcp:<session>`) or 'you' */
  from: string;
  /** display name at post time, so the history still reads after a rename */
  fromName: string;
  /** the tool behind that name — 'claude', 'codex', 'you' — for colours and rings */
  fromTool: string;
  /** who it is aimed at, when it is aimed at anyone: a roster id, or 'you' */
  to: string | null;
  toName: string | null;
  kind: PostKind;
  text: string;
  /** the files it is about — what the graph paints and what `workingOn` reads */
  paths: string[];
}

/**
 * How long a `taking` speaks for a file without being repeated.
 *
 * It is a statement of intent, not a booking, so it has to lapse: an agent
 * that said "taking src/parser" two hours ago and has since been killed should
 * not still be shown as sitting in it. An agent that is still working says so
 * again — the tool descriptions ask it to post as it goes, and posting is
 * cheap.
 */
export const NOTICE_TTL_MS = 45 * 60_000;

/** Past this the oldest fall off — a feed, not an archive. */
export const CHANNEL_LIMIT = 400;

/** Project-relative, forward slashes, no trailing slash. */
export function normalizePath(path: string): string {
  return normalizePosix(path.trim()).replace(/\/+$/, '');
}

/** Does a mentioned path cover this file? A folder covers what is under it. */
export function covers(mentioned: string, path: string): boolean {
  return mentioned !== '' && (mentioned === path || path.startsWith(`${mentioned}/`));
}

/** Do two mentioned paths refer to overlapping ground? */
export function overlaps(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a);
}

export interface PostInput {
  id: string;
  from: string;
  fromName: string;
  fromTool: string;
  to?: string | null;
  toName?: string | null;
  kind?: PostKind;
  text: string;
  paths?: readonly string[];
  now: number;
}

export function post(feed: readonly ChannelMessage[], input: PostInput): ChannelMessage[] {
  const message: ChannelMessage = {
    id: input.id,
    at: input.now,
    from: input.from,
    fromName: input.fromName,
    fromTool: input.fromTool,
    to: input.to ?? null,
    toName: input.toName ?? null,
    kind: input.kind ?? 'saying',
    text: input.text.trim(),
    paths: [...new Set((input.paths ?? []).map(normalizePath))].filter((p) => p !== ''),
  };
  const next = [...feed, message];
  return next.length > CHANNEL_LIMIT ? next.slice(next.length - CHANNEL_LIMIT) : next;
}

/** One agent's standing statement that it is working on a file. */
export interface Notice {
  agentId: string;
  agentName: string;
  /** the tool behind the name, for the colours and for attribution */
  tool: string;
  /** what it said it was doing */
  text: string;
  at: number;
  messageId: string;
}

/**
 * Who has said they are working on what, per file.
 *
 * A list per path rather than a winner, because nothing here resolves: two
 * agents may both have said they are taking `shared/graph.ts`, and the honest
 * answer to "who has this" is *both of them, and they need to sort it out*.
 * Picking one would hide exactly the situation the room exists to prevent.
 *
 * A `taking` stands until the same agent says `done` with that path, or until
 * it goes stale. Someone else's `done` does not clear it: an agent can only
 * speak for its own work.
 */
export function workingOn(
  feed: readonly ChannelMessage[],
  now: number,
  ttlMs = NOTICE_TTL_MS,
): Map<string, Notice[]> {
  /** agentId -> path -> the standing notice */
  const byAgent = new Map<string, Map<string, Notice>>();
  for (const message of feed) {
    if (now - message.at > ttlMs) continue;
    if (message.kind !== 'taking' && message.kind !== 'done') continue;
    if (message.paths.length === 0) continue;
    const mine = byAgent.get(message.from) ?? new Map<string, Notice>();
    byAgent.set(message.from, mine);
    for (const path of message.paths) {
      if (message.kind === 'done') {
        // "done with src/" clears everything the agent took under it
        for (const held of [...mine.keys()]) if (overlaps(held, path)) mine.delete(held);
        continue;
      }
      mine.set(path, {
        agentId: message.from,
        agentName: message.fromName,
        tool: message.fromTool,
        text: message.text,
        at: message.at,
        messageId: message.id,
      });
    }
  }

  const out = new Map<string, Notice[]>();
  for (const mine of byAgent.values()) {
    for (const [path, notice] of mine) {
      const list = out.get(path);
      if (list) list.push(notice);
      else out.set(path, [notice]);
    }
  }
  for (const list of out.values()) list.sort((a, b) => b.at - a.at);
  return out;
}

/**
 * The notices covering one file, including through a folder someone took.
 *
 * `workingOn` keys by exactly what was said — `shared` if that is what the
 * agent typed — so a lookup for `shared/graph.ts` has to walk the prefixes to
 * find it. Cheap: the map holds what agents have mentioned this hour, not the
 * repo.
 */
export function noticesFor(
  working: ReadonlyMap<string, Notice[]>,
  path: string,
): Notice[] {
  const out: Notice[] = [];
  for (const [mentioned, notices] of working) {
    if (covers(mentioned, path)) out.push(...notices);
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * The notices a folder card answers for: its own, else the first from anything
 * inside it.
 *
 * A collapsed `src/` standing in for four hundred files has to say that one of
 * them is being worked on — the alternative is a mark that disappears the
 * moment you fold the directory it was on, which reads as the agent having
 * moved off it. Takes the per-file map the views are handed, so it is a prefix
 * scan over what agents have mentioned this hour rather than over the repo.
 */
export function noticesUnder(
  byFile: ReadonlyMap<string, Notice[]>,
  dir: string,
): Notice[] {
  const exact = byFile.get(dir);
  if (exact) return exact;
  const prefix = `${dir}/`;
  for (const [path, notices] of byFile) if (path.startsWith(prefix)) return notices;
  return [];
}

/** Expand what was said onto the files that actually exist, for the graph. */
export function noticesByFile(
  feed: readonly ChannelMessage[],
  paths: Iterable<string>,
  now: number,
): Map<string, Notice[]> {
  const working = workingOn(feed, now);
  const out = new Map<string, Notice[]>();
  if (working.size === 0) return out;
  for (const path of paths) {
    const notices = noticesFor(working, path);
    if (notices.length > 0) out.set(path, notices);
  }
  return out;
}

/**
 * The files more than one agent has said it is taking.
 *
 * The single most useful thing this module computes: two agents heading for
 * the same file, *before* either has written it. Everything else in Flare that
 * reports a crossing can only do so after the fact.
 */
export function contested(working: ReadonlyMap<string, Notice[]>): Map<string, Notice[]> {
  /*
   * Across overlapping mentions, not within one key.
   *
   * The common shape of this is not two agents typing the same string: it is
   * one taking `shared` and the other taking `shared/graph.ts`. Comparing only
   * within a key would call that clear, which is the exact collision the room
   * exists to prevent.
   */
  const hits = new Map<string, Notice[]>();
  for (const path of working.keys()) {
    const agents = new Map<string, Notice>();
    for (const [other, notices] of working) {
      if (!overlaps(path, other)) continue;
      for (const notice of notices) agents.set(notice.agentId, notice);
    }
    if (agents.size > 1) hits.set(path, [...agents.values()].sort((a, b) => b.at - a.at));
  }

  // `shared` and `shared/graph.ts` contested by the same pair is one problem;
  // report it against the narrower path, which is the file actually at stake
  const out = new Map<string, Notice[]>();
  for (const [path, notices] of hits) {
    const narrower = [...hits.keys()].some((other) => other !== path && covers(path, other));
    if (!narrower) out.set(path, notices);
  }
  return out;
}

/** Questions aimed at an agent that nobody has answered since. */
export function openAsks(feed: readonly ChannelMessage[], now: number, ttlMs = NOTICE_TTL_MS): ChannelMessage[] {
  const asks = feed.filter((m) => m.kind === 'asking' && m.to !== null && now - m.at <= ttlMs);
  return asks.filter((ask) => !feed.some((m) => m.from === ask.to && m.at > ask.at));
}

/** What an agent has not read yet. */
export function unreadFor(
  feed: readonly ChannelMessage[],
  agentId: string,
  lastReadAt: number,
): ChannelMessage[] {
  // its own posts are not news to it
  return feed.filter((m) => m.at > lastReadAt && m.from !== agentId);
}

/**
 * Whether the room is actually being used.
 *
 * The protocol is only worth anything if the agents follow it, and "they said
 * a lot of things" is not evidence that they did. This is: of the files
 * written this session, how many had been announced in the room by the agent
 * that wrote them, *before* the write landed. A repo where that number is 3 of
 * 40 has a channel nobody reads, and the honest thing is to say so on the
 * panel rather than to show a busy-looking feed.
 *
 * The human is excluded on both sides. You are not expected to announce your
 * own edits, and counting them would make the number depend on how much you
 * typed rather than on how the agents are behaving.
 */
export function announcedShare(
  bursts: readonly { agent: string; agentId?: string; changed: readonly string[]; endedAt: number }[],
  feed: readonly ChannelMessage[],
): { announced: number; total: number; quiet: string[] } {
  const notices = feed.filter((m) => m.kind === 'taking' && m.paths.length > 0);
  const seen = new Set<string>();
  const quiet = new Set<string>();
  let announced = 0;
  for (const burst of bursts) {
    if (burst.agent === 'you') continue;
    for (const path of burst.changed) {
      // one verdict per file: a file written twice is one file, and the
      // question is whether anyone ever announced it
      if (seen.has(path)) continue;
      seen.add(path);
      const said = notices.some(
        (m) =>
          /*
           * Whoever wrote it, when we know — and anyone, when we do not.
           *
           * Dropping the writes Flare could not attribute would bias this
           * number upwards in exactly the wrong direction: a file nobody
           * announced is a file with no notice to attribute it by, so the
           * unannounced writes are precisely the ones most likely to come
           * back as `mixed`. Excluding them would score a room nobody uses as
           * a room used perfectly.
           */
          (burst.agentId ? m.from === burst.agentId : m.from !== 'you') &&
          m.at <= burst.endedAt &&
          burst.endedAt - m.at <= NOTICE_TTL_MS &&
          m.paths.some((p) => covers(p, path)),
      );
      if (said) announced++;
      else quiet.add(path);
    }
  }
  return { announced, total: seen.size, quiet: [...quiet] };
}

/**
 * What happened after a message was posted.
 *
 * The room is a room: everything in it is a *claim*, and a claim is worth
 * exactly as much as whether it turned out to be true. Flare is the only
 * participant that can check — it watched the writes — so every line an agent
 * says about files can be opened to reveal what actually followed it:
 *
 *   Claude 2 — taking src/components/ReviewPanel.tsx
 *     wrote ReviewPanel.tsx, 4 minutes later
 *     never touched BurstStrip.tsx
 *     Codex 1 wrote ReviewPanel.tsx as well
 *
 * The last line is the one that cannot be got any other way: an agent saying
 * "taking this" and someone else writing it anyway is a crossing, and the
 * message it crossed is where a person is actually looking when they want to
 * know about it.
 */
export interface FollowUp {
  /** paths the speaker wrote after saying this, with when */
  written: { path: string; at: number }[];
  /** paths it named and has not written */
  pending: string[];
  /** paths somebody else wrote after this was said */
  crossed: { path: string; by: string }[];
}

export function followUp(
  message: ChannelMessage,
  bursts: readonly {
    agent: string;
    agentId?: string;
    agentName?: string;
    changed: readonly string[];
    endedAt: number;
  }[],
): FollowUp {
  const written = new Map<string, number>();
  const crossed = new Map<string, string>();
  for (const burst of bursts) {
    if (burst.endedAt < message.at) continue;
    const mine = burst.agentId ? burst.agentId === message.from : burst.agent === message.from;
    for (const path of burst.changed) {
      if (!message.paths.some((p) => covers(p, path))) continue;
      if (mine) {
        if (!written.has(path)) written.set(path, burst.endedAt);
      } else if (!crossed.has(path)) {
        crossed.set(path, burst.agentName ?? burst.agent);
      }
    }
  }
  return {
    written: [...written].map(([path, at]) => ({ path, at })),
    // a folder that was named and never written cannot list its files, so it
    // reports itself — which is what the agent said, and therefore checkable
    pending: message.paths.filter((p) => ![...written.keys()].some((w) => covers(p, w))),
    crossed: [...crossed].map(([path, by]) => ({ path, by })),
  };
}

/** What the room looks like right now, for the panel's header. */
export interface ChannelStats {
  messages: number;
  /** how many of each kind was said */
  byKind: Record<PostKind, number>;
  /** paths at least one agent has said it is taking */
  spokenFor: number;
  /** paths more than one agent has said it is taking */
  contested: number;
  /** questions aimed at an agent that has not spoken since */
  waiting: number;
  /** when anything was last said, or 0 for an empty room */
  lastAt: number;
}

export function channelStats(feed: readonly ChannelMessage[], now: number): ChannelStats {
  const byKind: Record<PostKind, number> = { taking: 0, done: 0, asking: 0, saying: 0 };
  for (const message of feed) byKind[message.kind]++;
  const working = workingOn(feed, now);
  return {
    messages: feed.length,
    byKind,
    spokenFor: working.size,
    contested: contested(working).size,
    waiting: openAsks(feed, now).length,
    lastAt: feed.length > 0 ? feed[feed.length - 1].at : 0,
  };
}

/** One message as a line of transcript — the same words in the panel and over MCP. */
export function formatMessage(message: ChannelMessage): string {
  const head = [
    message.fromName,
    message.toName ? `→ ${message.toName}` : '',
    POST_LABEL[message.kind],
    message.paths.length > 0 ? message.paths.join(', ') : '',
  ]
    .filter(Boolean)
    .join(' ');
  return message.text ? `${head}\n  ${message.text}` : head;
}

/** The feed as an agent reads it, oldest first. */
export function formatFeed(feed: readonly ChannelMessage[]): string {
  return feed.map(formatMessage).join('\n');
}
