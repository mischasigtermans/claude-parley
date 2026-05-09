import type { ToolDef } from './types.js';
import { readPeers } from '../registry/peers.js';
import { listLiveSessions, readManifest, type Mode, type Platform } from '../registry/sessions.js';
import { readHeadless } from '../registry/headless.js';
import { expandHome } from '../registry/paths.js';

type ListenMode = 'listening' | 'headless';

export const parleyPeers: ToolDef = {
  name: 'parley_peers',
  description:
    "List all addressable peers on this machine. Call this FIRST whenever the user references another project by name (e.g. 'ask stagent about X', 'check with onoma', 'what does Y think'). Use the result to pick the right peer alias before calling parley_ask. Returns a markdown table with columns: Peer, Source (Code / Code CLI / Cowork / inactive), Mode (listening if peer is in /parley listen, otherwise headless), Memory (turns of cached headless conversation, or '-'), Path, Notes. Includes both user-configured peers from peers.json and any live Claude Code sessions discovered on the machine.",
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

    interface Row {
      alias: string;
      path: string;
      description?: string;
      platform?: Platform;
      mode?: Mode;
      reachability: ListenMode;
      memory: string;
      discovered: boolean;
    }

    const rows: Row[] = [];
    const seenPaths = new Set<string>();

    for (const [alias, cfg] of Object.entries(peersFile.peers)) {
      const path = expandHome(cfg.path);
      seenPaths.add(path);
      if (path === myPath) continue;
      const liveMatch = live.find((s) => s.projectPath === path);
      const headless = await readHeadless(alias);
      rows.push({
        alias,
        path: cfg.path,
        description: cfg.description,
        platform: liveMatch?.platform,
        mode: liveMatch?.mode,
        reachability: liveMatch?.status === 'listening' ? 'listening' : 'headless',
        memory: headless
          ? `${headless.turnCount} ${headless.turnCount === 1 ? 'turn' : 'turns'}`
          : '-',
        discovered: false,
      });
    }

    for (const s of live) {
      if (seenPaths.has(s.projectPath)) continue;
      if (mySid && s.sessionId === mySid) continue;
      rows.push({
        alias: s.alias,
        path: s.projectPath,
        description: undefined,
        platform: s.platform,
        mode: s.mode,
        reachability: s.status === 'listening' ? 'listening' : 'headless',
        memory: '-',
        discovered: true,
      });
    }

    if (rows.length === 0) {
      return 'No peers found. Add one with parley_add, or open another Claude Code session to discover it.';
    }

    const header = '| Peer | Source | Mode | Memory | Path | Notes |\n|---|---|---|---|---|---|';
    const body = rows.map((r) => {
      const source = formatSource(r.platform, r.mode);
      const notes: string[] = [];
      if (r.discovered) notes.push('discovered');
      if (r.description) notes.push(r.description);
      return `| ${r.alias} | ${source} | ${r.reachability} | ${r.memory} | \`${r.path}\` | ${notes.join('. ')} |`;
    });
    return [header, ...body].join('\n');
  },
};

function formatSource(platform?: Platform, mode?: Mode): string {
  if (mode === 'cowork') return 'Cowork';
  if (platform === 'cli') return 'Code CLI';
  if (platform === 'desktop') return 'Code';
  return 'inactive';
}
