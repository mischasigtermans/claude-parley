import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { access, chmod, readFile, writeFile } from 'node:fs/promises';
import { configPath, readParleyConfig } from '../../src/config.js';
import { setup } from '../helpers/tmpdir.js';

describe('readParleyConfig', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('returns defaults when config.json is missing and no legacy toml present', async () => {
    const c = await readParleyConfig();
    expect(c.fallback).toBe('headless');
    expect(c.skipDefault).toBe(true);
  });

  it('migrates a well-formed legacy config.toml and deletes the source', async () => {
    const tomlPath = configPath().replace(/\.json$/, '.toml');
    await writeFile(
      tomlPath,
      '[runtime]\nfallback = "ask"\n\n[permissions]\nskip_default = false\n',
    );
    const c = await readParleyConfig();
    expect(c).toEqual({ fallback: 'ask', skipDefault: false, memory: { default: true, peers: {} } });
    await expect(access(tomlPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const json = JSON.parse(await readFile(configPath(), 'utf8'));
    expect(json).toEqual({
      runtime: { fallback: 'ask' },
      permissions: { skip_default: false },
      memory: { default: true, peers: {} },
    });
  });

  it('preserves a malformed legacy config.toml instead of deleting it', async () => {
    const tomlPath = configPath().replace(/\.json$/, '.toml');
    await writeFile(tomlPath, 'this is not toml or anything parseable\n');
    const c = await readParleyConfig();
    expect(c.fallback).toBe('headless');
    expect(c.skipDefault).toBe(true);
    const tomlContent = await readFile(tomlPath, 'utf8');
    expect(tomlContent).toBe('this is not toml or anything parseable\n');
    await expect(access(configPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rethrows non-ENOENT errors when reading config.json', async () => {
    if (process.getuid?.() === 0) return;
    await writeFile(configPath(), '{}');
    await chmod(configPath(), 0o000);
    try {
      await expect(readParleyConfig()).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(configPath(), 0o644);
    }
  });
});
