import { execFileSync, ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from './paths.js';
import { isErrnoException } from '../util/errors.js';

export type ResolveVia =
  | 'env'
  | 'pid-sentinel'
  | 'parent-cwd-walk'
  | 'cwd-walk';

export interface ResolveResult {
  sid: string;
  via: ResolveVia;
}

export interface ResolveInput {
  /** Override for the cwd to walk from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override for the parent process PID. Defaults to `process.ppid`. */
  ppid?: number;
  /** Override for the env var. Defaults to `process.env.PARLEY_SESSION_ID`. */
  envSid?: string | null;
}

const EXEC_TIMEOUT_MS = 1000;

/** Top-level resolver: walks all known strategies and returns the first hit. */
export function resolveSession(input: ResolveInput = {}): ResolveResult | null {
  const cwd = input.cwd ?? process.cwd();
  const ppid = input.ppid ?? process.ppid;
  const envSid = input.envSid ?? process.env.PARLEY_SESSION_ID ?? null;

  if (envSid && existsSync(paths.sessionManifest(envSid))) {
    return { sid: envSid, via: 'env' };
  }

  const fromSentinel = readPidSentinel(ppid);
  if (fromSentinel) return { sid: fromSentinel, via: 'pid-sentinel' };

  // parent-cwd-walk runs first because the MCP's own cwd is unreliable
  // (Claude Code typically spawns MCP children at $HOME or /, which would
  // poach onto a home-dir pointer). The parent claude CLI's cwd is the
  // user's actual project directory.
  const ppCwd = parentCwd(ppid);
  if (ppCwd) {
    const fromParent = walkForPointer(ppCwd);
    if (fromParent) return { sid: fromParent, via: 'parent-cwd-walk' };
  }

  const fromCwd = walkForPointer(cwd);
  if (fromCwd) return { sid: fromCwd, via: 'cwd-walk' };

  return null;
}

export function walkForPointer(start: string): string | null {
  let dir = start;
  while (true) {
    const pointer = join(dir, '.claude', 'parley-session');
    if (existsSync(pointer)) {
      const sid = readFileSync(pointer, 'utf8').trim();
      if (sid && existsSync(paths.sessionManifest(sid))) return sid;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function parentCwd(ppid: number): string | null {
  if (!ppid || ppid <= 1) return null;
  const out = bestEffortExec('lsof', ['-p', String(ppid), '-d', 'cwd', '-F', 'n']);
  if (!out) return null;
  // lsof -F n emits multiple lines; the cwd line starts with 'n'. Take the last.
  const lines = out.split('\n').filter((l) => l.startsWith('n'));
  if (lines.length === 0) return null;
  return lines[lines.length - 1].slice(1) || null;
}

function findClaudePid(startPid: number): number | null {
  let pid = startPid;
  for (let i = 0; i < 15; i++) {
    if (!pid || pid <= 1) return null;
    const comm = bestEffortExec('ps', ['-p', String(pid), '-o', 'comm=']);
    const leaf = comm?.trim().split('/').pop() ?? '';
    if (/claude/i.test(leaf)) return pid;
    const ppidRaw = bestEffortExec('ps', ['-p', String(pid), '-o', 'ppid=']);
    if (!ppidRaw) return null;
    const next = parseInt(ppidRaw.trim(), 10);
    if (!Number.isFinite(next) || next === pid) return null;
    pid = next;
  }
  return null;
}

function readPidSentinel(startPid: number): string | null {
  const claudePid = findClaudePid(startPid);
  if (!claudePid) return null;
  const sentinel = paths.byClaudePid(claudePid);
  if (!existsSync(sentinel)) return null;
  try {
    const sid = readFileSync(sentinel, 'utf8').trim();
    if (sid && existsSync(paths.sessionManifest(sid))) return sid;
  } catch (err) {
    if (!(isErrnoException(err) && err.code === 'ENOENT')) throw err;
  }
  return null;
}

/**
 * Run a child process synchronously with a hard timeout, swallowing all errors.
 * Returns null on timeout, non-zero exit, missing binary, or any other failure.
 * Uses execFileSync (not execSync) so args are passed without shell interpretation.
 */
function bestEffortExec(file: string, args: string[]): string | null {
  const opts: ExecSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  try {
    return execFileSync(file, args, opts);
  } catch {
    return null;
  }
}
