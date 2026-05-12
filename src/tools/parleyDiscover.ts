import { optionalNumber, type ToolDef } from './types.js';
import { discoverProjects, relativeAge } from '../discovery/projects.js';
import { readPeers } from '../registry/peers.js';
import { expandHome } from '../registry/paths.js';

interface Args {
  limit: number;
}

export const parleyDiscover: ToolDef<Args> = {
  name: 'parley_discover',
  description:
    "Scan ~/.claude/projects/ for project directories where the user has recently used Claude Code. Returns candidates that aren't yet registered as peers, sorted by last-used time. Useful for onboarding: pick which to add with parley_add. Does not register anything itself.",
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max candidates to return. Default 20.',
      },
    },
    additionalProperties: false,
  },
  parseArgs(raw) {
    const n = optionalNumber(raw, 'limit');
    return { limit: n !== undefined && n > 0 ? n : 20 };
  },
  async handler(args) {
    const limit = args.limit;
    const peers = await readPeers();
    const registered = new Set(
      Object.values(peers.peers).map((p) => expandHome(p.path)),
    );

    const all = await discoverProjects();
    const candidates = all.filter((p) => !registered.has(p.path)).slice(0, limit);

    if (candidates.length === 0) {
      return all.length === 0
        ? 'No Claude Code project history found at ~/.claude/projects/.'
        : 'No new candidates. Every recently-used project is already a registered peer.';
    }

    const now = new Date();
    const lines = ['Recently active Claude Code projects on this machine:', ''];
    for (const c of candidates) {
      const age = relativeAge(now, new Date(c.lastUsedMs));
      lines.push(`  • ${c.path} (${age})`);
    }
    lines.push('');
    lines.push('Add any of these with parley_add <alias> <path>.');
    return lines.join('\n');
  },
};
