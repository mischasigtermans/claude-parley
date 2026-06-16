import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import {
  readHeadless,
  writeHeadless,
  clearHeadless,
  HeadlessRecord,
} from '../../src/registry/headless.js';
import type { ProjectId } from '../../src/registry/paths.js';
import { setup } from '../helpers/tmpdir.js';

const PROJ = 'proj1234abcd' as ProjectId;

function recordFor(overrides: Partial<HeadlessRecord> = {}): HeadlessRecord {
  return {
    projectId: PROJ,
    alias: 'peer-a',
    claudeSessionId: 'uuid-1',
    cwd: '/abs/proj',
    createdAt: '2026-01-01T00:00:00Z',
    lastUsedAt: '2026-01-01T00:00:00Z',
    turnCount: 1,
    ...overrides,
  };
}

describe('headless cache', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('reads null for missing aliases', async () => {
    expect(await readHeadless(PROJ, 'peer-a')).toBeNull();
  });

  it('round-trips a record', async () => {
    const rec = recordFor();
    await writeHeadless(rec);
    expect(await readHeadless(PROJ, 'peer-a')).toEqual(rec);
  });

  it('clearHeadless deletes the record and is idempotent', async () => {
    await writeHeadless(recordFor());
    expect(await clearHeadless(PROJ, 'peer-a')).toBe(true);
    expect(await readHeadless(PROJ, 'peer-a')).toBeNull();
    expect(await clearHeadless(PROJ, 'peer-a')).toBe(false);
  });

  it('keeps separate records per alias within the same project', async () => {
    await writeHeadless(recordFor({ alias: 'peer-a', claudeSessionId: 'a' }));
    await writeHeadless(recordFor({ alias: 'peer-b', claudeSessionId: 'b' }));
    expect((await readHeadless(PROJ, 'peer-a'))?.claudeSessionId).toBe('a');
    expect((await readHeadless(PROJ, 'peer-b'))?.claudeSessionId).toBe('b');
  });

  it('keeps separate records per project for the same alias', async () => {
    const PROJ_A = 'aaaaaaaaaaaa' as ProjectId;
    const PROJ_B = 'bbbbbbbbbbbb' as ProjectId;
    await writeHeadless(recordFor({ projectId: PROJ_A, claudeSessionId: 'sa' }));
    await writeHeadless(recordFor({ projectId: PROJ_B, claudeSessionId: 'sb' }));
    expect((await readHeadless(PROJ_A, 'peer-a'))?.claudeSessionId).toBe('sa');
    expect((await readHeadless(PROJ_B, 'peer-a'))?.claudeSessionId).toBe('sb');
  });

  it('clearHeadless only affects the matching project', async () => {
    const PROJ_A = 'aaaaaaaaaaaa' as ProjectId;
    const PROJ_B = 'bbbbbbbbbbbb' as ProjectId;
    await writeHeadless(recordFor({ projectId: PROJ_A }));
    await writeHeadless(recordFor({ projectId: PROJ_B }));
    expect(await clearHeadless(PROJ_A, 'peer-a')).toBe(true);
    expect(await readHeadless(PROJ_A, 'peer-a')).toBeNull();
    expect(await readHeadless(PROJ_B, 'peer-a')).not.toBeNull();
  });
});
