import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  walkForPointer,
  resolveSession,
} from '../../src/registry/session-resolver.js';
import { paths } from '../../src/registry/paths.js';
import { setup } from '../helpers/tmpdir.js';

const SID = 'sxyz12';

async function writeManifest(parleyDir: string, sid: string, projectPath: string) {
  const dir = join(parleyDir, 'sessions', sid);
  await mkdir(join(dir, 'inbox'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      sessionId: sid,
      claudeSessionId: null,
      projectPath,
      projectName: 'p',
      alias: 'p',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'registered',
      pid: 0,
    }),
  );
}

async function writePointer(projectPath: string, sid: string) {
  await mkdir(join(projectPath, '.claude'), { recursive: true });
  await writeFile(join(projectPath, '.claude', 'parley-session'), sid);
}

describe('walkForPointer', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('finds a pointer at the starting directory', async () => {
    const proj = join(t.tmp.root, 'project');
    await writeManifest(t.tmp.root, SID, proj);
    await writePointer(proj, SID);
    expect(walkForPointer(proj)).toBe(SID);
  });

  it('walks up the tree to find a pointer in an ancestor', async () => {
    const proj = join(t.tmp.root, 'project');
    const sub = join(proj, 'a', 'b', 'c');
    await mkdir(sub, { recursive: true });
    await writeManifest(t.tmp.root, SID, proj);
    await writePointer(proj, SID);
    expect(walkForPointer(sub)).toBe(SID);
  });

  it('returns null when no pointer is found before /', () => {
    expect(walkForPointer(t.tmp.root)).toBeNull();
  });

  it('skips a pointer whose manifest is missing', async () => {
    const proj = join(t.tmp.root, 'project');
    await writePointer(proj, 'orphan-sid');
    expect(walkForPointer(proj)).toBeNull();
  });
});

describe('resolveSession', () => {
  const t = setup();
  let prevSid: string | undefined;
  beforeEach(async () => {
    await t.before();
    prevSid = process.env.PARLEY_SESSION_ID;
    delete process.env.PARLEY_SESSION_ID;
  });
  afterEach(async () => {
    if (prevSid === undefined) delete process.env.PARLEY_SESSION_ID;
    else process.env.PARLEY_SESSION_ID = prevSid;
    await t.after();
  });

  it('uses the env var when manifest exists', async () => {
    await writeManifest(t.tmp.root, SID, '/abs/proj');
    const r = resolveSession({ envSid: SID, cwd: '/abs/proj', ppid: 1 });
    expect(r).toEqual({ sid: SID, via: 'env' });
  });

  it('skips env when manifest missing, falls through to other strategies', async () => {
    const proj = join(t.tmp.root, 'project');
    await writeManifest(t.tmp.root, SID, proj);
    await writePointer(proj, SID);
    const r = resolveSession({ envSid: 'bogus', cwd: proj, ppid: 1 });
    expect(r?.sid).toBe(SID);
    expect(r?.via).toBe('cwd-walk');
  });

  it('returns null when nothing matches', () => {
    const r = resolveSession({ envSid: null, cwd: t.tmp.root, ppid: 1 });
    expect(r).toBeNull();
  });
});
