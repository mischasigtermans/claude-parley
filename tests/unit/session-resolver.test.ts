import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveSession } from '../../src/registry/session-resolver.js';
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
    const r = resolveSession({ envSid: SID, ppid: 1 });
    expect(r).toEqual({ sid: SID, via: 'env' });
  });

  it('returns null when env points at a missing manifest and no other strategy applies', async () => {
    const r = resolveSession({ envSid: 'bogus', ppid: 1 });
    expect(r).toBeNull();
  });

  it('returns null when nothing matches', () => {
    const r = resolveSession({ envSid: null, ppid: 1 });
    expect(r).toBeNull();
  });
});
