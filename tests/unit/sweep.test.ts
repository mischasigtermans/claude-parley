import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { sweep } from '../../src/cleanup/sweep.js';
import { writeManifest, readManifest, listLiveSessions, type SessionManifest } from '../../src/registry/sessions.js';
import { readState } from '../../src/registry/state.js';
import { holdForeignLock } from '../helpers/foreign-lock.js';
import {
  readHeadless,
  writeHeadless,
  writeThread,
  readThread,
  type HeadlessRecord,
  type ThreadRecord,
} from '../../src/registry/headless.js';
import { writePeers } from '../../src/registry/peers.js';
import { paths, type ProjectId } from '../../src/registry/paths.js';
import { setup } from '../helpers/tmpdir.js';

function thread(id: string): ThreadRecord {
  const now = new Date().toISOString();
  return { thread: id, claudeSessionId: `sid-${id}`, createdAt: now, lastUsedAt: now, turnCount: 1 };
}

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
    const PROJ_A = 'aaaaaaaaaaaa' as ProjectId;
    const PROJ_B = 'bbbbbbbbbbbb' as ProjectId;
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
    expect(result.removed.headless).toContain(`${PROJ_A}/orphan`);
    expect(result.removed.headless).toContain(`${PROJ_B}/orphan`);
    expect(result.removed.headless).not.toContain(`${PROJ_A}/keeper`);
    expect(result.removed.headless).not.toContain(`${PROJ_B}/keeper`);
  });

  it('removes the threads of an alias that is no longer a peer', async () => {
    const PROJ = 'dddddddddddd' as ProjectId;
    await writePeers({ peers: { keeper: { path: process.cwd() } } });
    await writeThread(PROJ, 'keeper', thread('aaaaaa'));
    await writeThread(PROJ, 'orphan', thread('bbbbbb'));

    const result = await sweep();

    expect(result.removed.threads).toEqual([`${PROJ}/orphan/bbbbbb`]);
    expect(await readThread(PROJ, 'keeper', 'aaaaaa')).not.toBeNull();
    expect(await readThread(PROJ, 'orphan', 'bbbbbb')).toBeNull();
  });

  it('removes threads unused for 30 days and keeps recent ones', async () => {
    const PROJ = 'eeeeeeeeeeee' as ProjectId;
    await writePeers({ peers: { keeper: { path: process.cwd() } } });
    await writeThread(PROJ, 'keeper', thread('recent'));
    await writeThread(PROJ, 'keeper', thread('oldone'));
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await utimes(paths.threadFor(PROJ, 'keeper', 'oldone'), old, old);

    const preview = await sweep({ dryRun: true });
    expect(preview.removed.threads).toEqual([`${PROJ}/keeper/oldone`]);
    expect(await readThread(PROJ, 'keeper', 'oldone')).not.toBeNull();

    const result = await sweep();

    expect(result.removed.threads).toEqual([`${PROJ}/keeper/oldone`]);
    expect(await readThread(PROJ, 'keeper', 'recent')).not.toBeNull();
    expect(await readThread(PROJ, 'keeper', 'oldone')).toBeNull();
  });

  describe('adopting a 0.5.0 conversation', () => {
    const PROJ = 'ffffffffffff' as ProjectId;
    const ID = createHash('sha1').update('sid-050').digest('hex').slice(0, 6);
    const record = (overrides: Partial<HeadlessRecord> = {}): HeadlessRecord => ({
      projectId: PROJ,
      alias: 'keeper',
      claudeSessionId: 'sid-050',
      cwd: process.cwd(),
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      turnCount: 44,
      origin: 'headless',
      ...overrides,
    });
    beforeEach(() => writePeers({ peers: { keeper: { path: process.cwd() } } }));

    it('turns the session a per-peer record names into a thread, once', async () => {
      const rec = record();
      await writeHeadless(rec);

      const first = await sweep();

      expect(first.adopted).toEqual([`${PROJ}/keeper/${ID}`]);
      expect(await readThread(PROJ, 'keeper', ID)).toEqual({
        thread: ID,
        claudeSessionId: 'sid-050',
        createdAt: rec.createdAt,
        lastUsedAt: rec.lastUsedAt,
        turnCount: 44,
      });
      const mtime = (await stat(paths.threadFor(PROJ, 'keeper', ID))).mtimeMs;
      expect(Math.round(mtime)).toBe(new Date(rec.lastUsedAt).getTime());
      expect(await readHeadless(PROJ, 'keeper')).toEqual({ ...rec, adopted: true });

      const second = await sweep();
      expect(second.adopted).toEqual([]);
      expect((await stat(paths.threadFor(PROJ, 'keeper', ID))).mtimeMs).toBe(mtime);
    });

    it('never adopts a record twice, also after its thread is gone', async () => {
      await writeHeadless(record());
      await sweep();
      await rm(paths.threadFor(PROJ, 'keeper', ID));

      const second = await sweep();

      expect(second.adopted).toEqual([]);
      expect(await readThread(PROJ, 'keeper', ID)).toBeNull();
      expect((await readHeadless(PROJ, 'keeper'))?.adopted).toBe(true);
    });

    it('skips a record unused for 30 days, a live one, and one that names no session', async () => {
      await writeHeadless(record({ lastUsedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() }));
      expect((await sweep()).adopted).toEqual([]);
      await writeHeadless(record({ origin: 'live' }));
      expect((await sweep()).adopted).toEqual([]);
      await writeHeadless(record({ claudeSessionId: '' }));
      expect((await sweep()).adopted).toEqual([]);
      expect(await readThread(PROJ, 'keeper', ID)).toBeNull();
    });

    it('completes and reports the rest while another process holds a peer lock', async () => {
      await writeHeadless(record());
      await writeHeadless(record({ alias: 'orphan' }));
      await holdForeignLock(paths.headlessLockFor(PROJ, 'keeper'));

      const started = Date.now();
      const result = await sweep();

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.adopted).toEqual([]);
      expect(result.removed.headless).toEqual([`${PROJ}/orphan`]);
      expect((await readHeadless(PROJ, 'keeper'))?.adopted).toBeUndefined();
    }, 40_000);

    it('lets the auto-sweep stamp its last clean while another process holds a peer lock', async () => {
      await writeHeadless(record());
      await holdForeignLock(paths.headlessLockFor(PROJ, 'keeper'));

      await listLiveSessions();

      expect((await readState()).lastCleanAt).toBeTruthy();
    }, 40_000);

    it('a record too old to adopt is marked, so a later sweep leaves it alone', async () => {
      await writeHeadless(record({ lastUsedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() }));
      await sweep();
      expect((await readHeadless(PROJ, 'keeper'))?.adopted).toBe(true);
    });

    it('a dry run leaves a record too old to adopt unmarked', async () => {
      await writeHeadless(record({ lastUsedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() }));
      await sweep({ dryRun: true });
      expect((await readHeadless(PROJ, 'keeper'))?.adopted).toBeUndefined();
    });

    it('an unreadable thread file at the adopted id leaves the sweep running and the record unadopted', async () => {
      await writeHeadless(record());
      await writeHeadless(record({ alias: 'orphan' }));
      await mkdir(paths.threadsDirFor(PROJ, 'keeper'), { recursive: true });
      await writeFile(paths.threadFor(PROJ, 'keeper', ID), '{ not json');

      const result = await sweep();

      expect(result.adopted).toEqual([]);
      expect(result.removed.headless).toEqual([`${PROJ}/orphan`]);
      expect((await readHeadless(PROJ, 'keeper'))?.adopted).toBeUndefined();
    });

    it('a dry run reports the adoption without writing it', async () => {
      await writeHeadless(record());
      expect((await sweep({ dryRun: true })).adopted).toEqual([`${PROJ}/keeper/${ID}`]);
      expect(await readThread(PROJ, 'keeper', ID)).toBeNull();
      expect((await readHeadless(PROJ, 'keeper'))?.adopted).toBeUndefined();
    });
  });

  it('keeps headless caches for extension-provided peers (e.g. personas)', async () => {
    const PROJ = 'cccccccccccc' as ProjectId;
    await mkdir(paths.extensionsDir, { recursive: true });
    await writeFile(
      join(paths.extensionsDir, 'personas.json'),
      JSON.stringify({
        name: 'personas',
        peers: [{ alias: 'steve-jobs', path: process.cwd() }],
      }),
    );
    await writeHeadless({
      projectId: PROJ,
      alias: 'steve-jobs',
      claudeSessionId: 'x',
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 2,
    });
    const result = await sweep();
    expect(result.removed.headless).not.toContain(`${PROJ}/steve-jobs`);
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
    expect(second.removed.projectDirs).toEqual([]);
  });

  it('reports removed headless as projectId/alias for cross-project precision', async () => {
    const PROJ_A = 'aaaaaaaaaaaa' as ProjectId;
    await writePeers({ peers: { keeper: { path: process.cwd() } } });
    await writeHeadless({
      projectId: PROJ_A,
      alias: 'gone',
      claudeSessionId: 'x',
      cwd: '/nope',
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 1,
    });
    const result = await sweep();
    expect(result.removed.headless).toContain(`${PROJ_A}/gone`);
  });

  it('removes empty project subdirectories under headless/ and logs/', async () => {
    const PROJ = 'aaaaaaaaaaaa' as ProjectId;
    await mkdir(join(t.tmp.root, 'headless', PROJ), { recursive: true });
    await mkdir(join(t.tmp.root, 'logs', PROJ), { recursive: true });
    const result = await sweep();
    expect(result.removed.projectDirs).toContain(`headless/${PROJ}`);
    expect(result.removed.projectDirs).toContain(`logs/${PROJ}`);
  });

  it('removes extension manifests whose peer paths are all gone', async () => {
    await mkdir(join(t.tmp.root, 'extensions'), { recursive: true });
    await writeFile(
      join(t.tmp.root, 'extensions', 'stale.json'),
      JSON.stringify({ name: 'stale', peers: [{ alias: 'x', path: '/totally/missing/' + Math.random() }] }),
    );
    await writeFile(
      join(t.tmp.root, 'extensions', 'live.json'),
      JSON.stringify({ name: 'live', peers: [{ alias: 'y', path: process.cwd() }] }),
    );
    const result = await sweep();
    expect(result.removed.extensions).toContain('stale.json');
    expect(result.removed.extensions).not.toContain('live.json');
  });

});
