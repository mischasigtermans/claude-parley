import type { ToolDef } from './types.js';
import { readManifest, setStatus } from '../registry/sessions.js';

export const parleyListen: ToolDef = {
  name: 'parley_listen',
  description: 'Flip the current session into "listening" status, making it an addressable live peer for its project path. Once listening, peer queries from other sessions can be routed to this window via the live tier instead of falling through to a headless spawn. Returns the session ID so other windows can address this session as alias:sid. The /parley listen slash command calls this tool, then enters the polling loop to receive and answer messages.',
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
    const manifest = await readManifest(sid);
    const alias = manifest?.alias ?? 'this-session';
    return `Listening as ${alias}:${sid}. Other windows can reach this session by addressing parley_ask with peer="${alias}:${sid}".`;
  },
};
