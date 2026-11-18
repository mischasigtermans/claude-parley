import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Hold a lock the way another live process does, such as a 0.5.0 server in
 * the middle of a spawn. The parent of the forked test worker is alive and
 * isn't this process, so withLock neither reclaims nor shares it.
 */
export async function holdForeignLock(lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, String(process.ppid));
}
