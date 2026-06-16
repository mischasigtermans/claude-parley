import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths, expandHome } from '../../src/registry/paths.js';
import { setup } from '../helpers/tmpdir.js';

describe('paths', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('honors PARLEY_DIR env var', () => {
    expect(paths.root).toBe(t.tmp.root);
    expect(paths.peersFile).toBe(join(t.tmp.root, 'peers.json'));
    expect(paths.sessionsDir).toBe(join(t.tmp.root, 'sessions'));
  });

  it('builds session paths correctly', () => {
    const sid = 'abc123';
    expect(paths.sessionDir(sid)).toBe(join(t.tmp.root, 'sessions', sid));
    expect(paths.sessionManifest(sid)).toBe(join(t.tmp.root, 'sessions', sid, 'manifest.json'));
    expect(paths.sessionInbox(sid)).toBe(join(t.tmp.root, 'sessions', sid, 'inbox'));
  });

  it('builds project-scoped headless, log, and lock paths correctly', () => {
    const proj = 'proj1234abcd';
    expect(paths.headlessFor(proj, 'peer-a')).toBe(
      join(t.tmp.root, 'headless', proj, 'peer-a.json'),
    );
    expect(paths.logFor(proj, 'peer-a')).toBe(join(t.tmp.root, 'logs', proj, 'peer-a.md'));
    expect(paths.headlessLockFor(proj, 'peer-a')).toBe(
      join(t.tmp.root, 'locks', `${proj}-peer-a.lock`),
    );
    expect(paths.headlessProjectDir(proj)).toBe(join(t.tmp.root, 'headless', proj));
    expect(paths.logsProjectDir(proj)).toBe(join(t.tmp.root, 'logs', proj));
  });

  it('projectId is deterministic and 12 chars', async () => {
    const id1 = await paths.projectId('/some/cwd/that/has/no/git');
    const id2 = await paths.projectId('/some/cwd/that/has/no/git');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{12}$/);
  });

  it('projectId differs across cwds without git', async () => {
    const a = await paths.projectId('/a/cwd');
    const b = await paths.projectId('/b/cwd');
    expect(a).not.toBe(b);
  });

  it('builds Claude-PID sentinel paths', () => {
    expect(paths.byClaudePid(1234)).toBe(join(t.tmp.root, 'by-claude-pid', '1234.session'));
    expect(paths.byClaudePid('5678')).toBe(join(t.tmp.root, 'by-claude-pid', '5678.session'));
  });
});

describe('expandHome', () => {
  it('expands ~ to homedir', () => {
    expect(expandHome('~/foo')).toBe(join(homedir(), 'foo'));
  });

  it('leaves absolute paths alone', () => {
    expect(expandHome('/abs/path')).toBe('/abs/path');
  });

  it('resolves relative paths', () => {
    expect(expandHome('relative')).toBe(join(process.cwd(), 'relative'));
  });
});
