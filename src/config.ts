import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * What `parley_ask` does when no live listener exists for the peer.
 *
 *  - `headless` (default): spawn `claude -p` in the peer's directory with
 *    `--resume <cached sid>` if a pointer exists. For Claude subscription
 *    users, this draws from the Agent SDK credit pool (separate from
 *    interactive limits).
 *
 *  - `ask`: error each time with a clear options list. The skill prompts the
 *    user in natural language. Maximum control, more friction. Open the peer
 *    and run `/parley listen` to route a live answer at zero SDK credit.
 */
export type Fallback = 'headless' | 'ask';

export const FALLBACKS: Fallback[] = ['headless', 'ask'];

export interface MemoryConfig {
  /** Default memory state for peers that don't declare their own. */
  default: boolean;
  /** Per-peer overrides keyed by canonical alias. Wins over everything. */
  peers: Record<string, boolean>;
}

export interface ParleyConfig {
  fallback: Fallback;
  skipDefault: boolean;
  memory: MemoryConfig;
}

const DEFAULT_CONFIG: ParleyConfig = {
  fallback: 'headless',
  skipDefault: true,
  memory: { default: true, peers: {} },
};

/**
 * Resolve whether memory is on for a peer. Precedence: per-peer config override
 * (user) → the peer's own declared flag (peers.json / extension manifest) →
 * the config default.
 */
export function memoryEnabledFor(
  config: ParleyConfig,
  alias: string,
  declared: boolean | undefined,
): boolean {
  const override = config.memory.peers[alias];
  if (typeof override === 'boolean') return override;
  if (typeof declared === 'boolean') return declared;
  return config.memory.default;
}

export function configPath(): string {
  return process.env.PARLEY_CONFIG ?? join(homedir(), '.claude', 'parley', 'config.json');
}

function legacyTomlPath(): string {
  // Pre-0.3 config file. One-time migration on first read.
  const explicit = process.env.PARLEY_CONFIG;
  if (explicit && explicit.endsWith('.json')) {
    return explicit.replace(/\.json$/, '.toml');
  }
  return join(homedir(), '.claude', 'parley', 'config.toml');
}

export function parseFallback(value: unknown): Fallback | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  return FALLBACKS.includes(normalized as Fallback) ? (normalized as Fallback) : undefined;
}

function readTomlString(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*["']?([\\w-]+)["']?\\s*$`, 'im'));
  return match?.[1];
}

function readTomlBool(raw: string, key: string): boolean | undefined {
  const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*$`, 'im'));
  if (!match) return undefined;
  return match[1].toLowerCase() === 'true';
}

function parseLegacyToml(raw: string): Partial<ParleyConfig> {
  return {
    fallback: parseFallback(readTomlString(raw, 'fallback')),
    skipDefault: readTomlBool(raw, 'skip_default'),
  };
}

function parseMemory(raw: unknown): MemoryConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { default?: unknown; peers?: unknown };
  const peers: Record<string, boolean> = {};
  if (r.peers && typeof r.peers === 'object') {
    for (const [k, v] of Object.entries(r.peers as Record<string, unknown>)) {
      if (typeof v === 'boolean') peers[k] = v;
    }
  }
  return {
    default: typeof r.default === 'boolean' ? r.default : DEFAULT_CONFIG.memory.default,
    peers,
  };
}

function parseJson(raw: string): Partial<ParleyConfig> {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    const runtime = (obj as { runtime?: Record<string, unknown> }).runtime ?? {};
    const permissions = (obj as { permissions?: Record<string, unknown> }).permissions ?? {};
    return {
      fallback: parseFallback(runtime.fallback),
      skipDefault: typeof permissions.skip_default === 'boolean' ? permissions.skip_default : undefined,
      memory: parseMemory((obj as { memory?: unknown }).memory),
    };
  } catch {
    return {};
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

async function migrateLegacyTomlIfPresent(): Promise<Partial<ParleyConfig> | null> {
  const legacy = legacyTomlPath();
  let raw = '';
  try {
    raw = await readFile(legacy, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  const parsed = parseLegacyToml(raw);
  if (parsed.fallback === undefined && parsed.skipDefault === undefined) {
    process.stderr.write(
      `parley: could not parse legacy config.toml at ${legacy}, leaving in place\n`,
    );
    return null;
  }
  const merged: ParleyConfig = {
    fallback: parsed.fallback ?? DEFAULT_CONFIG.fallback,
    skipDefault: parsed.skipDefault ?? DEFAULT_CONFIG.skipDefault,
    memory: DEFAULT_CONFIG.memory,
  };
  const target = configPath();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, formatConfig(merged), 'utf8');
  await rm(legacy, { force: true });
  return parsed;
}

export async function readParleyConfig(): Promise<ParleyConfig> {
  const envFallback = parseFallback(process.env.PARLEY_FALLBACK);

  let raw = '';
  try {
    raw = await readFile(configPath(), 'utf8');
  } catch (err) {
    if (!isEnoent(err)) throw err;
    const migrated = await migrateLegacyTomlIfPresent();
    if (migrated) {
      return {
        fallback: envFallback ?? migrated.fallback ?? DEFAULT_CONFIG.fallback,
        skipDefault: migrated.skipDefault ?? DEFAULT_CONFIG.skipDefault,
        memory: DEFAULT_CONFIG.memory,
      };
    }
    return {
      fallback: envFallback ?? DEFAULT_CONFIG.fallback,
      skipDefault: DEFAULT_CONFIG.skipDefault,
      memory: DEFAULT_CONFIG.memory,
    };
  }

  const parsed = parseJson(raw);
  return {
    fallback: envFallback ?? parsed.fallback ?? DEFAULT_CONFIG.fallback,
    skipDefault: parsed.skipDefault ?? DEFAULT_CONFIG.skipDefault,
    memory: parsed.memory ?? DEFAULT_CONFIG.memory,
  };
}

export async function writeParleyConfig(next: Partial<ParleyConfig>): Promise<ParleyConfig> {
  const current = await readParleyConfig();
  const merged: ParleyConfig = {
    fallback: next.fallback ?? current.fallback,
    skipDefault: next.skipDefault ?? current.skipDefault,
    memory: next.memory ?? current.memory,
  };

  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatConfig(merged), 'utf8');
  return merged;
}

function formatConfig(config: ParleyConfig): string {
  return JSON.stringify(
    {
      runtime: { fallback: config.fallback },
      permissions: { skip_default: config.skipDefault },
      memory: { default: config.memory.default, peers: config.memory.peers },
    },
    null,
    2,
  ) + '\n';
}
