import type { ToolDef } from './types.js';
import { sendMessage, completeInProgress } from '../routing/queue.js';
import { readManifest } from '../registry/sessions.js';

export const parleyRespond: ToolDef = {
  name: 'parley_respond',
  description: 'Send a response back to a peer who queried this session. Use inside the /parley listen loop after answering a query received via parley_receive_next. The toSessionId and inReplyTo come from the FROM_ID and MESSAGE_ID of the received query.',
  inputSchema: {
    type: 'object',
    properties: {
      toSessionId: { type: 'string', description: 'The peer session ID (FROM_ID of the received query).' },
      inReplyTo: { type: 'string', description: 'The MESSAGE_ID of the received query.' },
      content: { type: 'string', description: 'The full response text. Include actual code/data, not just descriptions.' },
    },
    required: ['toSessionId', 'inReplyTo', 'content'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const sid = ctx.getCurrentSessionId();
    if (!sid) throw new Error('parley: no current session registered.');
    const manifest = await readManifest(sid);
    const fromProject = manifest?.alias ?? ctx.getCurrentProjectName();

    const inReplyTo = String(args.inReplyTo);
    const id = await sendMessage({
      fromSessionId: sid,
      fromProject,
      toSessionId: String(args.toSessionId),
      type: 'response',
      content: String(args.content),
      inReplyTo,
    });
    await completeInProgress(sid, inReplyTo);
    return `Sent response ${id} to ${args.toSessionId}.`;
  },
};
