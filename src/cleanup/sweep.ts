import { readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, expandHome } from '../registry/paths.js';
import { isProcessAlive, readManifest } from '../registry/sessions.js';
import { readPeers } from '../registry/peers.js';
import { isErrnoException } from '../util/errors.js';

const HEARTBEAT_DEAD_MS = 60 * 60 * 1000;

export interface SweepRemoved {
  sessions: string[];
  sentinels: string[];
  pointers: string[];
  headless: string[];
  killed: number[];
}

export interface SweepResult {
  removed: SweepRemoved;
  advisories: string[];
  dryRun: boolean;
}

export async function sweep(opts: { dryRun?: boolean } = {}): Promise<SweepResult> {
  const dryRun = opts.dryRun === true;
  const removed: SweepRemoved = { sessions: [], sentinels: [], pointers: [], headless: [], killed: [] };
  const advisories: string[] = [];

  const peersFile = await readPeers();
  const peerAliases = new Set(Object.keys(peersFile.peers));

  const survivors = await sweepSessions(removed, dryRun);
  await sweepSentinels(removed, dryRun);
  await sweepPointers(survivors, peersFile.peers, removed, dryRun);
  await sweepHeadless(peerAliases, removed, dryRun);
  await collectAdvisories(peersFile.peers, advisories);

  return { removed, advisories, dryRun };
}

interface Survivor {
  sid: string;
  projectPath: string;
}

async function sweepSessions(removed: SweepRemoved, dryRun: boolean): Promise<Survivor[]> {
  const survivors: Survivor[] = [];
  let entries: string[];
  try {
    entries = await readdir(paths.sessionsDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return survivors;
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
    } else {
      survivors.push({ sid: manifest.sessionId, projectPath: manifest.projectPath });
    }
  }
  return survivors;
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

async function sweepPointers(
  survivors: Survivor[],
  peers: Record<string, { path: string }>,
  removed: SweepRemoved,
  dryRun: boolean,
): Promise<void> {
  const survivingSids = new Set(survivors.map((s) => s.sid));
  const candidates = new Set<string>(survivors.map((s) => s.projectPath));
  for (const cfg of Object.values(peers)) candidates.add(expandHome(cfg.path));

  for (const projectPath of candidates) {
    const pointer = join(projectPath, '.claude', 'parley-session');
    let sid: string;
    try {
      sid = (await readFile(pointer, 'utf8')).trim();
    } catch {
      continue;
    }
    if (!sid || survivingSids.has(sid)) continue;
    if (!dryRun) await unlink(pointer).catch(() => {});
    removed.pointers.push(pointer);
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
