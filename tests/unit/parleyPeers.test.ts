import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { parleyPeers } from '../../src/tools/parleyPeers.js';
import { writePeers } from '../../src/registry/peers.js';
import { readHeadless, writeHeadless, writeThread } from '../../src/registry/headless.js';
import { touchLastClean } from '../../src/registry/state.js';
import { writeFile } from 'node:fs/promises';
import { paths } from '../../src/registry/paths.js';
import { holdForeignLock } from '../helpers/foreign-lock.js';
import type { ParleyContext } from '../../src/context.js';
import type { ProjectId } from '../../src/registry/paths.js';
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

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe('parley_peers', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it("lists this project's three most recent threads with more than one turn", async () => {
    await writePeers({ peers: { advisor: { path: '/abs/advisor' } } });
    await writeHeadless({
      projectId: PROJ,
      alias: 'advisor',
      claudeSessionId: '',
      cwd: '/abs/advisor',
      createdAt: daysAgo(9),
      lastUsedAt: daysAgo(0),
      turnCount: 70,
    });
    const threads: [string, number, number][] = [
      ['k3x9qa', 56, 1],
      ['b71d37', 3, 2],
      ['single', 1, 0],
      ['c4d5e6', 4, 3],
      ['oldest', 6, 4],
    ];
    for (const [thread, turnCount, age] of threads) {
      await writeThread(PROJ, 'advisor', {
        thread,
        claudeSessionId: `sid-${thread}`,
        createdAt: daysAgo(age),
        lastUsedAt: daysAgo(age),
        turnCount,
      });
    }

    const out = await parleyPeers.handler({}, fakeCtx());

    const row = out.split('\n').find((l) => l.startsWith('| advisor |'))!;
    expect(row).toContain('threads: k3x9qa (56 turns), b71d37 (3 turns), c4d5e6 (4 turns)');
    expect(row).not.toContain('single');
    expect(row).not.toContain('oldest');
    expect(row).toContain('70 to distill');
  });

  it('adopts and lists a multi-turn 0.5.0 conversation before any sweep has run', async () => {
    await touchLastClean();
    await writePeers({ peers: { advisor: { path: '/abs/advisor' } } });
    await writeHeadless({
      projectId: PROJ,
      alias: 'advisor',
      claudeSessionId: 'sid-050',
      cwd: '/abs/advisor',
      createdAt: daysAgo(9),
      lastUsedAt: daysAgo(1),
      turnCount: 44,
      origin: 'headless',
    });
    const id = createHash('sha1').update('sid-050').digest('hex').slice(0, 6);

    const out = await parleyPeers.handler({}, fakeCtx());

    expect(out).toContain(`threads: ${id} (44 turns)`);
    expect((await readHeadless(PROJ, 'advisor'))?.adopted).toBe(true);
  });

  it('returns its table while another process holds a peer lock', async () => {
    await touchLastClean();
    await writePeers({ peers: { advisor: { path: '/abs/advisor' } } });
    await writeHeadless({
      projectId: PROJ,
      alias: 'advisor',
      claudeSessionId: 'sid-050',
      cwd: '/abs/advisor',
      createdAt: daysAgo(9),
      lastUsedAt: daysAgo(1),
      turnCount: 44,
      origin: 'headless',
    });
    await holdForeignLock(paths.headlessLockFor(PROJ, 'advisor'));

    const started = Date.now();
    const out = await parleyPeers.handler({}, fakeCtx());

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out).toMatch(/^\| advisor \| project \|/m);
  }, 40_000);

  it('skips a thread file it cannot read', async () => {
    await writePeers({ peers: { advisor: { path: '/abs/advisor' } } });
    await writeThread(PROJ, 'advisor', {
      thread: 'k3x9qa',
      claudeSessionId: 'sid',
      createdAt: daysAgo(0),
      lastUsedAt: daysAgo(0),
      turnCount: 3,
    });
    await writeFile(paths.threadFor(PROJ, 'advisor', 'broken'), '{ not json');

    const out = await parleyPeers.handler({}, fakeCtx());

    expect(out).toContain('threads: k3x9qa (3 turns)');
  });

  it('shows no threads note when every thread has one turn', async () => {
    await writePeers({ peers: { advisor: { path: '/abs/advisor' } } });
    await writeThread(PROJ, 'advisor', {
      thread: 'single',
      claudeSessionId: 'sid',
      createdAt: daysAgo(0),
      lastUsedAt: daysAgo(0),
      turnCount: 1,
    });

    const out = await parleyPeers.handler({}, fakeCtx());

    expect(out).not.toContain('threads:');
  });
});
