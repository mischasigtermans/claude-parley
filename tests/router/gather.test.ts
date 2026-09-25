import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { createRoom, postMessage, readRoom, unseenBy, listRooms, slugForQuestion } from '../../src/registry/rooms.js';
import { runRounds, speakingOrder, isPass, type AskFn } from '../../src/routing/gather.js';
import type { ProjectId } from '../../src/registry/paths.js';
import { setup } from '../helpers/tmpdir.js';
import { readFile } from 'node:fs/promises';
import { paths } from '../../src/registry/paths.js';

const PROJ = 'caller000000' as ProjectId;

function recordingAsk(reply: (peer: string, prompt: string, n: number) => string) {
  const calls: { peer: string; prompt: string }[] = [];
  const ask: AskFn = async (peer, prompt) => {
    calls.push({ peer, prompt });
    return reply(peer, prompt, calls.length);
  };
  return { ask, calls };
}

async function room(participants = ['steve', 'taylor']) {
  return createRoom({ projectId: PROJ, room: 'test-room', question: 'Ship or cut?', participants, convenedBy: 'caller' });
}

describe('runRounds', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('round 1 is blind: every participant asked in parallel with only the question', async () => {
    const state = await room();
    const { ask, calls } = recordingAsk((p) => `${p} says ship`);
    const result = await runRounds({ state, rounds: 1, ask });

    expect(calls.map((c) => c.peer)).toEqual(['steve', 'taylor']);
    for (const c of calls) {
      expect(c.prompt).toContain('blind round');
      expect(c.prompt).toContain('Ship or cut?');
      expect(c.prompt).not.toContain('Since your last turn');
    }
    expect(result.state.round).toBe(1);
    expect(result.state.status).toBe('open');
    expect(result.state.messages.map((m) => m.text)).toEqual(['steve says ship', 'taylor says ship']);
  });

  it('round 2 shows each participant only what it has not seen, in order', async () => {
    const state = await room();
    const { ask, calls } = recordingAsk((p, _q, n) => `${p}#${n}`);
    await runRounds({ state, rounds: 2, ask });

    const r2 = calls.slice(2);
    expect(r2[0].peer).toBe('steve');
    expect(r2[0].prompt).toContain('**taylor:** taylor#2');
    expect(r2[0].prompt).not.toContain('steve#1');
    expect(r2[1].peer).toBe('taylor');
    expect(r2[1].prompt).toContain('**steve:** steve#1');
    expect(r2[1].prompt).toContain('**steve:** steve#3');
    expect(r2[1].prompt).not.toContain('taylor#2');
    expect(state.seen.steve).toBe(2);
    expect(state.seen.taylor).toBe(3);
  });

  it('converges early when everyone passes', async () => {
    const state = await room();
    const { ask, calls } = recordingAsk((p, q) => (q.includes('blind') ? `${p} initial` : 'PASS'));
    const result = await runRounds({ state, rounds: 5, ask });

    expect(result.state.status).toBe('converged');
    expect(result.state.round).toBe(2);
    expect(result.roundsRun).toBe(2);
    expect(calls).toHaveLength(4);
    const passes = result.state.messages.filter((m) => m.pass);
    expect(passes).toHaveLength(2);
    expect(unseenBy(result.state, 'steve')).toHaveLength(0);
  });

  it('a participant with nothing new to see is skipped and counts as passed', async () => {
    const state = await room(['a', 'b']);
    const { ask, calls } = recordingAsk((p, q) => (q.includes('blind') ? `${p} v1` : p === 'a' ? 'PASS' : 'b replies'));
    await runRounds({ state, rounds: 3, ask });
    // round 2: a passes, b replies. round 3: a sees b's reply and is asked; b sees nothing new (a passed) and is skipped.
    const r3 = calls.slice(4);
    expect(r3.map((c) => c.peer)).toEqual(['a']);
    expect(state.round).toBe(3);
  });

  it('a failed ask is recorded as a pass-flagged note and the room continues', async () => {
    const state = await room();
    const ask: AskFn = async (peer) => {
      if (peer === 'taylor') throw new Error('boom');
      return 'steve fine';
    };
    const result = await runRounds({ state, rounds: 1, ask });
    const taylor = result.state.messages.find((m) => m.from === 'taylor');
    expect(taylor?.pass).toBe(true);
    expect(taylor?.text).toContain('boom');
    expect(unseenBy(result.state, 'steve')).toHaveLength(0);
  });

  it('a chair message is delivered to everyone on the next round', async () => {
    const state = await room();
    const { ask, calls } = recordingAsk((p, q) => (q.includes('blind') ? `${p} v1` : `${p} v2`));
    await runRounds({ state, rounds: 1, ask });
    await postMessage(state, 'caller (chair)', 'Consider the budget.');
    await runRounds({ state, rounds: 1, ask });
    for (const c of calls.slice(2)) {
      expect(c.prompt).toContain('**caller (chair):** Consider the budget.');
    }
  });

  it('persists state and a readable transcript', async () => {
    const state = await room();
    const { ask } = recordingAsk((p) => `${p} v1`);
    await runRounds({ state, rounds: 1, ask });
    const reloaded = await readRoom(PROJ, 'test-room');
    expect(reloaded?.messages).toHaveLength(2);
    const transcript = await readFile(paths.roomTranscript(PROJ, 'test-room'), 'utf8');
    expect(transcript).toContain('**Question:** Ship or cut?');
    expect(transcript).toContain('round 1 · steve');
    expect((await listRooms(PROJ)).map((r) => r.room)).toEqual(['test-room']);
  });

  it('refuses to run in a closed room', async () => {
    const state = await room();
    state.status = 'closed';
    await expect(runRounds({ state, rounds: 1, ask: async () => 'x' })).rejects.toThrow(/closed/);
  });
});

describe('speakingOrder', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('puts @-mentioned participants first', async () => {
    const state = await room(['a', 'b', 'c']);
    state.round = 1;
    await postMessage(state, 'a', 'I disagree with @c on this');
    expect(speakingOrder(state)).toEqual(['c', 'a', 'b']);
  });

  it('puts grounders before advisors, mentions first within each group', async () => {
    const state = await createRoom({ projectId: PROJ, room: 'g', question: 'q', participants: ['a', 'b', 'p', 'q'], grounders: ['p', 'q'], convenedBy: 'caller' });
    state.round = 1;
    await postMessage(state, 'a', 'is that true @q? and @b you are wrong');
    expect(speakingOrder(state)).toEqual(['q', 'p', 'b', 'a']);
  });
});

describe('helpers', () => {
  it('isPass matches PASS at the start only', () => {
    expect(isPass('PASS')).toBe(true);
    expect(isPass('  pass.')).toBe(true);
    expect(isPass('PASSing this along')).toBe(false);
    expect(isPass('I would not PASS')).toBe(false);
  });

  it('slugForQuestion makes a short hyphenated name', () => {
    expect(slugForQuestion('Should we ship the wallet pass before the artwork lands?')).toBe('should-we-ship-the-wallet');
    expect(slugForQuestion('???')).toBe('room');
  });
});
