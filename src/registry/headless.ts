import { readFile, unlink } from 'node:fs/promises';
import { paths } from './paths.js';
import { atomicWriteJSON } from './locks.js';
import { isErrnoException } from '../util/errors.js';

export interface HeadlessRecord {
  projectId: string;
  alias: string;
  claudeSessionId: string;
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
}

export async function readHeadless(
  projectId: string,
  alias: string,
): Promise<HeadlessRecord | null> {
  try {
    const raw = await readFile(paths.headlessFor(projectId, alias), 'utf8');
    return JSON.parse(raw) as HeadlessRecord;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeHeadless(record: HeadlessRecord): Promise<void> {
  await atomicWriteJSON(paths.headlessFor(record.projectId, record.alias), record);
}

export async function clearHeadless(projectId: string, alias: string): Promise<boolean> {
  try {
    await unlink(paths.headlessFor(projectId, alias));
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}
