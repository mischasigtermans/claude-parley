import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './paths.js';
import { atomicWriteJSON, withLock } from './locks.js';
import { isErrnoException } from '../util/errors.js';

export type Platform = 'cli' | 'desktop' | 'unknown';
export type Mode = 'code' | 'cowork';

export interface SessionManifest {
  sessionId: string;
  claudeSessionId?: string | null;
  projectPath: string;
  projectName: string;
  alias: string;
  platform?: Platform;
  mode?: Mode;
  startedAt: string;
  lastHeartbeat: string;
  status: 'registered' | 'listening';
  pid: number;
}

const STALE_AFTER_MS = 5 * 60 * 1000;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EPERM') return true;
    return false;
  }
}

export async function readManifest(sid: string): Promise<SessionManifest | null> {
  let raw: string;
  try {
    raw = await readFile(paths.sessionManifest(sid), 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed: SessionManifest;
  try {
    parsed = JSON.parse(raw) as SessionManifest;
  } catch {
    return null;
  }
  if (!Number.isFinite(new Date(parsed.lastHeartbeat).getTime())) return null;
  return parsed;
}

export async function writeManifest(manifest: SessionManifest): Promise<void> {
  await mkdir(paths.sessionDir(manifest.sessionId), { recursive: true });
  await atomicWriteJSON(paths.sessionManifest(manifest.sessionId), manifest);
}

export async function updateManifest(
  sid: string,
  patch: (m: SessionManifest) => SessionManifest | null,
): Promise<boolean> {
  return withLock(`${paths.sessionManifest(sid)}.lock`, async () => {
    const manifest = await readManifest(sid);
    if (!manifest) return false;
    const next = patch(manifest);
    if (!next) return false;
    await writeManifest(next);
    return true;
  });
}

export async function touchHeartbeat(sid: string): Promise<void> {
  await updateManifest(sid, (m) => ({ ...m, lastHeartbeat: new Date().toISOString() }));
}

export async function setStatus(sid: string, status: SessionManifest['status']): Promise<void> {
  const updated = await updateManifest(sid, (m) => ({
    ...m,
    status,
    lastHeartbeat: new Date().toISOString(),
  }));
  if (!updated) {
    throw new Error(
      `parley: cannot set status on session "${sid}" because its manifest is missing. The session may have been cleaned up. Restart Claude Code or run a fresh /parley listen.`,
    );
  }
}

export async function listSessions(): Promise<SessionManifest[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.sessionsDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    throw err;
  }
  const out: SessionManifest[] = [];
  for (const sid of entries) {
    const m = await readManifest(sid);
    if (m) out.push(m);
  }
  return out;
}

export async function listLiveSessions(): Promise<SessionManifest[]> {
  const sessions = await listSessions();
  const now = Date.now();
  return sessions.filter((s) => now - new Date(s.lastHeartbeat).getTime() < STALE_AFTER_MS);
}

export async function listLiveByPath(projectPath: string): Promise<SessionManifest[]> {
  const live = await listLiveSessions();
  return live.filter((s) => s.projectPath === projectPath);
}

export async function findListeningByPath(projectPath: string): Promise<SessionManifest[]> {
  const live = await listLiveSessions();
  return live.filter((s) => s.projectPath === projectPath && s.status === 'listening');
}
