import { optionalNumber, requireString, type ToolDef } from './types.js';
import { readTranscript } from '../routing/transcript.js';
import { canonicalAlias } from '../routing/router.js';

interface Args {
  alias: string;
  tail: number;
}

export const parleyLog: ToolDef<Args> = {
  name: 'parley_log',
  description: "Return the recent conversation transcript with a peer from this project (Q&A history). Each (asker project, peer) pair has its own transcript; this returns the calling project's. Useful for reviewing what was previously asked or answered from here.",
  inputSchema: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Peer alias to show the transcript for.' },
      tail: { type: 'number', description: 'Number of recent turns to return. Default 20. Use 0 for full log.' },
    },
    required: ['alias'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    return {
      alias: requireString('parley_log', raw, 'alias'),
      tail: optionalNumber(raw, 'tail') ?? 20,
    };
  },
  async handler(args, ctx) {
    const fromProjectId = await ctx.getProjectId();
    const alias = await canonicalAlias(args.alias);
    const content = await readTranscript(fromProjectId, alias, args.tail);
    return content || `No transcript yet for "${args.alias}" from this project.`;
  },
};
