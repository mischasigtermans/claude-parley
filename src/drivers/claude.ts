import { createRequire } from 'node:module';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 2000;

export interface SpawnOptions {
  cwd: string;
  prompt: string;
  sessionId?: string;
  timeoutMs?: number;
  skipPermissions?: boolean;
  model?: string;
  mcpServers?: Record<string, unknown>;
}

export interface SpawnResult {
  output: string;
  sessionId: string;
}

export class DriverInvocationError extends Error {
  constructor(driver: string, detail: string) {
    super(`parley: ${driver} driver failed: ${detail}`);
  }
}

export class ClaudeDriver {
  readonly name = 'claude';
  private readonly inFlight = new Set<ChildProcess>();

  async spawn(opts: SpawnOptions): Promise<SpawnResult> {
    // A missing cwd makes node report `spawn <binary> ENOENT`, blaming the
    // binary for a path problem. Fail with the real cause instead.
    if (!existsSync(opts.cwd)) {
      throw new DriverInvocationError(this.name, `peer cwd does not exist: ${opts.cwd}`);
    }
    const args = buildClaudeArgs(opts);
    return runClaude(resolveClaudeBin(), args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      driverName: this.name,
      track: this.inFlight,
    });
  }

  async shutdown(timeoutMs: number = SHUTDOWN_GRACE_MS): Promise<void> {
    if (this.inFlight.size === 0) return;
    const children = Array.from(this.inFlight);
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch {}
    }
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const child of this.inFlight) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
}

export type ClaudeDriverShape = Pick<ClaudeDriver, 'spawn' | 'shutdown'>;

/**
 * Locate the claude executable. Under Desktop and Cowork the MCP server starts
 * from launchd, whose PATH omits the directories claude installs into, so the
 * known install locations are probed directly.
 */
export function pickClaudeBin(
  envOverride: string | undefined,
  candidates: string[],
  exists: (p: string) => boolean,
): string {
  if (envOverride) return envOverride;
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return 'claude';
}

export function claudeBinCandidates(home: string = homedir()): string[] {
  return [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'bin', 'claude'),
    '/usr/local/bin/claude',
    // The launcher symlinks above track the current version; this is the
    // installed binary itself, in case the symlinks are absent or dangling.
    join(home, '.local', 'share', 'claude', 'ClaudeCode.app', 'Contents', 'MacOS', 'claude'),
  ];
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let claudeBin: string | null = null;

export function resolveClaudeBin(): string {
  if (claudeBin) return claudeBin;
  claudeBin = pickClaudeBin(process.env.PARLEY_CLAUDE_BIN, claudeBinCandidates(), isExecutable);
  return claudeBin;
}

export function _resetClaudeBinForTesting(): void {
  claudeBin = null;
}

const requireFromHere = createRequire(import.meta.url);

let resolved: ClaudeDriverShape | null = null;
let overrideTried = false;

function loadOverride(): ClaudeDriverShape | null {
  if (overrideTried) return null;
  overrideTried = true;
  const modPath = process.env.PARLEY_DRIVER_OVERRIDE;
  if (!modPath) return null;
  try {
    const mod = requireFromHere(modPath);
    if (mod.default && typeof mod.default.spawn === 'function') return mod.default as ClaudeDriverShape;
    if (typeof mod.getDriver === 'function') return mod.getDriver('claude') as ClaudeDriverShape;
    if (typeof mod.spawn === 'function') return mod as unknown as ClaudeDriverShape;
    process.stderr.write(`parley: PARLEY_DRIVER_OVERRIDE module at ${modPath} did not export a usable driver\n`);
  } catch (err) {
    process.stderr.write(`parley: failed to load PARLEY_DRIVER_OVERRIDE=${modPath}: ${err}\n`);
  }
  return null;
}

export function getClaudeDriver(): ClaudeDriverShape {
  if (resolved) return resolved;
  resolved = loadOverride() ?? new ClaudeDriver();
  return resolved;
}

export function _setClaudeDriverForTesting(driver: ClaudeDriverShape | null): void {
  resolved = driver;
  overrideTried = driver !== null;
}

export function buildClaudeArgs(opts: SpawnOptions): string[] {
  const args: string[] = [
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.model) args.push('--model', opts.model);
  if (opts.skipPermissions) args.push('--dangerously-skip-permissions');
  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
  }
  return args;
}

export interface ClaudeEvent {
  type?: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  is_error?: boolean;
  error?: unknown;
}

export interface ParseInput {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  driverName?: string;
}

export function parseClaudeStreamOutput(input: ParseInput): SpawnResult {
  const driverName = input.driverName ?? 'claude';
  const stderr = input.stderr ?? '';
  const exitCode = input.exitCode ?? 0;

  let resultEvent: ClaudeEvent | null = null;
  let firstSessionId: string | null = null;

  for (const line of input.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let evt: ClaudeEvent;
    try {
      evt = JSON.parse(t);
    } catch {
      continue;
    }
    if (!firstSessionId && typeof evt.session_id === 'string') {
      firstSessionId = evt.session_id;
    }
    if (evt.type === 'result') {
      resultEvent = evt;
    }
  }

  if (exitCode !== 0 && !resultEvent) {
    throw new Error(`claude exited with code ${exitCode}. stderr=${truncate(stderr)}`);
  }

  const sessionId = resultEvent?.session_id ?? firstSessionId;
  if (!sessionId) {
    throw new DriverInvocationError(
      driverName,
      `no session_id in claude output. stderr=${truncate(stderr)}`,
    );
  }

  if (resultEvent?.is_error) {
    throw new DriverInvocationError(
      driverName,
      `claude reported error: ${JSON.stringify(resultEvent).slice(0, 800)}`,
    );
  }

  return { output: resultEvent?.result ?? '', sessionId };
}

interface RunOptions {
  cwd: string;
  timeoutMs: number;
  driverName: string;
  track?: Set<ChildProcess>;
}

function runClaude(command: string, args: string[], opts: RunOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Stop the spawned `claude -p` from registering itself as a live peer via
      // parley's SessionStart hook. Headless asks are transient, not windows.
      env: { ...process.env, PARLEY_SUPPRESS_REGISTER: '1' },
    });
    opts.track?.add(child);

    let stdout = '';
    let stderr = '';
    let resolved = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const killTimer = setTimeout(() => {
      if (resolved) return;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, opts.timeoutMs);
    killTimer.unref();

    const cleanup = () => {
      opts.track?.delete(child);
    };

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      cleanup();
      // The cached binary path can go stale when claude auto-updates and
      // replaces its install. Drop the cache so the next ask re-resolves.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') claudeBin = null;
      reject(err);
    });

    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      cleanup();
      try {
        const result = parseClaudeStreamOutput({
          stdout,
          stderr,
          exitCode: code ?? 0,
          driverName: opts.driverName,
        });
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function truncate(s: string, max = 500): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}
