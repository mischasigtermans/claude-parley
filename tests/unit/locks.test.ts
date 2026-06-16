import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withLock, atomicWriteJSON, LockTimeoutError } from '../../src/registry/locks.js';
import { setup } from '../helpers/tmpdir.js';

describe('atomicWriteJSON', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('writes JSON to the target path', async () => {
    const target = join(t.tmp.root, 'data.json');
    await atomicWriteJSON(target, { hello: 'world' });
    const raw = await readFile(target, 'utf8');
    expect(JSON.parse(raw)).toEqual({ hello: 'world' });
  });

  it('creates parent dirs as needed', async () => {
    const target = join(t.tmp.root, 'nested', 'deep', 'data.json');
    await atomicWriteJSON(target, [1, 2, 3]);
    const raw = await readFile(target, 'utf8');
    expect(JSON.parse(raw)).toEqual([1, 2, 3]);
  });
});

describe('withLock', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('serializes concurrent callers', async () => {
    const lock = join(t.tmp.root, 'shared.lock');
    const order: string[] = [];

    await Promise.all([
      withLock(lock, async () => {
        order.push('a-start');
        await sleep(50);
        order.push('a-end');
      }),
      withLock(lock, async () => {
        order.push('b-start');
        await sleep(10);
        order.push('b-end');
      }),
    ]);

    // Either a-start...a-end...b-start...b-end OR b-start...b-end...a-start...a-end.
    // Critical property: the two are not interleaved.
    const aIdx = order.indexOf('a-start');
    const bIdx = order.indexOf('b-start');
    if (aIdx < bIdx) {
      expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    } else {
      expect(order).toEqual(['b-start', 'b-end', 'a-start', 'a-end']);
    }
  });

  it('throws LockTimeoutError when the lock cannot be acquired in time', async () => {
    const lock = join(t.tmp.root, 'busy.lock');
    let release: (() => void) | null = null;
    const holding = withLock(lock, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    await sleep(20);
    await expect(
      withLock(lock, async () => 'should-not-run', { timeoutMs: 100, pollMs: 10 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    release!();
    await holding;
  });

  it('releases the lock when the callback throws', async () => {
    const lock = join(t.tmp.root, 'release.lock');
    await mkdir(t.tmp.root, { recursive: true });

    await expect(
      withLock(lock, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Must be re-acquirable immediately afterwards.
    const result = await withLock(lock, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('reclaims a stale lock left by a dead PID', async () => {
    const lock = join(t.tmp.root, 'stale.lock');
    await mkdir(t.tmp.root, { recursive: true });
    // Pick a PID extremely unlikely to be live.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(lock, '999999', { flag: 'w' });

    // Should reclaim almost immediately (no 30s wait), call fn, return its result.
    const start = Date.now();
    const result = await withLock(lock, async () => 'reclaimed', { timeoutMs: 2000, pollMs: 20 });
    expect(result).toBe('reclaimed');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('does not reclaim a lock held by our own (live) PID: same-process contention is honored', async () => {
    const lock = join(t.tmp.root, 'self.lock');
    await mkdir(t.tmp.root, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(lock, String(process.pid), { flag: 'w' });

    await expect(
      withLock(lock, async () => 'should-not-run', { timeoutMs: 200, pollMs: 20 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it('does not reclaim a lock held by a live process', async () => {
    const lock = join(t.tmp.root, 'live.lock');
    await mkdir(t.tmp.root, { recursive: true });
    // The current process is definitely alive, but using our own pid would trigger
    // self-reclaim. Use the parent process's PID, which exists for the duration of
    // this test run (vitest runner).
    const livePid = process.ppid;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(lock, String(livePid), { flag: 'w' });

    await expect(
      withLock(lock, async () => 'should-not-run', { timeoutMs: 200, pollMs: 20 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
