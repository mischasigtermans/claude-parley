import { readdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isErrnoException } from '../util/errors.js';
import { listSessions } from '../registry/sessions.js';

export interface DiscoveredProject {
  path: string;
  lastUsedAt: string;
  lastUsedMs: number;
}

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SCAN_LINE_LIMIT = 20;
// Cowork runs each session out of a throwaway output dir, never a real project.
const EPHEMERAL_MARKER = 'local-agent-mode-sessions';

export async function discoverProjects(): Promise<DiscoveredProject[]> {
  const [cli, parley] = await Promise.all([scanCliProjects(), scanParleySessions()]);
  return dedupeByPath([...cli, ...parley]).sort((a, b) => b.lastUsedMs - a.lastUsedMs);
}

/**
 * Projects seen by parley's own SessionStart hook. Covers Desktop, which
 * doesn't write to the CLI's ~/.claude/projects index.
 */
export async function scanParleySessions(): Promise<DiscoveredProject[]> {
  const sessions = await listSessions();
  const results: DiscoveredProject[] = [];
  for (const s of sessions) {
    const path = s.projectPath;
    if (!path || path.includes(EPHEMERAL_MARKER)) continue;
    if (!existsSync(path)) continue;
    const ms = new Date(s.lastHeartbeat).getTime();
    if (!Number.isFinite(ms)) continue;
    results.push({ path, lastUsedAt: new Date(ms).toISOString(), lastUsedMs: ms });
  }
  return results;
}

export function dedupeByPath(projects: DiscoveredProject[]): DiscoveredProject[] {
  const byPath = new Map<string, DiscoveredProject>();
  for (const p of projects) {
    const existing = byPath.get(p.path);
    if (!existing || p.lastUsedMs > existing.lastUsedMs) byPath.set(p.path, p);
  }
  return Array.from(byPath.values());
}

async function scanCliProjects(): Promise<DiscoveredProject[]> {
  let entries: string[];
  try {
    entries = await readdir(PROJECTS_DIR);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    throw err;
  }

  const results: DiscoveredProject[] = [];
  for (const entry of entries) {
    const dir = join(PROJECTS_DIR, entry);
    const newest = await newestJsonl(dir);
    if (!newest) continue;
    const cwd = await extractCwd(newest.path);
    if (!cwd || !existsSync(cwd)) continue;
    results.push({
      path: cwd,
      lastUsedAt: newest.mtime.toISOString(),
      lastUsedMs: newest.mtime.getTime(),
    });
  }
  return results;
}

async function newestJsonl(dir: string): Promise<{ path: string; mtime: Date } | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtime: Date } | null = null;
  for (const e of entries) {
    if (!e.endsWith('.jsonl')) continue;
    const p = join(dir, e);
    try {
      const s = await stat(p);
      if (!best || s.mtime > best.mtime) best = { path: p, mtime: s.mtime };
    } catch {}
  }
  return best;
}

async function extractCwd(jsonlPath: string): Promise<string | null> {
  const stream = createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of rl) {
      if (++count > SCAN_LINE_LIMIT) break;
      const t = line.trim();
      if (!t) continue;
      try {
        const evt = JSON.parse(t);
        if (typeof evt.cwd === 'string' && evt.cwd.length > 0) return evt.cwd;
      } catch {}
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

export function relativeAge(now: Date, then: Date): string {
  const diff = now.getTime() - then.getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
