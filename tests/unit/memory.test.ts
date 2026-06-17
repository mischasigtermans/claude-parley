import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { appendMemoryBullets, readMemory, clearMemory } from '../../src/registry/memory.js';
import { paths, type ProjectId } from '../../src/registry/paths.js';
import { setup } from '../helpers/tmpdir.js';

describe('memory', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  const PROJ = 'proj1234abcd' as ProjectId;

  it('returns empty string when no memory exists', async () => {
    expect(await readMemory(PROJ, 'taylor')).toBe('');
  });

  it('creates the file on first append and reports added count', async () => {
    const stats = await appendMemoryBullets(PROJ, 'taylor', '- uses snake_case\n- prefers thin controllers');
    expect(stats).toEqual({ added: 2, deduped: 0 });
    const mem = await readMemory(PROJ, 'taylor');
    expect(mem).toContain('- uses snake_case');
    expect(mem).toContain('- prefers thin controllers');
  });

  it('dedupes identical bullets on a second call', async () => {
    await appendMemoryBullets(PROJ, 'taylor', '- uses snake_case');
    const stats = await appendMemoryBullets(PROJ, 'taylor', '- uses snake_case\n- new fact');
    expect(stats).toEqual({ added: 1, deduped: 1 });
    const lines = (await readMemory(PROJ, 'taylor')).split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
  });

  it('treats bullets differing only by case or trailing >60 chars as duplicates', async () => {
    const long = '- this is a fairly long bullet that exceeds the sixty character key boundary AAA';
    await appendMemoryBullets(PROJ, 'taylor', long);
    const variant = '- THIS IS A FAIRLY LONG BULLET THAT EXCEEDS THE SIXTY CHARACTER key boundary ZZZ';
    const stats = await appendMemoryBullets(PROJ, 'taylor', variant);
    expect(stats.added).toBe(0);
    expect(stats.deduped).toBe(1);
  });

  it('ignores non-bullet lines in the input', async () => {
    const stats = await appendMemoryBullets(PROJ, 'taylor', 'preamble\n- real one\nrandom prose');
    expect(stats.added).toBe(1);
    const mem = await readMemory(PROJ, 'taylor');
    expect(mem).not.toContain('preamble');
    expect(mem).not.toContain('random prose');
  });

  it('clearMemory removes the file, returning true then false', async () => {
    await appendMemoryBullets(PROJ, 'taylor', '- something');
    expect(await clearMemory(PROJ, 'taylor')).toBe(true);
    expect(await clearMemory(PROJ, 'taylor')).toBe(false);
    expect(await readMemory(PROJ, 'taylor')).toBe('');
  });

  it('isolates memory per (project, alias)', async () => {
    const PROJ_B = 'bbbbbbbbbbbb' as ProjectId;
    await appendMemoryBullets(PROJ, 'taylor', '- a-fact');
    await appendMemoryBullets(PROJ_B, 'taylor', '- b-fact');
    await appendMemoryBullets(PROJ, 'steve', '- steve-fact');

    expect(await readMemory(PROJ, 'taylor')).toContain('a-fact');
    expect(await readMemory(PROJ, 'taylor')).not.toContain('b-fact');
    expect(await readMemory(PROJ_B, 'taylor')).toContain('b-fact');
    expect(await readMemory(PROJ, 'steve')).toContain('steve-fact');
    expect(await readMemory(PROJ, 'steve')).not.toContain('a-fact');
  });

  it('stores at memory/<projectId>/<alias>.md', async () => {
    await appendMemoryBullets(PROJ, 'taylor', '- located');
    const onDisk = await readFile(paths.memoryFor(PROJ, 'taylor'), 'utf8');
    expect(onDisk).toContain('- located');
  });
});
