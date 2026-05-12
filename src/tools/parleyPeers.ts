import type { ToolDef } from './types.js';
import { readPeers } from '../registry/peers.js';
import {
  listLiveByPath,
  listLiveSessions,
  readManifest,
  type Mode,
  type Platform,
  SessionManifest,
} from '../registry/sessions.js';
import { readHeadless } from '../registry/headless.js';
import { expandHome, type ProjectId } from '../registry/paths.js';

interface Row {
  peer: string;
  source: string;
  mode: 'headless' | 'listening';
  history: string;
  path: string;
  notes: string[];
}

export const parleyPeers: ToolDef = {
  name: 'parley_peers',
  description:
    "List all addressable peers on this machine. Call this FIRST whenever the user references another project by name (e.g. 'ask stagent about X', 'check with onoma', 'what does Y think'). Each peer gets a headless row (always reachable, alias-keyed) plus one row per /parley listen session at that path (addressable as alias:sid). Use the result to pick the right peer ref before calling parley_ask. Returns a markdown table: Peer, Source (Code / Code CLI / Cowork / '-'), Mode (headless/listening), History (turns of cached headless conversation from the calling project, or '-'), Path, Notes.",
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_args, ctx) {
    const peersFile = await readPeers();
    const live = await listLiveSessions();
    const sid = ctx.getCurrentSessionId();
    const myManifest = sid ? await readManifest(sid) : null;
    const mySid = myManifest?.sessionId ?? sid;
    const myPath = myManifest?.projectPath ?? ctx.getCurrentProjectPath();
    const fromProjectId = await ctx.getProjectId();

    const rows: Row[] = [];
    const seenPaths = new Set<string>();

    for (const [alias, cfg] of Object.entries(peersFile.peers)) {
      const path = expandHome(cfg.path);
      seenPaths.add(path);
      const sessions = await listLiveByPath(path);
      await pushRowsForPath({
        rows,
        alias,
        displayPath: cfg.path,
        sessions,
        discovered: false,
        description: cfg.description,
        mySid,
        skipHeadless: path === myPath,
        fromProjectId,
      });
    }

    for (const s of live) {
      if (seenPaths.has(s.projectPath)) continue;
      if (mySid && s.sessionId === mySid && s.projectPath !== myPath) continue;
      seenPaths.add(s.projectPath);
      const sessions = live.filter((l) => l.projectPath === s.projectPath);
      await pushRowsForPath({
        rows,
        alias: s.alias,
        displayPath: s.projectPath,
        sessions,
        discovered: true,
        mySid,
        skipHeadless: s.projectPath === myPath,
        fromProjectId,
      });
    }

    if (rows.length === 0) {
      return 'No peers found. Add one with parley_add, or open another Claude Code session to discover it.';
    }

    const header = '| Peer | Source | Mode | History | Path | Notes |\n|---|---|---|---|---|---|';
    const body = rows.map(
      (r) => `| ${r.peer} | ${r.source} | ${r.mode} | ${r.history} | \`${r.path}\` | ${r.notes.join('. ')} |`,
    );
    return [header, ...body].join('\n');
  },
};

async function pushRowsForPath(opts: {
  rows: Row[];
  alias: string;
  displayPath: string;
  sessions: SessionManifest[];
  discovered: boolean;
  description?: string;
  mySid: string | null;
  skipHeadless: boolean;
  fromProjectId: ProjectId;
}): Promise<void> {
  const listening = opts.sessions.filter((s) => s.status === 'listening' && s.sessionId !== opts.mySid);
  const nonListening = opts.sessions.filter((s) => s.status !== 'listening' && s.sessionId !== opts.mySid);

  if (!opts.skipHeadless) {
    const headless = await readHeadless(opts.fromProjectId, opts.alias);
    const history = headless
      ? `${headless.turnCount} ${headless.turnCount === 1 ? 'turn' : 'turns'}`
      : '-';

    const headlessNotes: string[] = [];
    if (opts.discovered) headlessNotes.push('discovered');
    if (nonListening.length > 0) {
      headlessNotes.push(`${nonListening.length} active window${nonListening.length === 1 ? '' : 's'}`);
    }
    if (opts.description) headlessNotes.push(opts.description);

    const seed = nonListening[0] ?? listening[0];
    opts.rows.push({
      peer: opts.alias,
      source: formatSource(seed?.platform, seed?.mode),
      mode: 'headless',
      history,
      path: opts.displayPath,
      notes: headlessNotes,
    });
  }

  for (const s of listening) {
    opts.rows.push({
      peer: `${opts.alias}:${s.sessionId}`,
      source: formatSource(s.platform, s.mode),
      mode: 'listening',
      history: '-',
      path: opts.displayPath,
      notes: [],
    });
  }
}

function formatSource(platform?: Platform, mode?: Mode): string {
  if (mode === 'cowork') return 'Cowork';
  if (platform === 'cli') return 'Code CLI';
  if (platform === 'desktop') return 'Code';
  return '-';
}
