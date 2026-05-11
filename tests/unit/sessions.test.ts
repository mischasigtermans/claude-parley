import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  readManifest,
  writeManifest,
  touchHeartbeat,
  setStatus,
  listSessions,
  listLiveSessions,
  SessionManifest,
} from '../../src/registry/sessions.js';
import { paths } from '../../src/registry/paths.js';
import { setup } from '../helpers/tmpdir.js';

function manifestFor(overrides: Partial<SessionManifest> = {}): SessionManifest {
  const now = new Date().toISOString();
  return {
    sessionId: overrides.sessionId ?? 'abc123',
    claudeSessionId: overrides.claudeSessionId ?? null,
    projectPath: overrides.projectPath ?? '/abs/proj',
    projectName: overrides.projectName ?? 'proj',
    alias: overrides.alias ?? 'proj',
    startedAt: overrides.startedAt ?? now,
    lastHeartbeat: overrides.lastHeartbeat ?? now,
    status: overrides.status ?? 'registered',
    pid: overrides.pid ?? 1234,
  };
}

describe('sessions registry', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('writes and reads a manifest', async () => {
    const manifest = manifestFor({ sessionId: 'sid1' });
    await writeManifest(manifest);
    const read = await readManifest('sid1');
    expect(read).toEqual(manifest);
  });

  it('readManifest returns null for missing sessions', async () => {
    expect(await readManifest('missing')).toBeNull();
  });

  it('touchHeartbeat updates lastHeartbeat without changing status', async () => {
    const m = manifestFor({ sessionId: 'sid2', lastHeartbeat: '2020-01-01T00:00:00Z' });
    await writeManifest(m);
    await touchHeartbeat('sid2');
    const after = await readManifest('sid2');
    expect(after!.status).toBe(m.status);
    expect(after!.lastHeartbeat).not.toBe('2020-01-01T00:00:00Z');
  });

  it('setStatus flips the status field', async () => {
    await writeManifest(manifestFor({ sessionId: 'sid3' }));
    await setStatus('sid3', 'listening');
    const after = await readManifest('sid3');
    expect(after!.status).toBe('listening');
  });

  it('listSessions returns all manifests on disk', async () => {
    await writeManifest(manifestFor({ sessionId: 'a' }));
    await writeManifest(manifestFor({ sessionId: 'b' }));
    const all = await listSessions();
    const ids = all.map((s) => s.sessionId).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('listLiveSessions filters out stale heartbeats (> 5 min)', async () => {
    const fresh = manifestFor({ sessionId: 'fresh' });
    const stale = manifestFor({
      sessionId: 'stale',
      lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    await writeManifest(fresh);
    await writeManifest(stale);
    const live = await listLiveSessions();
    expect(live.map((s) => s.sessionId)).toEqual(['fresh']);
  });

  it('listSessions is a pure read; pruning is sweep.ts territory', async () => {
    const dead = manifestFor({
      sessionId: 'dead',
      pid: 999_999,
      lastHeartbeat: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    await writeManifest(dead);
    const all = await listSessions();
    expect(all.map((s) => s.sessionId)).toContain('dead');
    expect(await readManifest('dead')).not.toBeNull();
  });

  it('readManifest returns null when lastHeartbeat is unparseable', async () => {
    const manifestPath = paths.sessionManifest('garbage');
    await mkdir(dirname(manifestPath), { recursive: true });
    const m = manifestFor({ sessionId: 'garbage' });
    await writeFile(manifestPath, JSON.stringify({ ...m, lastHeartbeat: 'not-a-date' }));
    expect(await readManifest('garbage')).toBeNull();
  });

  it('readManifest returns null on malformed JSON', async () => {
    const manifestPath = paths.sessionManifest('broken');
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, '{ not json');
    expect(await readManifest('broken')).toBeNull();
  });
});
