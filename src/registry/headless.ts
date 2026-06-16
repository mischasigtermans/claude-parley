import { readFile, unlink } from 'node:fs/promises';
import { paths, type ProjectId } from './paths.js';
import { atomicWriteJSON } from './locks.js';
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
   * Which transport last wrote this record. The cache now doubles as a session
   * pointer per (asker, peer): live tier writes the listener's session id;
   * headless tier writes the spawn's session id. Either path can resume via
   * --resume <claudeSessionId>.
   */
  origin?: 'live' | 'headless';
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

export async function clearHeadless(projectId: ProjectId, alias: string): Promise<boolean> {
  try {
    await unlink(paths.headlessFor(projectId, alias));
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}
