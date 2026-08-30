import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../electron/services/roster';
import { noticesFor, workingOn } from '../shared/channel';

/**
 * The live side of the room.
 *
 * The two pure modules underneath are tested on their own; what is left here
 * is the part that reads the clock and mints ids, and one judgement it has to
 * get right: **what an agent is doing** is answered by what it said it was
 * *taking*, not by the last thing it happened to say. That line is the roster
 * column a person reads to decide whether to interrupt, and it is wrong in two
 * directions that are both easy to write — an aside overwriting it, and
 * finishing one of three files blanking it.
 */

function registry(): AgentRegistry {
  // no change events and no process list: this is about the bookkeeping
  return new AgentRegistry(() => {});
}

describe('what an agent is doing', () => {
  it('is what it said it was taking', () => {
    const agents = registry();
    agents.noteAgent('s1', 'claude-code');
    agents.say('s1', { kind: 'taking', paths: ['shared/graph.ts'], text: 'moving the port lookup' });
    expect(agents.get('s1')!.doing).toBe('moving the port lookup');
  });

  it('is not overwritten by an aside', () => {
    const agents = registry();
    agents.noteAgent('s1', 'claude-code');
    agents.say('s1', { kind: 'taking', paths: ['shared/graph.ts'], text: 'moving the port lookup' });
    agents.say('s1', { text: 'heads up, do not rename the exports in shared/conflicts' });
    expect(agents.get('s1')!.doing).toBe('moving the port lookup');
  });

  it('survives handing back one of several files', () => {
    const agents = registry();
    agents.noteAgent('s1', 'claude-code');
    agents.say('s1', {
      kind: 'taking',
      paths: ['shared/graph.ts', 'shared/resolver.ts'],
      text: 'moving the port lookup',
    });
    agents.say('s1', { kind: 'done', paths: ['shared/resolver.ts'], text: 'resolver is all yours' });
    expect(agents.get('s1')!.doing).toBe('moving the port lookup');
  });

  it('is cleared once it has handed everything back', () => {
    const agents = registry();
    agents.noteAgent('s1', 'claude-code');
    agents.say('s1', { kind: 'taking', paths: ['shared/graph.ts'], text: 'moving the port lookup' });
    agents.say('s1', { kind: 'done', paths: ['shared/graph.ts'], text: 'done' });
    expect(agents.get('s1')!.doing).toBeNull();
  });
});

describe('the room', () => {
  it('names two sessions of the same tool apart', () => {
    const agents = registry();
    expect(agents.noteAgent('s1', 'claude-code')!.name).toBe('Claude 1');
    expect(agents.noteAgent('s2', 'claude-code')!.name).toBe('Claude 2');
    expect(agents.noteAgent('s3', 'codex')!.name).toBe('Codex 1');
  });

  it('registers a client that never initialised, on its first call', () => {
    const agents = registry();
    agents.noteCall('s9');
    expect(agents.get('s9')).not.toBeNull();
  });

  it('addresses an agent by the name a person would type', () => {
    const agents = registry();
    agents.noteAgent('s1', 'claude-code');
    expect(agents.resolve('Claude 1')?.id).toBe('mcp:s1');
    expect(agents.resolve('@claude 1')?.id).toBe('mcp:s1');
    expect(agents.resolve('claude1')?.id).toBe('mcp:s1');
    expect(agents.resolve('Claude 9')).toBeNull();
  });

  /*
   * Posting is also reading. An agent that says "taking shared/graph.ts" and
   * is handed what it missed in the same breath has no reason to call
   * chat_read first — and the one call it was always going to make is the one
   * that catches it up.
   */
  it('hands an agent what it missed when it posts', () => {
    const agents = registry();
    agents.noteAgent('s1', 'claude-code');
    agents.noteAgent('s2', 'claude-code');
    agents.say('s1', { kind: 'taking', paths: ['shared'], text: 'in here' });

    const posted = agents.say('s2', { text: 'anyone in the parser?' });
    expect(posted.unread.map((m) => m.text)).toEqual(['in here']);
    // and does not hand it back a second time
    expect(agents.read('s2').messages).toEqual([]);
  });

  it('never counts an agent its own posts as unread', () => {
    const agents = registry();
    agents.noteAgent('s1', 'claude-code');
    agents.say('s1', { text: 'one' });
    expect(agents.read('s1').unread).toBe(0);
  });

  it('lets the human into the same room, as themselves', () => {
    const agents = registry();
    agents.sayAsHuman({ text: 'leave shared/graph.ts alone for ten minutes', paths: ['shared/graph.ts'] });
    const [message] = agents.messages();
    expect(message.from).toBe('you');
    expect(message.fromName).toBe('You');
  });

  it('turns what was said into who is where', () => {
    const agents = registry();
    agents.noteAgent('s1', 'claude-code');
    agents.say('s1', { kind: 'taking', paths: ['shared'], text: 'in here' });
    const working = workingOn(agents.messages(), Date.now());
    expect(noticesFor(working, 'shared/graph.ts').map((n) => n.agentName)).toEqual(['Claude 1']);
    expect(agents.working().size).toBe(1);
  });
});
