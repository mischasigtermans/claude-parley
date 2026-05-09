import { readFile } from 'node:fs/promises';
import { paths } from './paths.js';
import { atomicWriteJSON } from './locks.js';
import { isErrnoException } from '../util/errors.js';

export interface ParleyState {
  lastCleanAt?: string;
}

export async function readState(): Promise<ParleyState> {
  let raw: string;
  try {
    raw = await readFile(paths.stateFile, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const lastCleanAt = typeof parsed.lastCleanAt === 'string' ? parsed.lastCleanAt : undefined;
    return { lastCleanAt };
  } catch {
    return {};
  }
}

export async function writeState(state: ParleyState): Promise<void> {
  await atomicWriteJSON(paths.stateFile, state);
}

export async function touchLastClean(now: Date = new Date()): Promise<void> {
  const state = await readState();
  state.lastCleanAt = now.toISOString();
  await writeState(state);
}
