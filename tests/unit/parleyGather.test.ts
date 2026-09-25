import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parleyGather } from '../../src/tools/parleyGather.js';
import { parleyRoom } from '../../src/tools/parleyRoom.js';
import { writePeers } from '../../src/registry/peers.js';
import { writeManifest } from '../../src/registry/sessions.js';
import { readHeadless } from '../../src/registry/headless.js';
import { readRoom, listRooms } from '../../src/registry/rooms.js';
import { readTranscript } from '../../src/routing/transcript.js';
import { paths, type ProjectId } from '../../src/registry/paths.js';
import { _setClaudeDriverForTesting } from '../../src/drivers/claude.js';
import type { ParleyContext } from '../../src/context.js';
import { createMockDriver, type MockDriver } from '../helpers/mock-driver.js';
import { setup } from '../helpers/tmpdir.js';

const PROJ = 'caller000000' as ProjectId;

function fakeCtx(): ParleyContext {
  return {
    pluginRoot: '',
    cwd: '/abs/caller',
    getCurrentSessionId: () => 'caller',
    getCurrentSessionResolution: () => null,
    getCurrentProjectName: () => 'caller',
    getCurrentProjectPath: () => '/abs/caller',
    getProjectId: async () => PROJ,
  };
}

async function registerCaller() {
  await writeManifest({
    sessionId: 'caller',
    claudeSessionId: null,
    projectPath: '/abs/caller',
    projectName: 'caller',
    alias: 'caller',
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    status: 'registered',
    pid: 0,
  });
}

/** Mock that answers the blind round in voice and PASSes from round `passFrom` on. */
function scriptedDriver(passFrom = Infinity): MockDriver {
  return createMockDriver({
    output: (o) => {
      const round = Number(/round (\d+) of/.exec(o.prompt)?.[1] ?? 0);
      const peer = o.cwd.split('/').pop();
      return round >= passFrom ? 'PASS' : `${peer} r${round}`;
    },
    sessionId: (o) => `sid-${o.cwd.split('/').pop()}`,
  });
}

describe('parley_gather', () => {
  const t = setup();
  beforeEach(async () => {
    await t.before();
    await registerCaller();
    await writePeers({ peers: { a: { path: '/abs/a' }, b: { path: '/abs/b' }, c: { path: '/abs/c' } } });
  });
  afterEach(async () => {
    _setClaudeDriverForTesting(null);
    await t.after();
  });

  describe('parseArgs', () => {
    it('rejects fewer than two peers', () => {
      expect(() => parleyGather.parseArgs!({ peers: ['a'], question: 'q' })).toThrow(/at least two/);
      expect(() => parleyGather.parseArgs!({ peers: 'a', question: 'q' })).toThrow(/at least two/);
    });
    it('rejects rounds below 1 and floors fractions', () => {
      expect(() => parleyGather.parseArgs!({ peers: ['a', 'b'], question: 'q', rounds: 0 })).toThrow(/rounds/);
      expect(parleyGather.parseArgs!({ peers: ['a', 'b'], question: 'q', rounds: 2.7 }).rounds).toBe(2);
    });
    it('defaults rounds to 3 and projectAccess to true', () => {
      const parsed = parleyGather.parseArgs!({ peers: ['a', 'b'], question: 'q' });
      expect(parsed.rounds).toBe(3);
      expect(parsed.projectAccess).toBe(true);
      expect(parleyGather.parseArgs!({ peers: ['a', 'b'], question: 'q', projectAccess: false }).projectAccess).toBe(false);
    });
    it('requires a question', () => {
      expect(() => parleyGather.parseArgs!({ peers: ['a', 'b'] })).toThrow(/question/);
    });
  });

  it('rejects an unknown peer before creating a room', async () => {
    _setClaudeDriverForTesting(scriptedDriver());
    await expect(
      parleyGather.handler({ grounders: [], projectAccess: true, peers: ['a', 'ghost'], question: 'q', rounds: 1 }, fakeCtx()),
    ).rejects.toThrow(/"ghost" not found/);
    expect(await listRooms(PROJ)).toHaveLength(0);
  });

  it('collapses aliases of the same extension peer and refuses a one-peer room', async () => {
    _setClaudeDriverForTesting(scriptedDriver());
    await mkdir(paths.extensionsDir, { recursive: true });
    await writeFile(
      join(paths.extensionsDir, 'personas.json'),
      JSON.stringify({
        name: 'personas',
        version: '0.1.0',
        peers: [
          { alias: 'steve-jobs', path: '/abs/steve' },
          { alias: 'steve', path: '/abs/steve' },
        ],
      }),
    );
    await expect(
      parleyGather.handler({ grounders: [], projectAccess: true, peers: ['steve', 'steve-jobs'], question: 'q', rounds: 1 }, fakeCtx()),
    ).rejects.toThrow(/at least two distinct/);

    const out = await parleyGather.handler({ grounders: [], projectAccess: true, peers: ['steve', 'steve-jobs', 'a'], question: 'q', rounds: 1 }, fakeCtx());
    expect(out).toContain('Participants: steve-jobs, a');
  });

  it('runs the rounds, names the room from the question, and reports how to continue', async () => {
    const mock = scriptedDriver();
    _setClaudeDriverForTesting(mock);
    const out = await parleyGather.handler(
      { grounders: [], peers: ['a', 'b'], question: 'Should we ship the wallet pass first?', rounds: 2 },
      fakeCtx(),
    );
    expect(out).toContain('[room should-we-ship-the-wallet · open · round 2]');
    expect(out).toContain('### Round 1');
    expect(out).toContain('**a:** a r1');
    expect(out).toContain('### Round 2');
    expect(out).toContain('**b:** b r2');
    expect(out).toContain('2 round(s) run');
    expect(out).toContain('parley_room say');
    expect(mock.invocations).toHaveLength(4);
  });

  it('reports convergence when everyone passes', async () => {
    _setClaudeDriverForTesting(scriptedDriver(2));
    const out = await parleyGather.handler({ grounders: [], projectAccess: true, peers: ['a', 'b'], question: 'q', rounds: 4 }, fakeCtx());
    expect(out).toContain('· converged · round 2]');
    expect(out).toContain('room converged');
    expect(out).toContain('**a:** PASS');
  });

  it('suffixes an auto-named room that already exists, and refuses an explicit duplicate', async () => {
    _setClaudeDriverForTesting(scriptedDriver());
    await parleyGather.handler({ grounders: [], projectAccess: true, peers: ['a', 'b'], question: 'same q', rounds: 1 }, fakeCtx());
    const second = await parleyGather.handler({ grounders: [], projectAccess: true, peers: ['a', 'b'], question: 'same q', rounds: 1 }, fakeCtx());
    expect(second).toContain('[room same-q-2 ·');
    await expect(
      parleyGather.handler({ grounders: [], projectAccess: true, peers: ['a', 'b'], question: 'x', room: 'same-q', rounds: 1 }, fakeCtx()),
    ).rejects.toThrow(/already exists/);
  });

  it('rejects an invalid explicit room name', async () => {
    _setClaudeDriverForTesting(scriptedDriver());
    await expect(
      parleyGather.handler({ grounders: [], projectAccess: true, peers: ['a', 'b'], question: 'x', room: 'Bad Name', rounds: 1 }, fakeCtx()),
    ).rejects.toThrow(/invalid room name/);
  });

  it('every turn runs through the peer\'s own continuous session and transcript', async () => {
    const mock = scriptedDriver();
    _setClaudeDriverForTesting(mock);
    await parleyGather.handler({ grounders: [], projectAccess: true, peers: ['a', 'b'], question: 'q', rounds: 2 }, fakeCtx());

    const a = await readHeadless(PROJ, 'a');
    expect(a?.turnCount).toBe(2);
    expect(a?.claudeSessionId).toBe('sid-a');
    // round 2 resumed the round 1 session
    const aCalls = mock.invocations.filter((i) => i.cwd === '/abs/a');
    expect(aCalls[1].sessionId).toBe('sid-a');
    expect(await readTranscript(PROJ, 'a', 0)).toContain('parley room');
  });

  it('a peer that errors is noted and the room still completes', async () => {
    const mock = createMockDriver({
      output: (o) => {
        if (o.cwd.endsWith('/b')) throw new Error('peer b exploded');
        return 'a ok';
      },
    });
    _setClaudeDriverForTesting(mock);
    const out = await parleyGather.handler({ grounders: [], projectAccess: true, peers: ['a', 'b'], question: 'q', rounds: 1 }, fakeCtx());
    expect(out).toContain('**b:** [no answer:');
    expect(out).toContain('peer b exploded');
    const state = await readRoom(PROJ, 'q');
    expect(state?.messages.find((m) => m.from === 'b')?.pass).toBe(true);
  });

  describe('grounders', () => {
    it('must be one of the room peers, and not all of them', async () => {
      _setClaudeDriverForTesting(scriptedDriver());
      await expect(
        parleyGather.handler({ grounders: ['c'], projectAccess: true, peers: ['a', 'b'], question: 'q', rounds: 1 }, fakeCtx()),
      ).rejects.toThrow(/grounder "c" is not one of the room's peers/);
      await expect(
        parleyGather.handler({ grounders: ['a', 'b'], projectAccess: true, peers: ['a', 'b'], question: 'q', rounds: 1 }, fakeCtx()),
      ).rejects.toThrow(/at least one peer that advises/);
      expect(() => parleyGather.parseArgs!({ peers: ['a', 'b'], question: 'q', grounders: 'a' })).toThrow(/grounders/);
    });

    it('gets the verifying prompt in both rounds, speaks first, and is labelled in the render', async () => {
      const mock = scriptedDriver();
      _setClaudeDriverForTesting(mock);
      const out = await parleyGather.handler(
        { grounders: ['c'], projectAccess: true, peers: ['a', 'b', 'c'], question: 'q', rounds: 2 },
        fakeCtx(),
      );
      const byPeer = (cwd: string) => mock.invocations.filter((i) => i.cwd === cwd).map((i) => i.prompt);
      const [cBlind, cRound] = byPeer('/abs/c');
      const [aBlind, aRound] = byPeer('/abs/a');
      expect(cBlind).toContain('grounding, not advising');
      expect(cBlind).toContain('Check every factual claim');
      expect(cBlind).not.toContain('Take a clear position');
      expect(cRound).toContain('Verify the factual claims');
      expect(cRound).toContain('@c');
      expect(aBlind).toContain('The others: b, c (grounding)');
      expect(aBlind).toContain('The convening project lives at /abs/caller');
      expect(aRound).toContain('The convening project lives at /abs/caller');
      expect(cBlind).not.toContain('convening project lives at');
      expect(aBlind).toContain('Take a clear position');
      expect(aRound).toContain('Participants: a, b, c (grounding)');
      expect(aRound).toContain('Agree or disagree explicitly');
      // round 2 order: grounder c first, then a, b
      expect(mock.invocations.slice(3).map((i) => i.cwd)).toEqual(['/abs/c', '/abs/a', '/abs/b']);
      // a's round-2 delta already contains c's round-2 correction
      expect(aRound).toContain('**c:** c r2');
      expect(out).toContain('Participants: a, b, c (grounding)');
    });

    it('projectAccess: false withholds the path', async () => {
      const mock = scriptedDriver();
      _setClaudeDriverForTesting(mock);
      await parleyGather.handler(
        { grounders: [], projectAccess: false, peers: ['a', 'b'], question: 'q', rounds: 2 },
        fakeCtx(),
      );
      expect(mock.invocations).toHaveLength(4);
      for (const i of mock.invocations) expect(i.prompt).not.toContain('convening project lives at');
    });
  });

  it('honours the peer\'s model and skipPermissions like parley_ask does', async () => {
    const mock = scriptedDriver();
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { a: { path: '/abs/a', model: 'opus', skipPermissions: false }, b: { path: '/abs/b' } } });
    await parleyGather.handler({ grounders: [], projectAccess: true, peers: ['a', 'b'], question: 'q', rounds: 1 }, fakeCtx());
    const aCall = mock.invocations.find((i) => i.cwd === '/abs/a')!;
    expect(aCall.model).toBe('opus');
    expect(aCall.skipPermissions).toBe(false);
  });
});

describe('parley_room', () => {
  const t = setup();
  beforeEach(async () => {
    await t.before();
    await registerCaller();
    await writePeers({ peers: { a: { path: '/abs/a' }, b: { path: '/abs/b' } } });
  });
  afterEach(async () => {
    _setClaudeDriverForTesting(null);
    await t.after();
  });

  async function seedRoom(rounds = 1, passFrom = Infinity) {
    _setClaudeDriverForTesting(scriptedDriver(passFrom));
    await parleyGather.handler({ grounders: [], projectAccess: true, peers: ['a', 'b'], question: 'q', room: 'r1', rounds }, fakeCtx());
  }

  describe('parseArgs', () => {
    it('rejects unknown actions', () => {
      expect(() => parleyRoom.parseArgs!({ action: 'nuke', room: 'r1' })).toThrow(/action/);
    });
    it('requires room for everything but list', () => {
      expect(() => parleyRoom.parseArgs!({ action: 'log' })).toThrow(/room/);
      expect(parleyRoom.parseArgs!({ action: 'list' }).room).toBeUndefined();
    });
    it('defaults continue rounds to 1 and rejects 0', () => {
      expect(parleyRoom.parseArgs!({ action: 'continue', room: 'r1' }).rounds).toBe(1);
      expect(() => parleyRoom.parseArgs!({ action: 'continue', room: 'r1', rounds: 0 })).toThrow(/rounds/);
    });
  });

  it('list: empty, then one line per room, newest first', async () => {
    expect(await parleyRoom.handler({ action: 'list', rounds: 1 }, fakeCtx())).toMatch(/No rooms yet/);
    await seedRoom();
    _setClaudeDriverForTesting(scriptedDriver());
    await parleyGather.handler({ grounders: [], projectAccess: true, peers: ['a', 'b'], question: 'second', room: 'r2', rounds: 1 }, fakeCtx());
    const out = await parleyRoom.handler({ action: 'list', rounds: 1 }, fakeCtx());
    const lines = out.split('\n').filter((l) => !l.startsWith('  '));
    expect(lines[0]).toMatch(/^r2  open  round 1  \[a, b\]/);
    expect(lines[1]).toMatch(/^r1  open  round 1  \[a, b\]/);
    expect(out).toContain('  second');
  });

  it('log: returns the readable transcript', async () => {
    await seedRoom();
    const out = await parleyRoom.handler({ action: 'log', room: 'r1', rounds: 1 }, fakeCtx());
    expect(out).toContain('# Room: r1');
    expect(out).toContain('**Question:** q');
    expect(out).toContain('round 1 · a');
  });

  it('unknown room errors for log, say, continue, close', async () => {
    for (const action of ['log', 'say', 'continue', 'close'] as const) {
      await expect(
        parleyRoom.handler({ action, room: 'nope', message: 'm', rounds: 1 }, fakeCtx()),
      ).rejects.toThrow(/not found/);
    }
  });

  it('say: posts as chair, requires a message, and reopens a converged room', async () => {
    await seedRoom(3, 2);
    expect((await readRoom(PROJ, 'r1'))?.status).toBe('converged');
    await expect(
      parleyRoom.handler({ action: 'say', room: 'r1', rounds: 1 }, fakeCtx()),
    ).rejects.toThrow(/message/);
    const out = await parleyRoom.handler({ action: 'say', room: 'r1', message: 'Mind the budget.', rounds: 1 }, fakeCtx());
    expect(out).toMatch(/Posted to room "r1"/);
    const state = await readRoom(PROJ, 'r1');
    expect(state?.status).toBe('open');
    expect(state?.messages.at(-1)).toMatchObject({ from: 'caller (chair)', text: 'Mind the budget.', round: 2 });
  });

  it('continue: runs more rounds, delivers the chair message, returns only the new turns', async () => {
    await seedRoom(1);
    await parleyRoom.handler({ action: 'say', room: 'r1', message: 'Mind the budget.', rounds: 1 }, fakeCtx());
    const mock = scriptedDriver();
    _setClaudeDriverForTesting(mock);
    const out = await parleyRoom.handler({ action: 'continue', room: 'r1', rounds: 1 }, fakeCtx());
    expect(mock.invocations).toHaveLength(2);
    for (const call of mock.invocations) {
      expect(call.prompt).toContain('round 2 of 2');
      expect(call.prompt).toContain('**caller (chair):** Mind the budget.');
    }
    expect(out).toContain('[room r1 · open · round 2]');
    expect(out).not.toContain('### Round 1');
    expect(out).toContain('**a:** a r2');
    expect(out).toContain('1 round(s) run');
    expect((await readRoom(PROJ, 'r1'))?.round).toBe(2);
  });

  it('continue: reports convergence', async () => {
    await seedRoom(1);
    _setClaudeDriverForTesting(scriptedDriver(2));
    const out = await parleyRoom.handler({ action: 'continue', room: 'r1', rounds: 3 }, fakeCtx());
    expect(out).toContain('room converged');
    expect((await readRoom(PROJ, 'r1'))?.status).toBe('converged');
  });

  it('close: marks the room closed; say and continue then refuse, log and list still work', async () => {
    await seedRoom(1);
    const out = await parleyRoom.handler({ action: 'close', room: 'r1', rounds: 1 }, fakeCtx());
    expect(out).toMatch(/closed/);
    expect((await readRoom(PROJ, 'r1'))?.status).toBe('closed');
    await expect(
      parleyRoom.handler({ action: 'say', room: 'r1', message: 'x', rounds: 1 }, fakeCtx()),
    ).rejects.toThrow(/closed/);
    await expect(
      parleyRoom.handler({ action: 'continue', room: 'r1', rounds: 1 }, fakeCtx()),
    ).rejects.toThrow(/closed/);
    expect(await parleyRoom.handler({ action: 'log', room: 'r1', rounds: 1 }, fakeCtx())).toContain('# Room: r1');
    expect(await parleyRoom.handler({ action: 'list', rounds: 1 }, fakeCtx())).toMatch(/^r1  closed/);
  });

  it('gather refuses to reuse a closed room name', async () => {
    await seedRoom(1);
    await parleyRoom.handler({ action: 'close', room: 'r1', rounds: 1 }, fakeCtx());
    _setClaudeDriverForTesting(scriptedDriver());
    await expect(
      parleyGather.handler({ grounders: [], projectAccess: true, peers: ['a', 'b'], question: 'q', room: 'r1', rounds: 1 }, fakeCtx()),
    ).rejects.toThrow(/already exists/);
  });
});
