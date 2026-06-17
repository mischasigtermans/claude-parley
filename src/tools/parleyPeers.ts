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
import { readExtensions } from '../registry/extensions.js';
import { expandHome, type ProjectId } from '../registry/paths.js';

interface Row {
  peer: string;
  type: string;
  source: string;
  mode: 'headless' | 'listening';
  history: string;
  location: string;
  notes: string[];
}

export const parleyPeers: ToolDef = {
  name: 'parley_peers',
  description:
    "List all addressable peers on this machine. Call this FIRST whenever the user references another project by name (e.g. 'ask <peer> about X', 'check with <peer>'). Each peer gets a headless row (always reachable, alias-keyed) plus one row per /parley listen session at that path (addressable as alias:sid). Includes peers from ~/.claude/parley/peers.json AND from any extension manifests under ~/.claude/parley/extensions/. Use the result to pick the right peer ref before calling parley_ask. Returns a markdown table: Peer, Type, Source, Mode (headless/listening), History (turns of cached headless conversation from the calling project, or '-'), Location (filesystem path, or `<plugin>@<marketplace>` for plugin-managed peers), Notes.",
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
        displayPath: formatPath(cfg.path, cfg.type),
        sessions,
        discovered: false,
        description: cfg.description,
        mySid,
        skipHeadless: path === myPath,
        fromProjectId,
        type: cfg.type,
      });
    }

    // Extension-provided peers. User-curated peers above
    // already won; extensions can't override an alias that exists in peers.json.
    const extensions = await readExtensions();
    const userAliases = new Set(Object.keys(peersFile.peers));
    for (const ext of extensions) {
      if (userAliases.has(ext.alias)) continue;
      const path = expandHome(ext.path);
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      const sessions = await listLiveByPath(path);
      await pushRowsForPath({
        rows,
        alias: ext.alias,
        displayPath: formatPath(ext.path, ext.type),
        sessions,
        discovered: false,
        description: ext.description,
        mySid,
        skipHeadless: path === myPath,
        fromProjectId,
        type: ext.type,
        extension: ext.extension,
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

    // Sort alphabetically by canonical peer name (strip `:sid` suffixes so
    // listening rows stay grouped immediately after their headless row).
    // Stable sort preserves the headless-before-listening order within a peer.
    rows.sort((a, b) => {
      const aName = a.peer.split(':')[0];
      const bName = b.peer.split(':')[0];
      return aName.localeCompare(bName);
    });

    const header = '| Peer | Type | Source | Mode | History | Location | Notes |\n|---|---|---|---|---|---|---|';
    const body = rows.map(
      (r) => `| ${r.peer} | ${r.type} | ${r.source} | ${r.mode} | ${r.history} | \`${r.location}\` | ${r.notes.join('. ')} |`,
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
  type?: string;
  /** Extension name when this peer came from an extension manifest. */
  extension?: string;
}): Promise<void> {
  const listening = opts.sessions.filter((s) => s.status === 'listening' && s.sessionId !== opts.mySid);
  const nonListening = opts.sessions.filter((s) => s.status !== 'listening' && s.sessionId !== opts.mySid);

  if (!opts.skipHeadless) {
    const headless = await readHeadless(opts.fromProjectId, opts.alias);
    const history = headless
      ? `${headless.turnCount} ${headless.turnCount === 1 ? 'turn' : 'turns'}`
      : '-';

    const headlessNotes: string[] = [];
    const pending = headless ? headless.turnCount - (headless.rememberedTurn ?? 0) : 0;
    if (pending > 0) headlessNotes.push(`${pending} to distill`);
    if (opts.discovered) headlessNotes.push('discovered');
    if (nonListening.length > 0) {
      headlessNotes.push(`${nonListening.length} active window${nonListening.length === 1 ? '' : 's'}`);
    }
    if (opts.extension) {
      // Extension peers get a short ownership note. The verbose description
      // belongs in /<extension> list, not in this table.
      headlessNotes.push(`managed with /${opts.extension}`);
    } else if (opts.description) {
      headlessNotes.push(opts.description);
    }

    const seed = nonListening[0] ?? listening[0];
    opts.rows.push({
      peer: opts.alias,
      type: opts.type ?? 'project',
      source: formatSource(seed?.platform, seed?.mode),
      mode: 'headless',
      history,
      location: opts.displayPath,
      notes: headlessNotes,
    });
  }

  for (const s of listening) {
    opts.rows.push({
      peer: `${opts.alias}:${s.sessionId}`,
      type: opts.type ?? 'project',
      source: formatSource(s.platform, s.mode),
      mode: 'listening',
      history: '-',
      location: opts.displayPath,
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

/**
 * Display the peer's path. For typed peers whose path lives inside the Claude
 * Code plugin cache, render as `<plugin>@<marketplace>` instead of the full
 * cache path (cosmetic noise). Falls back to the raw path on anything else.
 */
function formatPath(rawPath: string, type?: string): string {
  if (!type) return rawPath;
  const match = rawPath.match(/\/\.claude\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+\/?$/);
  if (!match) return rawPath;
  const [, marketplace, plugin] = match;
  return `${plugin}@${marketplace}`;
}
