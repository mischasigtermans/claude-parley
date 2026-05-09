import type { ToolDef } from './types.js';
import { waitForMessage } from '../routing/queue.js';

export const parleyReceiveNext: ToolDef = {
  name: 'parley_receive_next',
  description: 'BLOCKING: wait for the next pending message in this session\'s inbox and return it. Used inside the /parley listen loop. Marks the message as read once consumed. Returns a structured message header plus the question content.',
  inputSchema: {
    type: 'object',
    properties: {
      timeoutMs: {
        type: 'number',
        description: 'Max time to wait. Default 600000 (10 min). Use a long timeout because the listen loop polls indefinitely.',
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const sid = ctx.getCurrentSessionId();
    if (!sid) throw new Error('parley: no current session registered.');
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 600_000;

    const msg = await waitForMessage(sid, () => true, { timeoutMs, markRead: true });
    if (!msg) {
      return 'TIMEOUT. No message arrived. The listen loop should call this tool again.';
    }

    return [
      `MESSAGE_ID=${msg.id}`,
      `FROM_ID=${msg.from}`,
      `TO_ID=${msg.to}`,
      `FROM_PROJECT=${msg.metadata.fromProject}`,
      `TYPE=${msg.type}`,
      `IN_REPLY_TO=${msg.inReplyTo ?? ''}`,
      '---',
      msg.content,
    ].join('\n');
  },
};
