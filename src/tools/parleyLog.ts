import type { ToolDef } from './types.js';
import { readTranscript } from '../routing/transcript.js';

export const parleyLog: ToolDef = {
  name: 'parley_log',
  description: 'Return the recent conversation transcript with a peer (Q&A history across all sessions and tiers). Useful for reviewing what was previously asked or answered.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Peer alias to show the transcript for.' },
      tail: { type: 'number', description: 'Number of recent turns to return. Default 20. Use 0 for full log.' },
    },
    required: ['alias'],
    additionalProperties: false,
  },
  async handler(args) {
    const alias = String(args.alias);
    const tail = typeof args.tail === 'number' ? args.tail : 20;
    const content = await readTranscript(alias, tail);
    return content || `No transcript yet for "${alias}".`;
  },
};
