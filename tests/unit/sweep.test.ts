import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sweep } from '../../src/cleanup/sweep.js';
import { writeManifest, readManifest, type SessionManifest } from '../../src/registry/sessions.js';
import { writeHeadless } from '../../src/registry/headless.js';
import { writePeers } from '../../src/registry/peers.js';
import { paths } from '../../src/registry/paths.js';
import { setup } from '../helpers/tmpdir.js';

function manifest(overrides: Partial<SessionManifest> = {}): SessionManifest {
  const now = new Date().toISOString();
  return {
    sessionId: 'sid',
    claudeSessionId: null,
    projectPath: overrides.projectPath ?? process.cwd(),
    projectName: 'proj',
    alias: 'proj',
    startedAt: now,
    lastHeartbeat: now,
    status: 'registered',
    pid: process.pid,
    ...overrides,
  };
}

const TWO_HOURS_AGO = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const THIRTY_SECONDS_AGO = () => new Date(Date.now() - 30_000).toISOString();

describe('sweep', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('removes session manifests with dead PID and >1h heartbeat', async () => {
    await writeManifest(manifest({ sessionId: 'gone', pid: 999_999, lastHeartbeat: TWO_HOURS_AGO() }));
    await writeManifest(manifest({ sessionId: 'alive', pid: process.pid }));
    const result = await sweep();
    expect(result.removed.sessions).toContain('gone');
    expect(result.removed.sessions).not.toContain('alive');
    expect(await readManifest('gone')).toBeNull();
    expect(await readManifest('alive')).not.toBeNull();
  });

  it('keeps dead-PID manifests when heartbeat is still recent', async () => {
    await writeManifest(manifest({ sessionId: 'recent', pid: 999_999, lastHeartbeat: THIRTY_SECONDS_AGO() }));
    const result = await sweep();
    expect(result.removed.sessions).not.toContain('recent');
    expect(await readManifest('recent')).not.toBeNull();
  });

  it('keeps alive-PID manifests even when heartbeat is old', async () => {
    await writeManifest(manifest({ sessionId: 'old-alive', pid: process.pid, lastHeartbeat: TWO_HOURS_AGO() }));
    const result = await sweep();
    expect(result.removed.sessions).not.toContain('old-alive');
  });

  it('removes session whose projectPath no longer exists', async () => {
    await writeManifest(manifest({
      sessionId: 'orphan',
      projectPath: '/nonexistent/path/' + Math.random(),
      pid: process.pid,
      lastHeartbeat: TWO_HOURS_AGO(),
    }));
    const result = await sweep();
    expect(result.removed.sessions).toContain('orphan');
  });

  it('removes by-claude-pid sentinels for dead PIDs', async () => {
    await mkdir(paths.byClaudePidDir, { recursive: true });
    await writeFile(join(paths.byClaudePidDir, '999999.session'), 'aaaaaa');
    await writeFile(join(paths.byClaudePidDir, `${process.pid}.session`), 'bbbbbb');
    const result = await sweep();
    expect(result.removed.sentinels).toContain('999999.session');
    expect(result.removed.sentinels).not.toContain(`${process.pid}.session`);
  });

  it('removes headless caches for aliases not in peers.json (across projects)', async () => {
    const PROJ_A = 'aaaaaaaaaaaa';
    const PROJ_B = 'bbbbbbbbbbbb';
    await writePeers({ peers: { keeper: { path: process.cwd() } } });
    await writeHeadless({
      projectId: PROJ_A,
      alias: 'keeper',
      claudeSessionId: 'x',
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 1,
    });
    await writeHeadless({
      projectId: PROJ_A,
      alias: 'orphan',
      claudeSessionId: 'y',
      cwd: '/nope',
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 1,
    });
    await writeHeadless({
      projectId: PROJ_B,
      alias: 'orphan',
      claudeSessionId: 'z',
      cwd: '/nope',
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 1,
    });
    const result = await sweep();
    expect(result.removed.headless).toContain('orphan');
    expect(result.removed.headless).not.toContain('keeper');
    expect(result.removed.headless.filter((a) => a === 'orphan')).toHaveLength(2);
  });

  it('flags peers.json entries with missing paths as advisories without removing them', async () => {
    const ghostPath = '/totally/missing/' + Math.random();
    await writePeers({ peers: { phantom: { path: ghostPath } } });
    const result = await sweep();
    expect(result.advisories.some((a) => a.includes('phantom'))).toBe(true);
  });

  it('dry-run does not modify state', async () => {
    await writeManifest(manifest({ sessionId: 'gone', pid: 999_999, lastHeartbeat: TWO_HOURS_AGO() }));
    await mkdir(paths.byClaudePidDir, { recursive: true });
    await writeFile(join(paths.byClaudePidDir, '999999.session'), 'x');

    const result = await sweep({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.removed.sessions).toContain('gone');
    expect(result.removed.sentinels).toContain('999999.session');
    expect(await readManifest('gone')).not.toBeNull();
    const sentinel = await readFile(join(paths.byClaudePidDir, '999999.session'), 'utf8');
    expect(sentinel).toBe('x');
  });

  it('is idempotent on a clean state', async () => {
    await writeManifest(manifest({ sessionId: 'alive', pid: process.pid }));
    await sweep();
    const second = await sweep();
    expect(second.removed.sessions).toEqual([]);
    expect(second.removed.sentinels).toEqual([]);
    expect(second.removed.headless).toEqual([]);
  });

});
