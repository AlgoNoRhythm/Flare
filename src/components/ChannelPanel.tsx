import { useEffect, useMemo, useRef, useState } from 'react';
import {
  POST_LABEL,
  announcedShare,
  channelStats,
  contested,
  followUp,
  openAsks,
  workingOn,
  type ChannelMessage,
  type PostKind,
} from '../../shared/channel';
import {
  PRESENCE_HINT,
  PRESENCE_LABEL,
  presenceOf,
  type AgentRecord,
} from '../../shared/roster';
import type { ChangeBurst } from '../../shared/activity';
import { agentColor, agentShape } from '../graph/lenses';
import { ago } from '../format';
import { HintNote } from './HintNote';

/**
 * The room the agents coordinate in, and whether it is working.
 *
 * Several agents on one repo do not collide because they are careless; they
 * collide because nothing tells them what the others are already inside. There
 * is no lock to give them — Flare watches a filesystem rather than sitting in
 * front of one, so a lock could only be a request an agent is free to ignore,
 * and one that fails open silently is worse than none. What there can be is
 * somewhere to talk, and a map that draws what was said.
 *
 * This tab is that room, plus the two things a reader needs that no
 * participant in it can see for themselves.
 *
 * **Is anyone about to collide.** Each agent knows what it said; only this
 * panel is looking at all of it at once, so two agents heading for the same
 * file is drawn at the top — the only warning in Flare that arrives *before*
 * the writes rather than after them.
 *
 * **Is the protocol actually being followed.** A busy-looking feed is not
 * evidence of coordination. "11 of 18 files were announced here before they
 * were written" is, and it is the number that tells you whether to trust the
 * marks on the graph at all.
 */

interface Props {
  agents: readonly AgentRecord[];
  channel: readonly ChannelMessage[];
  /** the session's writes, for the "did they announce it" number */
  bursts: readonly ChangeBurst[];
  onSelectFile(path: string): void;
  onSelectFiles(paths: string[]): void;
  onSay(input: { text: string; kind: PostKind; paths: string[]; to: string | null }): void;
  /** this project's MCP endpoint, for the line an agent is registered with */
  mcpUrl?: string | null;
}

const KINDS: PostKind[] = ['saying', 'taking', 'done', 'asking'];

/**
 * Any project path in a sentence.
 *
 * The composer takes paths out of what you typed rather than out of a second
 * field: "shared/graph.ts is mine for ten minutes" is how this gets said, and
 * asking for the same thing twice — once in prose, once in a form — is how a
 * quick note becomes a chore nobody bothers with.
 */
const PATH_RE = /(?:^|[\s"'`(])([\w.@-]+(?:\/[\w.@-]+)+)/g;

export function ChannelPanel({
  agents,
  channel,
  bursts,
  onSelectFile,
  onSelectFiles,
  onSay,
  mcpUrl = null,
}: Props) {
  const now = Date.now();
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<PostKind>('saying');
  const [to, setTo] = useState('');
  const [fromFilter, setFromFilter] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<PostKind | null>(null);
  const [query, setQuery] = useState('');
  /** turns whose metadata is showing — what actually followed what was said */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const feedRef = useRef<HTMLDivElement | null>(null);

  const working = useMemo(() => workingOn(channel, Date.now()), [channel]);
  const clashes = useMemo(() => contested(working), [working]);
  const waiting = useMemo(() => openAsks(channel, Date.now()), [channel]);
  const stats = useMemo(() => channelStats(channel, Date.now()), [channel]);
  const coverage = useMemo(() => announcedShare(bursts, channel), [bursts, channel]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return channel.filter((m) => {
      if (fromFilter && m.from !== fromFilter) return false;
      if (kindFilter && m.kind !== kindFilter) return false;
      if (needle === '') return true;
      return (
        m.text.toLowerCase().includes(needle) ||
        m.fromName.toLowerCase().includes(needle) ||
        m.paths.some((p) => p.toLowerCase().includes(needle))
      );
    });
  }, [channel, fromFilter, kindFilter, query]);

  /* a transcript that does not follow itself is one you have to chase */
  const pinned = useRef(true);
  useEffect(() => {
    const el = feedRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const send = (): void => {
    const text = draft.trim();
    if (text === '') return;
    const paths = [...text.matchAll(PATH_RE)].map((m) => m[1]);
    onSay({ text, kind, paths, to: to === '' ? null : to });
    setDraft('');
    setKind('saying');
  };

  const pct = coverage.total > 0 ? Math.round((coverage.announced / coverage.total) * 100) : null;

  return (
    <div className="channel-panel" data-testid="channel-panel">
      <HintNote id="channel" className="channel-note">
        Where your agents coordinate. Nothing here is a lock — an agent writes straight to disk — so
        this is what stops two of them rewriting the same file: they post <code>chat_post</code>{' '}
        naming the files they are taking before they start, read it with <code>chat_read</code> when
        they finish something, and ask each other by name. You are in the same room.
      </HintNote>

      {/* ---- what the room adds up to ----
          hidden until there is a room: five zeros over an empty feed is a
          scoreboard for a game that has not started */}
      {(stats.messages > 0 || agents.length > 0 || coverage.total > 0) && (
      <div className="channel-head" data-testid="channel-stats">
        <span className="ch-stat" title="Agents connected over MCP and still answering.">
          <span className="ch-num">{agents.filter((a) => presenceOf(a, now) !== 'gone').length}</span>
          <span className="ch-label">here</span>
        </span>
        <span className="ch-stat" title="Everything said in this room this session.">
          <span className="ch-num">{stats.messages}</span>
          <span className="ch-label">said</span>
        </span>
        <span
          className="ch-stat"
          title="Files and folders an agent has said it is working on right now. These carry a mark on the graph."
        >
          <span className="ch-num">{stats.spokenFor}</span>
          <span className="ch-label">taken</span>
        </span>
        <span
          className="ch-stat"
          title="Files more than one agent has said it is taking. Nothing is blocked, so whoever writes second wins."
        >
          <span className={`ch-num${stats.contested > 0 ? ' crit' : ''}`}>{stats.contested}</span>
          <span className="ch-label">contested</span>
        </span>
        <span
          className="ch-stat"
          title="Questions put to an agent by name that it has not answered — it has posted nothing since."
        >
          <span className={`ch-num${stats.waiting > 0 ? ' warn' : ''}`}>{stats.waiting}</span>
          <span className="ch-label">unanswered</span>
        </span>
        <span className="spacer" />
        {/*
          The number that says whether any of the rest of this means anything.
          A room full of chatter and a graph full of marks are both worthless
          if the files actually being written were never mentioned in it.
        */}
        <span
          className="ch-coverage"
          title={
            coverage.total === 0
              ? 'No agent has written anything yet this session.'
              : `${coverage.announced} of the ${coverage.total} files agents wrote this session had been announced here first.${
                  coverage.quiet.length > 0
                    ? `\n\nWritten without a word: ${coverage.quiet.slice(0, 12).join(', ')}${
                        coverage.quiet.length > 12 ? ` +${coverage.quiet.length - 12}` : ''
                      }`
                    : ''
                }`
          }
          data-testid="channel-coverage"
        >
          {coverage.total === 0 ? (
            <span className="muted">nothing written yet</span>
          ) : (
            <>
              <b className={pct !== null && pct < 50 ? 'crit' : pct !== null && pct < 90 ? 'warn' : 'good'}>
                {coverage.announced}/{coverage.total}
              </b>{' '}
              files written were announced here first
              {coverage.quiet.length > 0 && (
                <button
                  className="ch-quiet-btn"
                  title="Select the files that were written without anyone mentioning them here"
                  onClick={() => onSelectFiles(coverage.quiet)}
                  data-testid="channel-show-quiet"
                >
                  show the {coverage.quiet.length} that were not
                </button>
              )}
            </>
          )}
        </span>
      </div>
      )}

      {/*
        The one thing nobody in the room can see for themselves: two agents
        heading for the same file, before either has written anything.
      */}
      {clashes.size > 0 && (
        <div className="channel-clash" data-testid="channel-clash">
          <b>Two agents are heading for the same file.</b>
          {[...clashes.entries()].map(([path, notices]) => (
            <div key={path} className="channel-clash-row">
              <a className="deplink mono" onClick={() => onSelectFile(path)}>
                {path}
              </a>
              <span>
                {[...new Set(notices.map((n) => n.agentName))].join(' and ')} have both said they are
                taking it. Nothing is blocked, so whoever writes second wins — say something below,
                or leave them to settle it.
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="channel-body">
        {/* ---- the transcript ---- */}
        <div className="channel-main">
          <div className="channel-filters">
            <button
              className={`ch-chip${fromFilter === null && kindFilter === null ? ' on' : ''}`}
              onClick={() => {
                setFromFilter(null);
                setKindFilter(null);
              }}
              data-testid="channel-filter-all"
            >
              everything
            </button>
            {agents.map((agent) => (
              <button
                key={agent.id}
                className={`ch-chip agent${fromFilter === agent.id ? ' on' : ''}`}
                style={{ '--agent': agentColor(agent.id) } as React.CSSProperties}
                title={`Only what ${agent.name} said`}
                onClick={() => setFromFilter((prev) => (prev === agent.id ? null : agent.id))}
                data-testid={`channel-filter-${agent.id}`}
              >
                <span className="ch-chip-mark">{agentShape(agent.id)}</span>
                {agent.name}
              </button>
            ))}
            {KINDS.map((k) => (
              <button
                key={k}
                className={`ch-chip${kindFilter === k ? ' on' : ''}`}
                title={`Only "${POST_LABEL[k]}" posts`}
                onClick={() => setKindFilter((prev) => (prev === k ? null : k))}
                data-testid={`channel-kind-${k}`}
              >
                {POST_LABEL[k]}
              </button>
            ))}
            <span className="spacer" />
            <input
              className="ch-search"
              placeholder="filter…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="channel-search"
            />
          </div>

          <div
            className="channel-feed"
            ref={feedRef}
            data-testid="channel-feed"
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {channel.length === 0 ? (
              <div className="issues-empty">
                <div className="issues-empty-mark">○</div>
                Nothing said yet.
                <div className="muted" style={{ fontSize: 11, maxWidth: 460, textAlign: 'center' }}>
                  When an agent starts a piece of work it posts what it is taking here, and the files
                  it names get a mark on the graph. Point one at this project and it joins by name:
                  <div className="mono agents-url">
                    claude mcp add --transport http flare {mcpUrl ?? '<the MCP url in the status bar>'}
                  </div>
                </div>
              </div>
            ) : visible.length === 0 ? (
              <div className="issues-empty">
                <div className="issues-empty-mark">○</div>
                nothing matches that filter
              </div>
            ) : (
              visible.map((message, i) => {
                const previous = visible[i - 1];
                /*
                 * Consecutive lines from one speaker are one turn.
                 *
                 * An agent posting "taking x", "taking y", "done with x" in
                 * the same minute is one person talking, and repeating the
                 * mark and the name three times turns a conversation into a
                 * log. The kind has to match too — "taking" and "done" are
                 * different statements and each earns its own tag.
                 */
                const grouped =
                  previous !== undefined &&
                  previous.from === message.from &&
                  previous.kind === message.kind &&
                  message.at - previous.at < 5 * 60_000;
                const mine = message.from === 'you';
                const open = opened.has(message.id);
                const facts = message.paths.length > 0 ? followUp(message, bursts) : null;
                /* one number in the collapsed line: did the files it named
                   turn into writes, or is it still all talk */
                const done = facts ? facts.written.length : 0;
                return (
                  <div
                    key={message.id}
                    className={`chat-turn${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`}
                    data-testid={`chat-${message.id}`}
                    style={{ '--agent': agentColor(message.from) } as React.CSSProperties}
                  >
                    <span className="chat-mark" title={message.fromName} aria-hidden="true">
                      {grouped ? '' : agentShape(message.from)}
                    </span>
                    <div className={`chat-bubble ${message.kind}`}>
                      {!grouped && (
                        <div className="chat-head">
                          <span className="chat-from">{message.fromName}</span>
                          {message.toName && <span className="chat-to">to {message.toName}</span>}
                          {/* "says" is the default and needs no label — a tag on
                              every line is a tag nobody reads */}
                          {message.kind !== 'saying' && (
                            <span className={`chat-kind ${message.kind}`}>
                              {POST_LABEL[message.kind]}
                            </span>
                          )}
                          <span className="chat-time">{ago(message.at)}</span>
                        </div>
                      )}

                      {/* what it said, in its own words, first */}
                      {message.text && <div className="chat-text">{message.text}</div>}

                      {message.paths.length > 0 && (
                        <>
                          <div className="chat-paths">
                            {message.paths.map((p) => (
                              <a
                                key={p}
                                className="chat-path mono"
                                title={`${p} — show it on the graph`}
                                onClick={() => onSelectFile(p)}
                              >
                                {p.split('/').pop()}
                              </a>
                            ))}
                            {/*
                              Everything in this room is a claim, and Flare is
                              the only participant that watched what followed.
                              So every line about files opens.
                            */}
                            <button
                              className="chat-more"
                              aria-expanded={open}
                              title={
                                open ? 'Hide what followed' : 'What actually happened after this'
                              }
                              onClick={() =>
                                setOpened((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(message.id)) next.delete(message.id);
                                  else next.add(message.id);
                                  return next;
                                })
                              }
                              data-testid={`chat-more-${message.id}`}
                            >
                              {open ? '▾' : '▸'}{' '}
                              {done > 0
                                ? `${done}/${message.paths.length} written`
                                : `${message.paths.length} file${message.paths.length === 1 ? '' : 's'}`}
                            </button>
                          </div>

                          {open && facts && (
                            <div className="chat-facts" data-testid={`chat-facts-${message.id}`}>
                              <div className="chat-fact-time">
                                {new Date(message.at).toLocaleString()}
                              </div>
                              {facts.written.map((w) => (
                                <div key={w.path} className="chat-fact good">
                                  wrote <a className="mono" onClick={() => onSelectFile(w.path)}>{w.path}</a>{' '}
                                  {ago(w.at)}
                                </div>
                              ))}
                              {facts.pending.map((p) => (
                                <div key={p} className="chat-fact">
                                  {message.kind === 'done' ? 'never wrote' : 'not written yet'}{' '}
                                  <a className="mono" onClick={() => onSelectFile(p)}>{p}</a>
                                </div>
                              ))}
                              {facts.crossed.map((c) => (
                                <div key={c.path} className="chat-fact warn">
                                  {c.by} wrote <a className="mono" onClick={() => onSelectFile(c.path)}>{c.path}</a>{' '}
                                  after this
                                </div>
                              ))}
                              {facts.written.length === 0 &&
                                facts.crossed.length === 0 &&
                                facts.pending.length === 0 && (
                                  <div className="chat-fact">nothing has been written since</div>
                                )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* ---- you, in the same room ---- */}
          <div className="channel-compose">
            <select
              className="chat-kind-pick"
              value={kind}
              onChange={(e) => setKind(e.target.value as PostKind)}
              title="What this post is. taking and done are the two the graph reads."
              data-testid="chat-kind"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {POST_LABEL[k]}
                </option>
              ))}
            </select>
            <select
              className="chat-to-pick"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              title="Address one agent, or the whole room"
              data-testid="chat-to"
            >
              <option value="">everyone</option>
              {agents.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
            <input
              className="collab-input"
              placeholder="Say something — any path you mention is marked on the graph"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              data-testid="chat-input"
            />
            <button
              className="btn primary"
              disabled={draft.trim() === ''}
              onClick={send}
              data-testid="chat-send"
            >
              Post
            </button>
          </div>
        </div>

        {/* ---- who is here, and where ---- */}
        <div className="channel-side" data-testid="channel-roster">
          <div className="channel-side-head">Right now</div>
          {agents.length === 0 && (
            <div className="collab-empty">
              No agent has connected yet. A second and a third connect to the same URL — they become
              Claude 2 and Codex 1, and everything here tells them apart.
            </div>
          )}
          {agents.map((agent) => {
            const presence = presenceOf(agent, now);
            const taken = [...working.entries()]
              .filter(([, notices]) => notices.some((n) => n.agentId === agent.id))
              .map(([path]) => path);
            const asked = waiting.filter((m) => m.to === agent.id).length;
            const wrote = bursts
              .filter((b) => b.agentId === agent.id)
              .reduce((n, b) => n + b.changed.length, 0);
            return (
              <div
                key={agent.id}
                className={`channel-agent ${presence}`}
                style={{ '--agent': agentColor(agent.id) } as React.CSSProperties}
                data-testid={`agent-${agent.id}`}
              >
                <div className="channel-agent-head">
                  <span className="agent-mark">{agentShape(agent.id)}</span>
                  <span className="agent-name">{agent.name}</span>
                  <span className={`agent-presence ${presence}`} title={PRESENCE_HINT[presence]}>
                    {PRESENCE_LABEL[presence]}
                  </span>
                  <span className="spacer" />
                  <span className="chat-time">{ago(agent.lastSeen)}</span>
                </div>
                <div className="channel-agent-doing">
                  {agent.doing ?? <span className="muted">has not said what it is doing</span>}
                </div>
                <div className="channel-agent-facts">
                  {taken.length > 0 ? (
                    <button
                      className="ch-quiet-btn"
                      title={`Select what ${agent.name} said it is taking:\n${taken.join('\n')}`}
                      onClick={() => onSelectFiles(taken)}
                      data-testid={`agent-show-${agent.id}`}
                    >
                      taking {taken.length === 1 ? taken[0].split('/').pop() : `${taken.length} paths`}
                    </button>
                  ) : (
                    <span className="muted">taking nothing</span>
                  )}
                  {wrote > 0 && <span title="files written this session">· wrote {wrote}</span>}
                  {/*
                    Reading is half the protocol and the half nobody can see.
                    An agent that posts and never reads is talking into a room
                    it is not listening to, which looks exactly like
                    coordination until two of them collide.
                  */}
                  {agent.lastReadAt === 0 && agent.calls > 2 && (
                    <span className="warn" title="This agent has never called chat_read — it is posting into a room it does not listen to.">
                      · never read the room
                    </span>
                  )}
                  {asked > 0 && (
                    <span className="warn" title="asked something it has not answered">
                      · {asked} unanswered
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
