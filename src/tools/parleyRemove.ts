import type { ToolDef } from './types.js';
import { removePeer } from '../registry/peers.js';

export const parleyRemove: ToolDef = {
  name: 'parley_remove',
  description: 'Remove a peer from ~/.claude/parley/peers.json. Does not delete cached headless sessions or transcripts. Use parley_reset for that.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Peer alias to remove.' },
    },
    required: ['alias'],
    additionalProperties: false,
  },
  async handler(args) {
    const alias = String(args.alias);
    const removed = await removePeer(alias);
    return removed ? `Removed peer "${alias}".` : `No peer named "${alias}" was configured.`;
  },
};
