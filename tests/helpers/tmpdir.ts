import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ParleyTmp {
  root: string;
  cleanup: () => Promise<void>;
  setEnv: () => void;
  restoreEnv: () => void;
}

export async function makeParleyTmp(prefix = 'parley-test-'): Promise<ParleyTmp> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const prevDir = process.env.PARLEY_DIR;
  let envApplied = false;

  return {
    root,
    setEnv() {
      process.env.PARLEY_DIR = root;
      envApplied = true;
    },
    restoreEnv() {
      if (!envApplied) return;
      if (prevDir === undefined) delete process.env.PARLEY_DIR;
      else process.env.PARLEY_DIR = prevDir;
      envApplied = false;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Convenience wrapper for vitest-style usage:
 *
 *   const t = setup();
 *   beforeEach(t.before);
 *   afterEach(t.after);
 *   ...
 *   t.tmp.root  // current tmpdir
 */
export function setup(prefix?: string) {
  let current: ParleyTmp | null = null;
  return {
    get tmp(): ParleyTmp {
      if (!current) throw new Error('tmpdir not initialised — did you call before()?');
      return current;
    },
    async before() {
      current = await makeParleyTmp(prefix);
      current.setEnv();
    },
    async after() {
      if (!current) return;
      current.restoreEnv();
      await current.cleanup();
      current = null;
    },
  };
}
