import { requireString, type ToolDef } from './types.js';
import { removePeer } from '../registry/peers.js';

interface Args {
  alias: string;
}

export const parleyRemove: ToolDef<Args> = {
  name: 'parley_remove',
  description: 'Remove a peer from ~/.claude/parley/peers.json. Its transcripts and memory stay. The sweep removes its headless record and threads.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Peer alias to remove.' },
    },
    required: ['alias'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    return { alias: requireString('parley_remove', raw, 'alias') };
  },
  async handler(args) {
    const removed = await removePeer(args.alias);
    return removed ? `Removed peer "${args.alias}".` : `No peer named "${args.alias}" was configured.`;
  },
};
