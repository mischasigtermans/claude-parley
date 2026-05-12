import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import {
  readHeadless,
  writeHeadless,
  clearHeadless,
  HeadlessRecord,
} from '../../src/registry/headless.js';
import { setup } from '../helpers/tmpdir.js';

const PROJ = 'proj1234abcd';

function recordFor(overrides: Partial<HeadlessRecord> = {}): HeadlessRecord {
  return {
    projectId: PROJ,
    alias: 'lawyer',
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
    expect(await readHeadless(PROJ, 'lawyer')).toBeNull();
  });

  it('round-trips a record', async () => {
    const rec = recordFor();
    await writeHeadless(rec);
    expect(await readHeadless(PROJ, 'lawyer')).toEqual(rec);
  });

  it('clearHeadless deletes the record and is idempotent', async () => {
    await writeHeadless(recordFor());
    expect(await clearHeadless(PROJ, 'lawyer')).toBe(true);
    expect(await readHeadless(PROJ, 'lawyer')).toBeNull();
    expect(await clearHeadless(PROJ, 'lawyer')).toBe(false);
  });

  it('keeps separate records per alias within the same project', async () => {
    await writeHeadless(recordFor({ alias: 'lawyer', claudeSessionId: 'a' }));
    await writeHeadless(recordFor({ alias: 'onoma', claudeSessionId: 'b' }));
    expect((await readHeadless(PROJ, 'lawyer'))?.claudeSessionId).toBe('a');
    expect((await readHeadless(PROJ, 'onoma'))?.claudeSessionId).toBe('b');
  });

  it('keeps separate records per project for the same alias', async () => {
    const PROJ_A = 'aaaaaaaaaaaa';
    const PROJ_B = 'bbbbbbbbbbbb';
    await writeHeadless(recordFor({ projectId: PROJ_A, claudeSessionId: 'sa' }));
    await writeHeadless(recordFor({ projectId: PROJ_B, claudeSessionId: 'sb' }));
    expect((await readHeadless(PROJ_A, 'lawyer'))?.claudeSessionId).toBe('sa');
    expect((await readHeadless(PROJ_B, 'lawyer'))?.claudeSessionId).toBe('sb');
  });

  it('clearHeadless only affects the matching project', async () => {
    const PROJ_A = 'aaaaaaaaaaaa';
    const PROJ_B = 'bbbbbbbbbbbb';
    await writeHeadless(recordFor({ projectId: PROJ_A }));
    await writeHeadless(recordFor({ projectId: PROJ_B }));
    expect(await clearHeadless(PROJ_A, 'lawyer')).toBe(true);
    expect(await readHeadless(PROJ_A, 'lawyer')).toBeNull();
    expect(await readHeadless(PROJ_B, 'lawyer')).not.toBeNull();
  });
});
