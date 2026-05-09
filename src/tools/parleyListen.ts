import type { ToolDef } from './types.js';
import { setStatus } from '../registry/sessions.js';

export const parleyListen: ToolDef = {
  name: 'parley_listen',
  description: 'Flip the current session into "listening" status, making it the canonical live peer for its project path. Once listening, peer queries from other sessions will be routed to this window via the live tier instead of falling through to a headless spawn. The /parley listen slash command calls this tool, then enters the polling loop to receive and answer messages.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_args, ctx) {
    const sid = ctx.getCurrentSessionId();
    if (!sid) {
      throw new Error(
        'parley: this session is not registered. Restart Claude Code so the SessionStart hook can fire.',
      );
    }
    await setStatus(sid, 'listening');
    return `Session ${sid} is now listening for peer queries. The /parley listen slash command will drive the receive loop.`;
  },
};
