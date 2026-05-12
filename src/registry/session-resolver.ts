import { execFileSync, ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { paths } from './paths.js';
import { isErrnoException } from '../util/errors.js';

export type ResolveVia = 'env' | 'pid-sentinel';

export interface ResolveResult {
  sid: string;
  via: ResolveVia;
}

export interface ResolveInput {
  /** Override for the parent process PID. Defaults to `process.ppid`. */
  ppid?: number;
  /** Override for the env var. Defaults to `process.env.PARLEY_SESSION_ID`. */
  envSid?: string | null;
}

const EXEC_TIMEOUT_MS = 1000;

/** Top-level resolver: walks all known strategies and returns the first hit. */
export function resolveSession(input: ResolveInput = {}): ResolveResult | null {
  const ppid = input.ppid ?? process.ppid;
  const envSid = input.envSid ?? process.env.PARLEY_SESSION_ID ?? null;

  if (envSid && existsSync(paths.sessionManifest(envSid))) {
    return { sid: envSid, via: 'env' };
  }

  const fromSentinel = readPidSentinel(ppid);
  if (fromSentinel) return { sid: fromSentinel, via: 'pid-sentinel' };

  return null;
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

// Walk at most this many parent processes when searching for the Claude
// process in the ancestor chain. Claude is rarely more than a few levels deep;
// this prevents runaway walks if the chain loops or extends unexpectedly.
const MAX_ANCESTOR_DEPTH = 15;

function findClaudePid(startPid: number): number | null {
  let pid = startPid;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
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
