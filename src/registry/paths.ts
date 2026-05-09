import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function parleyDir(): string {
  return process.env.PARLEY_DIR ?? join(homedir(), '.claude', 'parley');
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
  sessionInboxRead: (sid: string) => join(parleyDir(), 'sessions', sid, 'inbox', 'read'),
  sessionOutbox: (sid: string) => join(parleyDir(), 'sessions', sid, 'outbox'),
  headlessFor: (alias: string) => join(parleyDir(), 'headless', `${alias}.json`),
  headlessLockFor: (alias: string) => join(parleyDir(), 'locks', `${alias}.lock`),
  logFor: (alias: string) => join(parleyDir(), 'logs', `${alias}.md`),
} as const;

export function expandHome(path: string): string {
  if (path.startsWith('~')) {
    return resolve(homedir() + path.slice(1));
  }
  return resolve(path);
}
