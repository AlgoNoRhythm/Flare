import { describe, expect, it } from 'vitest';
import {
  CHANNEL_LIMIT,
  NOTICE_TTL_MS,
  announcedShare,
  channelStats,
  contested,
  covers,
  followUp,
  formatMessage,
  noticesFor,
  noticesUnder,
  openAsks,
  post,
  unreadFor,
  workingOn,
  type ChannelMessage,
  type PostKind,
} from '../shared/channel';

/**
 * The room the agents coordinate in.
 *
 * There is no lock behind any of this, which is the point: everything here is
 * about turning what an agent *said* into something the other agents and the
 * map can read. Two things therefore have to hold. What one agent says must
 * never silently be undone by another — only its own `done` clears its own
 * `taking` — and two agents wanting the same file must survive as *both* of
 * them, because resolving it here would hide the only situation the room
 * exists to prevent.
 */

const T0 = 1_700_000_000_000;

interface Say {
  from: string;
  name?: string;
  kind?: PostKind;
  text?: string;
  paths?: string[];
  to?: string | null;
  at?: number;
}

function feedOf(says: Say[]): ChannelMessage[] {
  let feed: ChannelMessage[] = [];
  says.forEach((s, i) => {
    feed = post(feed, {
      id: `m${i}`,
      from: s.from,
      fromName: s.name ?? s.from,
      fromTool: 'claude',
      kind: s.kind,
      text: s.text ?? '',
      paths: s.paths,
      to: s.to ?? null,
      toName: s.to ?? null,
      now: s.at ?? T0 + i,
    });
  });
  return feed;
}

describe('covers', () => {
  it('matches a file and everything under a folder', () => {
    expect(covers('shared/graph.ts', 'shared/graph.ts')).toBe(true);
    expect(covers('shared', 'shared/graph.ts')).toBe(true);
  });

  it('does not match a folder that only shares a prefix', () => {
    expect(covers('shared', 'sharedstuff/graph.ts')).toBe(false);
  });

  it('is false for an empty mention, so a blank path takes nothing', () => {
    expect(covers('', 'anything.ts')).toBe(false);
  });
});

describe('post', () => {
  it('normalises the paths it is given', () => {
    const [message] = feedOf([{ from: 'a', kind: 'taking', paths: ['./src/graph/', 'src\\graph'] }]);
    expect(message.paths).toEqual(['src/graph']);
  });

  it('keeps the feed bounded', () => {
    const feed = feedOf(Array.from({ length: CHANNEL_LIMIT + 40 }, (_, i) => ({ from: 'a', text: `${i}` })));
    expect(feed).toHaveLength(CHANNEL_LIMIT);
    expect(feed[feed.length - 1].text).toBe(`${CHANNEL_LIMIT + 39}`);
  });
});

describe('workingOn', () => {
  it('reads a taking as a standing statement about the files it named', () => {
    const working = workingOn(feedOf([{ from: 'a', name: 'Claude 1', kind: 'taking', paths: ['shared'] }]), T0);
    expect(noticesFor(working, 'shared/graph.ts').map((n) => n.agentName)).toEqual(['Claude 1']);
  });

  it("clears on the same agent's done, including through the folder it took", () => {
    const working = workingOn(
      feedOf([
        { from: 'a', kind: 'taking', paths: ['shared'], at: T0 },
        { from: 'a', kind: 'done', paths: ['shared'], at: T0 + 10 },
      ]),
      T0 + 20,
    );
    expect(noticesFor(working, 'shared/graph.ts')).toEqual([]);
  });

  /*
   * An agent can only speak for its own work. Without this, one agent posting
   * "done with shared/graph.ts" would silently take the file out from under
   * another that had said it was in there.
   */
  it("does not let one agent's done clear another agent's taking", () => {
    const working = workingOn(
      feedOf([
        { from: 'a', name: 'Claude 1', kind: 'taking', paths: ['shared/graph.ts'], at: T0 },
        { from: 'b', name: 'Claude 2', kind: 'done', paths: ['shared/graph.ts'], at: T0 + 10 },
      ]),
      T0 + 20,
    );
    expect(noticesFor(working, 'shared/graph.ts').map((n) => n.agentName)).toEqual(['Claude 1']);
  });

  it('keeps both when two agents say they are taking the same file', () => {
    const working = workingOn(
      feedOf([
        { from: 'a', name: 'Claude 1', kind: 'taking', paths: ['shared/graph.ts'], at: T0 },
        { from: 'b', name: 'Claude 2', kind: 'taking', paths: ['shared'], at: T0 + 10 },
      ]),
      T0 + 20,
    );
    expect(noticesFor(working, 'shared/graph.ts').map((n) => n.agentName).sort()).toEqual([
      'Claude 1',
      'Claude 2',
    ]);
  });

  /*
   * The collision that actually happens: not two agents typing the same
   * string, but one taking a folder and the other taking a file inside it.
   */
  it('reports a folder and a file inside it as one contested path, the narrower one', () => {
    const working = workingOn(
      feedOf([
        { from: 'a', name: 'Claude 1', kind: 'taking', paths: ['shared'], at: T0 },
        { from: 'b', name: 'Claude 2', kind: 'taking', paths: ['shared/graph.ts'], at: T0 + 10 },
      ]),
      T0 + 20,
    );
    const clashes = contested(working);
    expect([...clashes.keys()]).toEqual(['shared/graph.ts']);
    expect(clashes.get('shared/graph.ts')!.map((n) => n.agentName).sort()).toEqual([
      'Claude 1',
      'Claude 2',
    ]);
  });

  it('is not contention when two agents took different folders', () => {
    const working = workingOn(
      feedOf([
        { from: 'a', kind: 'taking', paths: ['shared'], at: T0 },
        { from: 'b', kind: 'taking', paths: ['server'], at: T0 + 10 },
      ]),
      T0 + 20,
    );
    expect(contested(working).size).toBe(0);
  });

  it('lapses, so a killed agent stops holding a folder forever', () => {
    const feed = feedOf([{ from: 'a', kind: 'taking', paths: ['shared'], at: T0 }]);
    expect(workingOn(feed, T0 + NOTICE_TTL_MS - 1).size).toBe(1);
    expect(workingOn(feed, T0 + NOTICE_TTL_MS + 1).size).toBe(0);
  });

  it('ignores posts that named no files', () => {
    expect(workingOn(feedOf([{ from: 'a', kind: 'taking', text: 'starting now' }]), T0).size).toBe(0);
  });
});

describe('noticesUnder', () => {
  it('lets a folded folder answer for a file inside it', () => {
    const byFile = new Map(
      Object.entries({
        'src/graph/lenses.ts': workingOn(
          feedOf([{ from: 'a', name: 'Claude 1', kind: 'taking', paths: ['src/graph/lenses.ts'] }]),
          T0,
        ).get('src/graph/lenses.ts')!,
      }),
    );
    expect(noticesUnder(byFile, 'src/graph').map((n) => n.agentName)).toEqual(['Claude 1']);
    expect(noticesUnder(byFile, 'server')).toEqual([]);
  });
});

describe('openAsks', () => {
  it('is a question aimed at someone who has not spoken since', () => {
    const feed = feedOf([
      { from: 'b', name: 'Claude 2', kind: 'asking', to: 'a', text: 'is graph.ts free?', at: T0 },
    ]);
    expect(openAsks(feed, T0 + 100)).toHaveLength(1);
  });

  it('closes as soon as the agent it was aimed at posts anything', () => {
    const feed = feedOf([
      { from: 'b', kind: 'asking', to: 'a', text: 'is graph.ts free?', at: T0 },
      { from: 'a', kind: 'done', paths: ['shared/graph.ts'], text: 'all yours', at: T0 + 10 },
    ]);
    expect(openAsks(feed, T0 + 100)).toEqual([]);
  });

  it('ignores a question addressed to the room', () => {
    expect(openAsks(feedOf([{ from: 'b', kind: 'asking', text: 'anyone in the parser?' }]), T0)).toEqual([]);
  });
});

describe('unreadFor', () => {
  it('is what happened since you last looked, minus your own posts', () => {
    const feed = feedOf([
      { from: 'a', text: 'one', at: T0 },
      { from: 'b', text: 'two', at: T0 + 10 },
      { from: 'a', text: 'three', at: T0 + 20 },
    ]);
    expect(unreadFor(feed, 'a', T0).map((m) => m.text)).toEqual(['two']);
  });
});

describe('announcedShare', () => {
  /*
   * The number that says whether any of the rest of this means anything. A
   * busy-looking feed is not evidence of coordination; files that were
   * announced before they were written is.
   */
  const wrote = (agentId: string, changed: string[], endedAt = T0 + 100) => ({
    agent: 'claude',
    agentId,
    changed,
    endedAt,
  });

  it('counts a file as announced when its own author said it was taking it', () => {
    const feed = feedOf([{ from: 'mcp:a', kind: 'taking', paths: ['shared'], at: T0 }]);
    expect(announcedShare([wrote('mcp:a', ['shared/graph.ts'])], feed)).toEqual({
      announced: 1,
      total: 1,
      quiet: [],
    });
  });

  /*
   * Someone else's notice is not your announcement — that is the crossing the
   * review reports, and counting it here would score a collision as good
   * behaviour.
   */
  it('does not credit an agent for what another agent announced', () => {
    const feed = feedOf([{ from: 'mcp:b', kind: 'taking', paths: ['shared/graph.ts'], at: T0 }]);
    const out = announcedShare([wrote('mcp:a', ['shared/graph.ts'])], feed);
    expect(out).toEqual({ announced: 0, total: 1, quiet: ['shared/graph.ts'] });
  });

  it('does not credit a notice posted after the write landed', () => {
    const feed = feedOf([{ from: 'mcp:a', kind: 'taking', paths: ['shared/graph.ts'], at: T0 + 500 }]);
    expect(announcedShare([wrote('mcp:a', ['shared/graph.ts'], T0 + 100)], feed).announced).toBe(0);
  });

  it('leaves your own edits out of it, on both sides', () => {
    const feed = feedOf([{ from: 'mcp:a', kind: 'taking', paths: ['shared'], at: T0 }]);
    const mine = { agent: 'you', changed: ['README.md'], endedAt: T0 + 100 };
    expect(announcedShare([mine], feed)).toEqual({ announced: 0, total: 0, quiet: [] });
  });

  it('counts a file once however many times it was written', () => {
    const feed = feedOf([{ from: 'mcp:a', kind: 'taking', paths: ['shared/graph.ts'], at: T0 }]);
    const out = announcedShare(
      [wrote('mcp:a', ['shared/graph.ts'], T0 + 50), wrote('mcp:a', ['shared/graph.ts'], T0 + 90)],
      feed,
    );
    expect(out.total).toBe(1);
  });
});

describe('followUp', () => {
  /*
   * Everything in the room is a claim, and Flare is the only participant that
   * watched what followed. This is what lets a line be opened and checked.
   */
  const said = feedOf([
    {
      from: 'mcp:a',
      name: 'Claude 1',
      kind: 'taking',
      paths: ['shared/graph.ts', 'shared/resolver.ts'],
      at: T0,
    },
  ]);

  it('says which of the files it named it went on to write', () => {
    const out = followUp(said[0], [
      { agent: 'claude', agentId: 'mcp:a', changed: ['shared/graph.ts'], endedAt: T0 + 60_000 },
    ]);
    expect(out.written.map((w) => w.path)).toEqual(['shared/graph.ts']);
    expect(out.pending).toEqual(['shared/resolver.ts']);
    expect(out.crossed).toEqual([]);
  });

  /*
   * The line that cannot be got any other way: an agent said it was taking
   * this, and somebody else wrote it. The message is where a person is
   * actually looking when they want to know that.
   */
  it('names anyone else who wrote one of them afterwards', () => {
    const out = followUp(said[0], [
      {
        agent: 'claude',
        agentId: 'mcp:b',
        agentName: 'Claude 2',
        changed: ['shared/graph.ts'],
        endedAt: T0 + 60_000,
      },
    ]);
    expect(out.crossed).toEqual([{ path: 'shared/graph.ts', by: 'Claude 2' }]);
    expect(out.written).toEqual([]);
  });

  it('ignores writes that landed before it was said', () => {
    const out = followUp(said[0], [
      { agent: 'claude', agentId: 'mcp:a', changed: ['shared/graph.ts'], endedAt: T0 - 1 },
    ]);
    expect(out.written).toEqual([]);
    expect(out.pending).toEqual(['shared/graph.ts', 'shared/resolver.ts']);
  });

  it('counts a write under a folder the agent took', () => {
    const [folder] = feedOf([{ from: 'mcp:a', kind: 'taking', paths: ['shared'], at: T0 }]);
    const out = followUp(folder, [
      { agent: 'claude', agentId: 'mcp:a', changed: ['shared/graph.ts'], endedAt: T0 + 10 },
    ]);
    expect(out.written.map((w) => w.path)).toEqual(['shared/graph.ts']);
    expect(out.pending).toEqual([]);
  });
});

describe('channelStats', () => {
  it('adds the room up the way the panel reads it', () => {
    const feed = feedOf([
      { from: 'a', name: 'Claude 1', kind: 'taking', paths: ['shared/graph.ts'], at: T0 },
      { from: 'b', name: 'Claude 2', kind: 'taking', paths: ['shared'], at: T0 + 10 },
      { from: 'b', name: 'Claude 2', kind: 'asking', to: 'a', text: 'free?', at: T0 + 20 },
    ]);
    const stats = channelStats(feed, T0 + 30);
    expect(stats.messages).toBe(3);
    expect(stats.byKind.taking).toBe(2);
    expect(stats.contested).toBe(1);
    expect(stats.waiting).toBe(1);
    expect(stats.lastAt).toBe(T0 + 20);
  });

  it('is all zeroes for an empty room rather than undefined', () => {
    const stats = channelStats([], T0);
    expect(stats).toEqual({
      messages: 0,
      byKind: { taking: 0, done: 0, asking: 0, saying: 0 },
      spokenFor: 0,
      contested: 0,
      waiting: 0,
      lastAt: 0,
    });
  });
});

describe('formatMessage', () => {
  it('reads as a line of transcript', () => {
    const [message] = feedOf([
      { from: 'a', name: 'Claude 1', kind: 'taking', paths: ['shared/graph.ts'], text: 'moving the port lookup' },
    ]);
    expect(formatMessage(message)).toBe('Claude 1 taking shared/graph.ts\n  moving the port lookup');
  });

  it('names the agent a question is aimed at', () => {
    const [message] = feedOf([
      { from: 'b', name: 'Claude 2', kind: 'asking', to: 'Claude 1', text: 'is it free?' },
    ]);
    expect(formatMessage(message)).toContain('Claude 2 → Claude 1 asking');
  });
});
