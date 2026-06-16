import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readExtensions } from '../../src/registry/extensions.js';
import { paths } from '../../src/registry/paths.js';
import { setup } from '../helpers/tmpdir.js';

describe('extensions', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('returns empty when extensions dir is missing', async () => {
    expect(await readExtensions()).toEqual([]);
  });

  it('reads a single manifest', async () => {
    await mkdir(paths.extensionsDir, { recursive: true });
    await writeFile(
      join(paths.extensionsDir, 'personas.json'),
      JSON.stringify({
        name: 'personas',
        version: '0.1.0',
        peers: [
          { alias: 'steve', path: '/abs/steve', description: 'Steve Jobs' },
          { alias: 'raymond', path: '/abs/raymond' },
        ],
      }),
    );
    const peers = await readExtensions();
    expect(peers).toHaveLength(2);
    expect(peers[0].alias).toBe('steve');
    expect(peers[0].extension).toBe('personas');
    expect(peers[0].description).toBe('Steve Jobs');
    expect(peers[1].alias).toBe('raymond');
    expect(peers[1].description).toBeUndefined();
  });

  it('skips malformed manifests silently', async () => {
    await mkdir(paths.extensionsDir, { recursive: true });
    await writeFile(join(paths.extensionsDir, 'broken.json'), '{ not json');
    await writeFile(
      join(paths.extensionsDir, 'good.json'),
      JSON.stringify({ name: 'good', peers: [{ alias: 'a', path: '/abs/a' }] }),
    );
    const peers = await readExtensions();
    expect(peers).toHaveLength(1);
    expect(peers[0].extension).toBe('good');
  });

  it('skips entries missing alias or path', async () => {
    await mkdir(paths.extensionsDir, { recursive: true });
    await writeFile(
      join(paths.extensionsDir, 'partial.json'),
      JSON.stringify({
        name: 'partial',
        peers: [
          { alias: 'ok', path: '/abs/ok' },
          { alias: 'missing-path' },
          { path: '/abs/missing-alias' },
          {},
        ],
      }),
    );
    const peers = await readExtensions();
    expect(peers).toHaveLength(1);
    expect(peers[0].alias).toBe('ok');
  });

  it('skips entries whose alias would escape the parley state dir', async () => {
    await mkdir(paths.extensionsDir, { recursive: true });
    await writeFile(
      join(paths.extensionsDir, 'evil.json'),
      JSON.stringify({
        name: 'evil',
        peers: [
          { alias: '../escape', path: '/abs/escape' },
          { alias: 'good', path: '/abs/good' },
          { alias: 'with/slash', path: '/abs/slash' },
          { alias: '.hidden', path: '/abs/hidden' },
        ],
      }),
    );
    const peers = await readExtensions();
    expect(peers.map((p) => p.alias)).toEqual(['good']);
  });

  it('defaults extension name to filename when missing', async () => {
    await mkdir(paths.extensionsDir, { recursive: true });
    await writeFile(
      join(paths.extensionsDir, 'unnamed.json'),
      JSON.stringify({ peers: [{ alias: 'a', path: '/abs/a' }] }),
    );
    const peers = await readExtensions();
    expect(peers[0].extension).toBe('unnamed');
  });
});
