import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isErrnoException } from '../util/errors.js';

export class LockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`parley: timed out acquiring lock at ${lockPath}`);
  }
}

export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if (!isErrnoException(err) || err.code !== 'EEXIST') throw err;
      if (await tryReclaimStaleLock(lockPath)) continue;
      if (Date.now() > deadline) throw new LockTimeoutError(lockPath);
      await sleep(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

/**
 * Read the PID held in the lock file. If the holder is genuinely dead (kill -0
 * throws because the PID isn't running), unlink the file so the next acquire
 * can succeed. Returns true if a stale lock was cleared and the caller should
 * retry the acquire immediately.
 *
 * If the PID matches our own, we treat it as a live holder (legitimate
 * same-process contention). The crashed-self case is rare and falls back to
 * the normal timeout path; manual cleanup is preferable to wrongly stealing
 * a lock from another in-flight call within the same Node process.
 */
async function tryReclaimStaleLock(lockPath: string): Promise<boolean> {
  let pid: number;
  try {
    const contents = (await readFile(lockPath, 'utf8')).trim();
    pid = parseInt(contents, 10);
    // Corrupt lock contents (e.g. mid-write crash). Treat as live: the
    // timeout path will surface the issue rather than risk false-stealing.
    if (!Number.isFinite(pid) || pid <= 0) return false;
  } catch {
    return false;
  }
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    await unlink(lockPath).catch(() => {});
    return true;
  }
}

export async function atomicWriteJSON(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
