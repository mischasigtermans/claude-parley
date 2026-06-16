import { readdir, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, expandHome } from '../registry/paths.js';
import { isProcessAlive, readManifest } from '../registry/sessions.js';
import { readPeers } from '../registry/peers.js';
import { readExtensions } from '../registry/extensions.js';
import { isErrnoException } from '../util/errors.js';

const HEARTBEAT_DEAD_MS = 60 * 60 * 1000;

export interface SweepRemoved {
  sessions: string[];
  sentinels: string[];
  headless: string[];
  projectDirs: string[];
  /** Extension manifests whose declared peer paths no longer exist. */
  extensions: string[];
}

export interface SweepResult {
  removed: SweepRemoved;
  advisories: string[];
  dryRun: boolean;
}

export async function sweep(
  opts: { dryRun?: boolean } = {},
): Promise<SweepResult> {
  const dryRun = opts.dryRun === true;
  const removed: SweepRemoved = {
    sessions: [],
    sentinels: [],
    headless: [],
    projectDirs: [],
    extensions: [],
  };
  const advisories: string[] = [];

  const peersFile = await readPeers();
  // Protect headless caches for BOTH user-curated peers and extension-provided
  // peers (e.g. personas). Without the extension aliases here, the sweep would
  // delete persona caches every cycle and break their cross-turn continuity.
  const extensions = await readExtensions();
  const peerAliases = new Set([
    ...Object.keys(peersFile.peers),
    ...extensions.map((e) => e.alias),
  ]);

  await sweepSessions(removed, dryRun);
  await sweepSentinels(removed, dryRun);
  await sweepHeadless(peerAliases, removed, dryRun);
  await sweepEmptyProjectDirs(removed, dryRun);
  await sweepStaleExtensions(removed, dryRun);
  await collectAdvisories(peersFile.peers, advisories);

  return { removed, advisories, dryRun };
}

async function sweepSessions(removed: SweepRemoved, dryRun: boolean): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(paths.sessionsDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return;
    throw err;
  }
  const now = Date.now();
  for (const sid of entries) {
    const manifest = await readManifest(sid);
    if (!manifest) {
      if (!dryRun) await rm(paths.sessionDir(sid), { recursive: true, force: true });
      removed.sessions.push(sid);
      continue;
    }
    const age = now - new Date(manifest.lastHeartbeat).getTime();
    const stale = age > HEARTBEAT_DEAD_MS;
    const processAlive = isProcessAlive(manifest.pid);
    const pathGone = !(await pathExists(manifest.projectPath));
    if (stale && (!processAlive || pathGone)) {
      if (!dryRun) await rm(paths.sessionDir(sid), { recursive: true, force: true });
      removed.sessions.push(sid);
    }
  }
}

async function sweepSentinels(removed: SweepRemoved, dryRun: boolean): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(paths.byClaudePidDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return;
    throw err;
  }
  for (const file of entries) {
    if (!file.endsWith('.session')) continue;
    const pid = parseInt(file.slice(0, -'.session'.length), 10);
    if (!Number.isFinite(pid) || isProcessAlive(pid)) continue;
    if (!dryRun) await unlink(join(paths.byClaudePidDir, file)).catch(() => {});
    removed.sentinels.push(file);
  }
}

async function sweepHeadless(
  peerAliases: Set<string>,
  removed: SweepRemoved,
  dryRun: boolean,
): Promise<void> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(paths.headlessDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return;
    throw err;
  }
  for (const projectId of projectDirs) {
    const projectDir = paths.headlessProjectDir(projectId);
    let entries: string[];
    try {
      const st = await stat(projectDir);
      if (!st.isDirectory()) continue;
      entries = await readdir(projectDir);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') continue;
      throw err;
    }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const alias = file.slice(0, -'.json'.length);
      if (peerAliases.has(alias)) continue;
      if (!dryRun) await unlink(join(projectDir, file)).catch(() => {});
      removed.headless.push(`${projectId}/${alias}`);
    }
  }
}

/**
 * Remove empty `<projectId>/` subdirectories under `headless/` and `logs/`.
 * Runs after sweepHeadless so any directory left empty by alias pruning gets
 * collected. Treats non-directories at the top level as orphans from the
 * pre-v0.3.0 flat layout and leaves them alone.
 */
async function sweepEmptyProjectDirs(
  removed: SweepRemoved,
  dryRun: boolean,
): Promise<void> {
  for (const root of [paths.headlessDir, paths.logsDir]) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') continue;
      throw err;
    }
    for (const name of entries) {
      const dir = join(root, name);
      try {
        const st = await stat(dir);
        if (!st.isDirectory()) continue;
        const contents = await readdir(dir);
        if (contents.length > 0) continue;
        if (!dryRun) await rm(dir, { recursive: true, force: true });
        removed.projectDirs.push(`${root.endsWith('/headless') ? 'headless' : 'logs'}/${name}`);
      } catch (err) {
        if (isErrnoException(err) && err.code === 'ENOENT') continue;
        throw err;
      }
    }
  }
}

/**
 * Remove extension manifests whose declared peer paths are all gone. Tolerant
 * of malformed JSON (skips silently) so a broken manifest doesn't poison the
 * sweep. Partially-stale manifests (some peers ok, some gone) stay; the
 * extension itself owns peer accuracy. Parley only removes the manifest when
 * EVERY peer's path is missing on disk.
 */
async function sweepStaleExtensions(
  removed: SweepRemoved,
  dryRun: boolean,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(paths.extensionsDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return;
    throw err;
  }
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const manifestPath = join(paths.extensionsDir, file);
    let manifest: { peers?: unknown };
    try {
      const raw = await import('node:fs/promises').then((m) => m.readFile(manifestPath, 'utf8'));
      manifest = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(manifest.peers) || manifest.peers.length === 0) continue;
    let anyAlive = false;
    for (const p of manifest.peers as Array<{ path?: unknown }>) {
      if (typeof p?.path !== 'string') continue;
      if (await pathExists(expandHome(p.path))) {
        anyAlive = true;
        break;
      }
    }
    if (anyAlive) continue;
    if (!dryRun) await unlink(manifestPath).catch(() => {});
    removed.extensions.push(file);
  }
}

async function collectAdvisories(
  peers: Record<string, { path: string }>,
  advisories: string[],
): Promise<void> {
  for (const [alias, cfg] of Object.entries(peers)) {
    const resolved = expandHome(cfg.path);
    if (!(await pathExists(resolved))) {
      advisories.push(
        `peer "${alias}" path ${cfg.path}: directory does not exist (use /parley remove ${alias} if intentional)`,
      );
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}
