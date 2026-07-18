import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scanParleySessions, dedupeByPath } from '../../src/discovery/projects.js';
import { writeManifest, SessionManifest } from '../../src/registry/sessions.js';
import { setup } from '../helpers/tmpdir.js';

function manifestFor(overrides: Partial<SessionManifest>): SessionManifest {
  const now = new Date().toISOString();
  return {
    sessionId: overrides.sessionId ?? 'abc123',
    claudeSessionId: null,
    projectPath: overrides.projectPath ?? '/abs/proj',
    projectName: overrides.projectName ?? 'proj',
    alias: overrides.alias ?? 'proj',
    startedAt: overrides.startedAt ?? now,
    lastHeartbeat: overrides.lastHeartbeat ?? now,
    status: 'registered',
    pid: 1234,
  };
}

describe('scanParleySessions', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('returns projects from session manifests', async () => {
    const project = join(t.tmp.root, 'proj-a');
    await mkdir(project);
    await writeManifest(manifestFor({ sessionId: 'sa', projectPath: project }));
    const found = await scanParleySessions();
    expect(found.map((p) => p.path)).toEqual([project]);
  });

  it('skips ephemeral Cowork output dirs', async () => {
    const cowork = join(t.tmp.root, 'local-agent-mode-sessions', 'local_x', 'outputs');
    await mkdir(cowork, { recursive: true });
    await writeManifest(manifestFor({ sessionId: 'sb', projectPath: cowork }));
    expect(await scanParleySessions()).toEqual([]);
  });

  it('skips paths that no longer exist', async () => {
    await writeManifest(manifestFor({ sessionId: 'sc', projectPath: join(t.tmp.root, 'gone') }));
    expect(await scanParleySessions()).toEqual([]);
  });

  it('returns nothing when no sessions are registered', async () => {
    expect(await scanParleySessions()).toEqual([]);
  });

  it('uses lastHeartbeat as the last-used time', async () => {
    const project = join(t.tmp.root, 'proj-b');
    await mkdir(project);
    const beat = '2026-01-02T03:04:05.000Z';
    await writeManifest(manifestFor({ sessionId: 'sd', projectPath: project, lastHeartbeat: beat }));
    const [found] = await scanParleySessions();
    expect(found.lastUsedAt).toBe(beat);
    expect(found.lastUsedMs).toBe(new Date(beat).getTime());
  });
});

describe('dedupeByPath', () => {
  const at = (path: string, ms: number) => ({
    path,
    lastUsedMs: ms,
    lastUsedAt: new Date(ms).toISOString(),
  });

  it('keeps the newest entry per path', () => {
    const out = dedupeByPath([at('/a', 100), at('/a', 300), at('/a', 200)]);
    expect(out).toEqual([at('/a', 300)]);
  });

  it('preserves distinct paths', () => {
    const out = dedupeByPath([at('/a', 100), at('/b', 200)]);
    expect(out.map((p) => p.path).sort()).toEqual(['/a', '/b']);
  });

  it('handles an empty list', () => {
    expect(dedupeByPath([])).toEqual([]);
  });
});
