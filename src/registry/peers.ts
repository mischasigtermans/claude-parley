import { readFile, mkdir } from 'node:fs/promises';
import { paths, expandHome } from './paths.js';
import { atomicWriteJSON, withLock } from './locks.js';
import { isErrnoException } from '../util/errors.js';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
}

export interface PeerConfig {
  path: string;
  description?: string;
  model?: string;
  mcpServers?: Record<string, McpServerConfig>;
  skipPermissions?: boolean;
}

export interface PeersDefaults {
  model?: string;
  mcpServers?: Record<string, McpServerConfig>;
  skipPermissions?: boolean;
}

export interface PeersFile {
  defaults?: PeersDefaults;
  peers: Record<string, PeerConfig>;
}

export interface ResolvedPeerConfig extends PeerConfig {
  resolvedModel?: string;
  resolvedMcpServers: Record<string, McpServerConfig>;
  resolvedSkipPermissions: boolean;
}

const empty: PeersFile = { peers: {} };

const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export class InvalidAliasError extends Error {
  constructor(alias: string) {
    super(
      `parley: invalid alias "${alias}". Aliases must start with a letter or digit and contain only letters, digits, underscores, or hyphens (max 64 chars).`,
    );
  }
}

export function assertValidAlias(alias: string): void {
  if (typeof alias !== 'string' || !ALIAS_PATTERN.test(alias)) {
    throw new InvalidAliasError(alias);
  }
}

export async function readPeers(): Promise<PeersFile> {
  try {
    const raw = await readFile(paths.peersFile, 'utf8');
    const parsed = JSON.parse(raw) as PeersFile;
    return { defaults: parsed.defaults, peers: parsed.peers ?? {} };
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return { ...empty, peers: { ...empty.peers } };
    }
    throw err;
  }
}

export async function writePeers(file: PeersFile): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await atomicWriteJSON(paths.peersFile, file);
}

export async function upsertPeer(alias: string, config: PeerConfig): Promise<PeerConfig> {
  assertValidAlias(alias);
  return withLock(`${paths.peersFile}.lock`, async () => {
    const file = await readPeers();
    const normalized: PeerConfig = {
      path: expandHome(config.path),
      description: config.description,
      model: config.model,
      mcpServers: config.mcpServers,
      skipPermissions: config.skipPermissions ?? true,
    };
    file.peers[alias] = normalized;
    await writePeers(file);
    return normalized;
  });
}

export async function removePeer(alias: string): Promise<boolean> {
  return withLock(`${paths.peersFile}.lock`, async () => {
    const file = await readPeers();
    if (!(alias in file.peers)) return false;
    delete file.peers[alias];
    await writePeers(file);
    return true;
  });
}

export async function findPeer(aliasOrPath: string): Promise<{ alias: string; config: PeerConfig } | null> {
  const file = await readPeers();
  return findPeerInFile(aliasOrPath, file);
}

export function findPeerInFile(
  aliasOrPath: string,
  file: PeersFile,
): { alias: string; config: PeerConfig } | null {
  if (file.peers[aliasOrPath]) {
    return { alias: aliasOrPath, config: file.peers[aliasOrPath] };
  }
  const expanded = expandHome(aliasOrPath);
  for (const [alias, cfg] of Object.entries(file.peers)) {
    if (expandHome(cfg.path) === expanded) return { alias, config: cfg };
  }
  return null;
}

export function resolvePeerConfigFromFile(
  alias: string,
  file: PeersFile,
): ResolvedPeerConfig | null {
  const peer = file.peers[alias];
  if (!peer) return null;
  const defaults = file.defaults ?? {};
  return {
    ...peer,
    resolvedModel: peer.model ?? defaults.model,
    resolvedMcpServers: peer.mcpServers ?? defaults.mcpServers ?? {},
    resolvedSkipPermissions: peer.skipPermissions ?? defaults.skipPermissions ?? true,
  };
}
