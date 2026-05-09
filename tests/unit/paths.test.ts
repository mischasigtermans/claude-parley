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

  it('builds headless and log paths correctly', () => {
    expect(paths.headlessFor('lawyer')).toBe(join(t.tmp.root, 'headless', 'lawyer.json'));
    expect(paths.logFor('lawyer')).toBe(join(t.tmp.root, 'logs', 'lawyer.md'));
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
