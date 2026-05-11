import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  readPeers,
  writePeers,
  upsertPeer,
  removePeer,
  findPeer,
  resolvePeerConfigFromFile,
  assertValidAlias,
  InvalidAliasError,
} from '../../src/registry/peers.js';
import { paths } from '../../src/registry/paths.js';
import { setup } from '../helpers/tmpdir.js';

describe('peers registry', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('returns empty when peers.json is missing', async () => {
    const file = await readPeers();
    expect(file.peers).toEqual({});
  });

  it('upsertPeer persists to peers.json', async () => {
    await upsertPeer('lawyer', { path: '/abs/lawyer' });
    const raw = await readFile(paths.peersFile, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.peers.lawyer.path).toBe('/abs/lawyer');
    expect(parsed.peers.lawyer.skipPermissions).toBe(true);
  });

  it('upsertPeer expands ~ to home', async () => {
    await upsertPeer('foo', { path: '~/Documents/foo' });
    const file = await readPeers();
    expect(file.peers.foo.path).toMatch(/Documents\/foo$/);
    expect(file.peers.foo.path.startsWith('/')).toBe(true);
  });

  it('removePeer returns true when peer existed, false otherwise', async () => {
    await upsertPeer('temp', { path: '/abs/temp' });
    expect(await removePeer('temp')).toBe(true);
    expect(await removePeer('temp')).toBe(false);
  });

  it('findPeer matches by alias or by absolute path', async () => {
    await upsertPeer('alpha', { path: '/abs/alpha' });
    expect(await findPeer('alpha')).toMatchObject({ alias: 'alpha' });
    expect(await findPeer('/abs/alpha')).toMatchObject({ alias: 'alpha' });
    expect(await findPeer('nope')).toBeNull();
  });

  it('resolvePeerConfigFromFile inherits from defaults', async () => {
    await mkdir(paths.root, { recursive: true });
    await writeFile(
      paths.peersFile,
      JSON.stringify({
        defaults: { model: 'sonnet', mcpServers: {}, skipPermissions: false },
        peers: {
          lawyer: { path: '/abs/lawyer', agent: 'claude' },
        },
      }),
    );
    const resolved = resolvePeerConfigFromFile('lawyer', await readPeers());
    expect(resolved).not.toBeNull();
    expect(resolved!.resolvedModel).toBe('sonnet');
    expect(resolved!.resolvedMcpServers).toEqual({});
    expect(resolved!.resolvedSkipPermissions).toBe(false);
  });

  it('resolvePeerConfigFromFile prefers per-peer overrides over defaults', async () => {
    await mkdir(paths.root, { recursive: true });
    await writeFile(
      paths.peersFile,
      JSON.stringify({
        defaults: { model: 'sonnet' },
        peers: {
          lawyer: { path: '/abs/lawyer', agent: 'claude', model: 'opus' },
        },
      }),
    );
    const resolved = resolvePeerConfigFromFile('lawyer', await readPeers());
    expect(resolved!.resolvedModel).toBe('opus');
  });

  it('writePeers preserves the defaults section', async () => {
    await writePeers({
      defaults: { model: 'haiku' },
      peers: { foo: { path: '/abs/foo', agent: 'claude' } },
    });
    const raw = await readFile(paths.peersFile, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.defaults.model).toBe('haiku');
    expect(parsed.peers.foo).toBeDefined();
  });
});

describe('assertValidAlias / alias path-traversal protection', () => {
  it('accepts simple aliases', () => {
    for (const ok of ['a', 'lawyer', 'onoma', 'stagent', 'foo_bar', 'foo-bar', 'a1', '_dev']) {
      // Underscore-leading is rejected; exclude that case
      if (/^[a-zA-Z0-9]/.test(ok)) {
        expect(() => assertValidAlias(ok)).not.toThrow();
      }
    }
  });

  it('rejects path traversal attempts', () => {
    for (const evil of ['../evil', '..', '.', '/abs/path', './foo', 'foo/bar', '\\backslash', 'foo\x00bar']) {
      expect(() => assertValidAlias(evil)).toThrowError(InvalidAliasError);
    }
  });

  it('rejects empty and whitespace', () => {
    for (const bad of ['', ' ', '\t', '   ', '\n']) {
      expect(() => assertValidAlias(bad)).toThrowError(InvalidAliasError);
    }
  });

  it('rejects names that start with non-alphanumeric', () => {
    for (const bad of ['_leading-underscore', '-leading-hyphen', '.hidden']) {
      expect(() => assertValidAlias(bad)).toThrowError(InvalidAliasError);
    }
  });

  it('rejects aliases longer than 64 chars', () => {
    expect(() => assertValidAlias('a'.repeat(65))).toThrowError(InvalidAliasError);
    expect(() => assertValidAlias('a'.repeat(64))).not.toThrow();
  });

  describe('upsertPeer enforces validation (defense in depth)', () => {
    const t = setup();
    beforeEach(t.before);
    afterEach(t.after);

    it('rejects evil aliases at the registry boundary', async () => {
      await expect(upsertPeer('../evil', { path: '/abs/foo' })).rejects.toThrowError(InvalidAliasError);
      await expect(upsertPeer('foo/bar', { path: '/abs/foo' })).rejects.toThrowError(InvalidAliasError);
    });
  });
});
