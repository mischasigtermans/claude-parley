import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from '../helpers/tmpdir.js';

const SID = 'ctxsid';

async function writeManifest(parleyDir: string, sid: string, projectPath: string) {
  await mkdir(join(parleyDir, 'sessions', sid, 'inbox'), { recursive: true });
  await writeFile(
    join(parleyDir, 'sessions', sid, 'manifest.json'),
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

describe('makeContext / session resolution', () => {
  const t = setup();
  let prevSessionId: string | undefined;
  beforeEach(async () => {
    await t.before();
    prevSessionId = process.env.PARLEY_SESSION_ID;
    delete process.env.PARLEY_SESSION_ID;
  });
  afterEach(async () => {
    if (prevSessionId === undefined) delete process.env.PARLEY_SESSION_ID;
    else process.env.PARLEY_SESSION_ID = prevSessionId;
    await t.after();
  });

  it('uses PARLEY_SESSION_ID when the env var is set and the manifest exists', async () => {
    await writeManifest(t.tmp.root, SID, '/abs/proj');
    process.env.PARLEY_SESSION_ID = SID;

    // Cache-busting query string forces vitest to re-import with the new env state.
    const mod = await import('../../src/context.js?case=env-var-' + Date.now());
    const ctx = mod.makeContext();
    expect(ctx.getCurrentSessionId()).toBe(SID);
  });

  it('returns null when no manifest matches and no env var is set', async () => {
    // No manifest, no env var, cwd unlikely to match anything.
    const mod = await import('../../src/context.js?case=null-' + Date.now());
    const ctx = mod.makeContext();
    expect(ctx.getCurrentSessionId()).toBeNull();
  });
});
