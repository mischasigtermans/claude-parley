import type { ToolDef } from './types.js';
import { clearHeadless } from '../registry/headless.js';
import { paths } from '../registry/paths.js';

export const parleyReset: ToolDef = {
  name: 'parley_reset',
  description: 'Clear the cached headless Claude session for a peer in the calling project so the next parley_ask from here spawns fresh. Use when the peer agent has gotten stuck, when you want a clean slate for a new line of questioning, or after pruning Claude Code transcripts. Only affects this project\'s cached session; other projects keep their own.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Peer alias whose headless session should be reset (for the calling project).' },
    },
    required: ['alias'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const alias = String(args.alias);
    const projectId = await paths.projectId(ctx.getCurrentProjectPath());
    const cleared = await clearHeadless(projectId, alias);
    return cleared
      ? `Cleared cached headless session for "${alias}" in this project. Next ask will spawn fresh.`
      : `No cached headless session for "${alias}" in this project.`;
  },
};
