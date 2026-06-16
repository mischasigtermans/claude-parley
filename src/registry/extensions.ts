import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './paths.js';
import { assertValidAlias, InvalidAliasError, type McpServerConfig } from './peers.js';
import { isErrnoException } from '../util/errors.js';

/**
 * A peer entry provided by an extension. Looks just like a user-curated peer
 * but carries provenance: the manifest filename and extension display name.
 */
export interface ExtensionPeer {
  alias: string;
  path: string;
  description?: string;
  type?: string;
  /** Model the headless spawn should use for this peer (e.g. 'opus'). */
  model?: string;
  /** MCP servers to expose to the headless spawn. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Whether to pass --dangerously-skip-permissions for this peer. */
  skipPermissions?: boolean;
  /** Extension name (from manifest.name). Shown in parley_peers. */
  extension: string;
  /** Absolute path to the manifest file that declared this peer. */
  manifestPath: string;
}

interface ExtensionManifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  peers?: unknown;
}

interface RawPeer {
  alias?: unknown;
  path?: unknown;
  description?: unknown;
  type?: unknown;
  model?: unknown;
  mcpServers?: unknown;
  skipPermissions?: unknown;
}

/**
 * Scan ~/.claude/parley/extensions/*.json. Each file is a manifest declaring
 * one or more peers the extension exposes. Returns a flat list with extension
 * provenance. Malformed files are skipped silently so extension authors get
 * predictable behavior; parley never crashes on bad input.
 */
export async function readExtensions(): Promise<ExtensionPeer[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.extensionsDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    throw err;
  }

  const out: ExtensionPeer[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const manifestPath = join(paths.extensionsDir, file);
    let manifest: ExtensionManifest;
    try {
      const raw = await readFile(manifestPath, 'utf8');
      manifest = JSON.parse(raw) as ExtensionManifest;
    } catch {
      continue;
    }
    const extName = typeof manifest.name === 'string' && manifest.name.length > 0
      ? manifest.name
      : file.replace(/\.json$/, '');
    if (!Array.isArray(manifest.peers)) continue;
    for (const p of manifest.peers as RawPeer[]) {
      if (typeof p?.alias !== 'string' || typeof p?.path !== 'string') continue;
      try {
        assertValidAlias(p.alias);
      } catch (err) {
        if (err instanceof InvalidAliasError) {
          process.stderr.write(
            `parley: extension "${extName}" declared invalid alias "${p.alias}", skipped\n`,
          );
          continue;
        }
        throw err;
      }
      out.push({
        alias: p.alias,
        path: p.path,
        description: typeof p.description === 'string' ? p.description : undefined,
        type: typeof p.type === 'string' ? p.type : undefined,
        model: typeof p.model === 'string' ? p.model : undefined,
        mcpServers: isPlainObject(p.mcpServers) ? (p.mcpServers as Record<string, McpServerConfig>) : undefined,
        skipPermissions: typeof p.skipPermissions === 'boolean' ? p.skipPermissions : undefined,
        extension: extName,
        manifestPath,
      });
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
