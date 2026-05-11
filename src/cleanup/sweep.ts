import { readdir, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, expandHome } from '../registry/paths.js';
import { isProcessAlive, readManifest } from '../registry/sessions.js';
import { readPeers } from '../registry/peers.js';
import { isErrnoException } from '../util/errors.js';

const HEARTBEAT_DEAD_MS = 60 * 60 * 1000;

export interface SweepRemoved {
  sessions: string[];
  sentinels: string[];
  headless: string[];
  killed: number[];
}

export interface SweepResult {
  removed: SweepRemoved;
  advisories: string[];
  dryRun: boolean;
}

export type SweepScope = 'full' | 'sentinels-only';

export async function sweep(
  opts: { dryRun?: boolean; scope?: SweepScope } = {},
): Promise<SweepResult> {
  const dryRun = opts.dryRun === true;
  const scope = opts.scope ?? 'full';
  const removed: SweepRemoved = { sessions: [], sentinels: [], headless: [], killed: [] };
  const advisories: string[] = [];

  if (scope === 'sentinels-only') {
    await sweepSentinels(removed, dryRun);
    return { removed, advisories, dryRun };
  }

  const peersFile = await readPeers();
  const peerAliases = new Set(Object.keys(peersFile.peers));

  await sweepSessions(removed, dryRun);
  await sweepSentinels(removed, dryRun);
  await sweepHeadless(peerAliases, removed, dryRun);
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
    const dead = !isProcessAlive(manifest.pid);
    const pathGone = !(await pathExists(manifest.projectPath));
    if (stale && (dead || pathGone)) {
      if (!dead && manifest.pid && manifest.pid !== process.pid) {
        if (!dryRun) {
          try { process.kill(manifest.pid, 'SIGTERM'); } catch {}
        }
        removed.killed.push(manifest.pid);
      }
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
  let entries: string[];
  try {
    entries = await readdir(paths.headlessDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return;
    throw err;
  }
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const alias = file.slice(0, -'.json'.length);
    if (peerAliases.has(alias)) continue;
    if (!dryRun) await unlink(join(paths.headlessDir, file)).catch(() => {});
    removed.headless.push(alias);
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
