import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { readState, writeState, touchLastClean } from '../../src/registry/state.js';
import { setup } from '../helpers/tmpdir.js';

describe('state registry', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('readState returns empty object when file is missing', async () => {
    expect(await readState()).toEqual({});
  });

  it('writeState round-trips via readState', async () => {
    await writeState({ lastCleanAt: '2026-01-01T00:00:00Z' });
    expect(await readState()).toEqual({ lastCleanAt: '2026-01-01T00:00:00Z' });
  });

  it('touchLastClean sets lastCleanAt to provided date', async () => {
    const ts = new Date('2026-05-09T12:00:00Z');
    await touchLastClean(ts);
    const state = await readState();
    expect(state.lastCleanAt).toBe(ts.toISOString());
  });

  it('touchLastClean preserves other fields', async () => {
    await writeState({ lastCleanAt: '2020-01-01T00:00:00Z' });
    const ts = new Date('2026-05-09T12:00:00Z');
    await touchLastClean(ts);
    expect((await readState()).lastCleanAt).toBe(ts.toISOString());
  });
});
