import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths, type ProjectId } from './paths.js';
import { withLock } from './locks.js';
import { isErrnoException } from '../util/errors.js';

/**
 * Durable per-(project, peer) memory. A flat list of `- bullet` lines the asker
 * distills from past conversations and that parley prepends to future headless
 * prompts. Keyed by the peer's canonical alias so all of a peer's aliases share
 * one file.
 */

function memoryKey(line: string): string {
  return line.replace(/^- /, '').toLowerCase().slice(0, 60);
}

function bulletLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => /^- /.test(l));
}

export async function readMemory(projectId: ProjectId, alias: string): Promise<string> {
  try {
    return await readFile(paths.memoryFor(projectId, alias), 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return '';
    throw err;
  }
}

export async function appendMemoryBullets(
  projectId: ProjectId,
  alias: string,
  bulletsText: string,
): Promise<{ added: number; deduped: number }> {
  const incoming = bulletLines(bulletsText);
  if (incoming.length === 0) return { added: 0, deduped: 0 };

  return withLock(paths.memoryLockFor(projectId, alias), async () => {
    const existing = await readMemory(projectId, alias);
    const keys = new Set(bulletLines(existing).map(memoryKey));
    const toAppend: string[] = [];
    let deduped = 0;
    for (const bullet of incoming) {
      const key = memoryKey(bullet);
      if (keys.has(key)) {
        deduped++;
        continue;
      }
      keys.add(key);
      toAppend.push(bullet);
    }
    if (toAppend.length > 0) {
      const file = paths.memoryFor(projectId, alias);
      await mkdir(dirname(file), { recursive: true });
      const base = existing.replace(/\n*$/, '');
      const next = (base.length > 0 ? base + '\n' : '') + toAppend.join('\n') + '\n';
      await writeFile(file, next, 'utf8');
    }
    return { added: toAppend.length, deduped };
  });
}

export async function clearMemory(projectId: ProjectId, alias: string): Promise<boolean> {
  try {
    await unlink(paths.memoryFor(projectId, alias));
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}
