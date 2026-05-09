import type { ToolDef } from './types.js';
import { clearHeadless } from '../registry/headless.js';

export const parleyReset: ToolDef = {
  name: 'parley_reset',
  description: 'Clear the cached headless Claude session for a peer so the next parley_ask spawns fresh. Use when the peer agent has gotten stuck, when you want a clean slate for a new line of questioning, or after pruning Claude Code transcripts.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Peer alias whose headless session should be reset.' },
    },
    required: ['alias'],
    additionalProperties: false,
  },
  async handler(args) {
    const alias = String(args.alias);
    const cleared = await clearHeadless(alias);
    return cleared
      ? `Cleared cached headless session for "${alias}". Next ask will spawn fresh.`
      : `No cached headless session for "${alias}".`;
  },
};
