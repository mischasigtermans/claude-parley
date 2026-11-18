import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, utimes } from 'node:fs/promises';
import { paths, type ProjectId } from './paths.js';
import { atomicWriteJSON, LockTimeoutError, withLock } from './locks.js';
import { isErrnoException } from '../util/errors.js';

export interface HeadlessRecord {
  projectId: ProjectId;
  alias: string;
  claudeSessionId: string;
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  /**
   * `live` when `claudeSessionId` names the listener that answered last.
   * `headless` when it names a conversation from before threads, which the
   * sweep adopts as a thread. A headless turn leaves both fields as they are.
   */
  origin?: 'live' | 'headless';
  /**
   * High-water mark: the turnCount at the last parley_remember. A peer is
   * "dirty" (has undistilled conversation) when turnCount > rememberedTurn.
   */
  rememberedTurn?: number;
  /**
   * Set once the conversation `claudeSessionId` named from before threads was
   * dealt with: adopted as a thread, or too old to adopt. Such a record is
   * never adopted again, also after that thread expired. A later turn moves
   * `lastUsedAt` but not the session, so the age check can't be repeated.
   */
  adopted?: boolean;
}

export function isHeadlessRecord(v: unknown): v is HeadlessRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<HeadlessRecord>;
  return (
    typeof r.projectId === 'string' &&
    typeof r.alias === 'string' &&
    typeof r.claudeSessionId === 'string' &&
    typeof r.cwd === 'string' &&
    typeof r.createdAt === 'string' &&
    typeof r.lastUsedAt === 'string' &&
    typeof r.turnCount === 'number'
  );
}

export async function readHeadless(
  projectId: ProjectId,
  alias: string,
): Promise<HeadlessRecord | null> {
  try {
    const raw = await readFile(paths.headlessFor(projectId, alias), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isHeadlessRecord(parsed) ? parsed : null;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeHeadless(record: HeadlessRecord): Promise<void> {
  await atomicWriteJSON(paths.headlessFor(record.projectId, record.alias), record);
}

/** One conversation with a peer. An ask without a thread starts a new one. */
export interface ThreadRecord {
  thread: string;
  claudeSessionId: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
}

const THREAD_ID = /^[a-z0-9]{6}$/;

export function newThreadId(): string {
  return randomBytes(6).reduce((id, byte) => id + (byte % 36).toString(36), '');
}

export async function readThread(
  projectId: ProjectId,
  alias: string,
  thread: string,
): Promise<ThreadRecord | null> {
  if (!THREAD_ID.test(thread)) return null;
  try {
    return JSON.parse(await readFile(paths.threadFor(projectId, alias, thread), 'utf8')) as ThreadRecord;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeThread(projectId: ProjectId, alias: string, record: ThreadRecord): Promise<void> {
  await atomicWriteJSON(paths.threadFor(projectId, alias, record.thread), record);
}

/**
 * 0.6.0 holds the per-peer lock for file writes only. A 0.5.0 server holds it
 * for a whole spawn, often minutes, so waiting longer than this gains nothing.
 */
const PEER_LOCK_WAIT_MS = 2_000;

/**
 * Run bookkeeping under the per-peer lock, or skip it and return undefined
 * when another process keeps that lock past PEER_LOCK_WAIT_MS.
 */
export async function withPeerLockOrSkip<T>(
  projectId: ProjectId,
  alias: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await withLock(paths.headlessLockFor(projectId, alias), fn, { timeoutMs: PEER_LOCK_WAIT_MS });
  } catch (err) {
    if (!(err instanceof LockTimeoutError)) throw err;
    process.stderr.write(
      `parley: per-peer lock for "${alias}" in project ${projectId} is held by another process, skipped its bookkeeping\n`,
    );
    return undefined;
  }
}

const ADOPT_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A per-peer record written before threads names the session that holds its
 * conversation. Write that session as a thread, so an ask can continue it by
 * id, and mark the record so it is adopted once. The id derives from the
 * session. Returns the id of a thread it adopts. Call under the per-peer lock.
 */
export async function adoptConversation(
  projectId: ProjectId,
  alias: string,
  opts: { dryRun?: boolean } = {},
): Promise<string | null> {
  const record = await readHeadless(projectId, alias).catch(() => null);
  if (!record?.claudeSessionId || record.origin === 'live' || record.adopted) return null;
  const lastUsed = new Date(record.lastUsedAt);
  if (!(Date.now() - lastUsed.getTime() <= ADOPT_WITHIN_MS)) {
    if (!opts.dryRun) await writeHeadless({ ...record, adopted: true });
    return null;
  }
  const thread = createHash('sha1').update(record.claudeSessionId).digest('hex').slice(0, 6);
  const existing = await readThread(projectId, alias, thread).catch(() => undefined);
  if (existing === undefined) return null;
  const exists = existing !== null;
  if (opts.dryRun) return exists ? null : thread;
  if (!exists) {
    await writeThread(projectId, alias, {
      thread,
      claudeSessionId: record.claudeSessionId,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      turnCount: record.turnCount,
    });
    await utimes(paths.threadFor(projectId, alias, thread), lastUsed, lastUsed);
  }
  await writeHeadless({ ...record, adopted: true });
  return exists ? null : thread;
}

/** This project's threads with a peer, most recently used first. */
export async function listThreads(projectId: ProjectId, alias: string): Promise<ThreadRecord[]> {
  let files: string[];
  try {
    files = await readdir(paths.threadsDirFor(projectId, alias));
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    throw err;
  }
  const threads: ThreadRecord[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const record = await readThread(projectId, alias, file.slice(0, -'.json'.length)).catch(() => null);
    if (typeof record?.lastUsedAt === 'string' && typeof record.turnCount === 'number') threads.push(record);
  }
  return threads.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}
