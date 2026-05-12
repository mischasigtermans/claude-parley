import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function parleyDir(): string {
  return process.env.PARLEY_DIR ?? join(homedir(), '.claude', 'parley');
}

/**
 * Branded type for project identity hashes. Prevents argument-order swaps
 * (e.g. `paths.headlessFor(alias, projectId)`) at compile time since plain
 * strings can't be passed where a ProjectId is required.
 */
export type ProjectId = string & { readonly _brand: 'ProjectId' };

async function gitRemote(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['config', '--get', 'remote.origin.url'], { cwd });
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export const paths = {
  get root() { return parleyDir(); },
  get peersFile() { return join(parleyDir(), 'peers.json'); },
  get stateFile() { return join(parleyDir(), 'state.json'); },
  get sessionsDir() { return join(parleyDir(), 'sessions'); },
  get headlessDir() { return join(parleyDir(), 'headless'); },
  get logsDir() { return join(parleyDir(), 'logs'); },
  get locksDir() { return join(parleyDir(), 'locks'); },
  get byClaudePidDir() { return join(parleyDir(), 'by-claude-pid'); },
  byClaudePid: (pid: number | string) => join(parleyDir(), 'by-claude-pid', `${pid}.session`),
  sessionDir: (sid: string) => join(parleyDir(), 'sessions', sid),
  sessionManifest: (sid: string) => join(parleyDir(), 'sessions', sid, 'manifest.json'),
  sessionInbox: (sid: string) => join(parleyDir(), 'sessions', sid, 'inbox'),
  sessionInboxInProgress: (sid: string) =>
    join(parleyDir(), 'sessions', sid, 'inbox', 'in-progress'),
  sessionInboxRead: (sid: string) => join(parleyDir(), 'sessions', sid, 'inbox', 'read'),
  sessionOutbox: (sid: string) => join(parleyDir(), 'sessions', sid, 'outbox'),
  headlessProjectDir: (projectId: ProjectId) => join(parleyDir(), 'headless', projectId),
  headlessFor: (projectId: ProjectId, alias: string) =>
    join(parleyDir(), 'headless', projectId, `${alias}.json`),
  headlessLockFor: (projectId: ProjectId, alias: string) =>
    join(parleyDir(), 'locks', `${projectId}-${alias}.lock`),
  logsProjectDir: (projectId: ProjectId) => join(parleyDir(), 'logs', projectId),
  logFor: (projectId: ProjectId, alias: string) =>
    join(parleyDir(), 'logs', projectId, `${alias}.md`),
  /**
   * Compute the project_id for a CWD. Matches the personas plugin algorithm:
   * SHA1 of git remote URL when available, fallback to SHA1 of CWD. First 12 hex chars.
   * Replicating identically lets parley and personas agree on what a 'project' is.
   */
  async projectId(cwd: string): Promise<ProjectId> {
    const remote = await gitRemote(cwd);
    const source = remote ?? cwd;
    return createHash('sha1').update(source).digest('hex').slice(0, 12) as ProjectId;
  },
} as const;

export function expandHome(path: string): string {
  if (path.startsWith('~')) {
    return resolve(homedir() + path.slice(1));
  }
  return resolve(path);
}
