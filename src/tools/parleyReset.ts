import { requireString, type ToolDef } from './types.js';
import { clearHeadless } from '../registry/headless.js';
import { canonicalAlias } from '../routing/router.js';

interface Args {
  alias: string;
}

export const parleyReset: ToolDef<Args> = {
  name: 'parley_reset',
  description: "Clear the cached headless Claude session for a peer in the calling project so the next parley_ask from here spawns fresh. Use when the peer agent has gotten stuck, when you want a clean slate for a new line of questioning, or after pruning Claude Code transcripts. Only affects this project's cached session; other projects keep their own.",
  inputSchema: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Peer alias whose headless session should be reset (for the calling project).' },
    },
    required: ['alias'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    return { alias: requireString('parley_reset', raw, 'alias') };
  },
  async handler(args, ctx) {
    const projectId = await ctx.getProjectId();
    const alias = await canonicalAlias(args.alias);
    const cleared = await clearHeadless(projectId, alias);
    return cleared
      ? `Cleared cached headless session for "${args.alias}" in this project. Next ask will spawn fresh.`
      : `No cached headless session for "${args.alias}" in this project.`;
  },
};
