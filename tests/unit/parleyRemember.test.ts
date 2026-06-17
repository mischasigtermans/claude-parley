import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { parleyRemember } from '../../src/tools/parleyRemember.js';
import { readMemory } from '../../src/registry/memory.js';
import { writePeers } from '../../src/registry/peers.js';
import { writeHeadless, readHeadless } from '../../src/registry/headless.js';
import { writeParleyConfig } from '../../src/config.js';
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

describe('parley_remember', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('stores bullets and advances rememberedTurn to turnCount', async () => {
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    await writeHeadless({
      projectId: PROJ,
      alias: 'peer1',
      claudeSessionId: 'sid',
      cwd: '/abs/peer1',
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 4,
    });

    const out = await parleyRemember.handler(
      { peer: 'peer1', bullets: '- fact one\n- fact two' },
      fakeCtx(),
    );
    expect(out).toContain('Remembered 2 new bullet');
    expect(await readMemory(PROJ, 'peer1')).toContain('- fact one');

    const rec = await readHeadless(PROJ, 'peer1');
    expect(rec?.rememberedTurn).toBe(4);
  });

  it('dedupes on a second call', async () => {
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    await parleyRemember.handler({ peer: 'peer1', bullets: '- shared' }, fakeCtx());
    const out = await parleyRemember.handler(
      { peer: 'peer1', bullets: '- shared\n- fresh' },
      fakeCtx(),
    );
    expect(out).toContain('1 new bullet');
    expect(out).toContain('1 duplicate');
  });

  it('no-ops with a message when memory is disabled for the peer', async () => {
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    await writeParleyConfig({ memory: { default: true, peers: { peer1: false } } });

    const out = await parleyRemember.handler(
      { peer: 'peer1', bullets: '- ignored' },
      fakeCtx(),
    );
    expect(out).toMatch(/Memory is off/);
    expect(await readMemory(PROJ, 'peer1')).toBe('');
  });
});
