import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import {
  readHeadless,
  writeHeadless,
  clearHeadless,
  HeadlessRecord,
} from '../../src/registry/headless.js';
import { setup } from '../helpers/tmpdir.js';

function recordFor(overrides: Partial<HeadlessRecord> = {}): HeadlessRecord {
  return {
    alias: 'lawyer',
    claudeSessionId: 'uuid-1',
    agent: 'claude',
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
    expect(await readHeadless('lawyer')).toBeNull();
  });

  it('round-trips a record', async () => {
    const rec = recordFor();
    await writeHeadless(rec);
    expect(await readHeadless('lawyer')).toEqual(rec);
  });

  it('clearHeadless deletes the record and is idempotent', async () => {
    await writeHeadless(recordFor());
    expect(await clearHeadless('lawyer')).toBe(true);
    expect(await readHeadless('lawyer')).toBeNull();
    expect(await clearHeadless('lawyer')).toBe(false);
  });

  it('keeps separate records per alias', async () => {
    await writeHeadless(recordFor({ alias: 'lawyer', claudeSessionId: 'a' }));
    await writeHeadless(recordFor({ alias: 'onoma', claudeSessionId: 'b' }));
    expect((await readHeadless('lawyer'))?.claudeSessionId).toBe('a');
    expect((await readHeadless('onoma'))?.claudeSessionId).toBe('b');
  });
});
