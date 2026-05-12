import type { ToolDef } from './types.js';
import { readTranscript } from '../routing/transcript.js';
import { paths } from '../registry/paths.js';

export const parleyLog: ToolDef = {
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
  async handler(args, ctx) {
    const alias = String(args.alias);
    const tail = typeof args.tail === 'number' ? args.tail : 20;
    const fromProjectId = await paths.projectId(ctx.getCurrentProjectPath());
    const content = await readTranscript(fromProjectId, alias, tail);
    return content || `No transcript yet for "${alias}" from this project.`;
  },
};
