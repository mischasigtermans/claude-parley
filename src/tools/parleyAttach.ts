import type { ToolDef } from './types.js';
import { routeAsk } from '../routing/router.js';
import { readManifest } from '../registry/sessions.js';

export const parleyAttach: ToolDef = {
  name: 'parley_attach',
  description:
    "Like parley_ask, but FAILS if the peer is not currently in /parley listen mode. Use only when the user explicitly wants the live, in-window flow (so they can see the conversation in the peer's Claude Code window in real time) and would rather get an error than a silent fall-back to headless. Supports alias:sid to target a specific listening session.",
  inputSchema: {
    type: 'object',
    properties: {
      peer: { type: 'string', description: 'Peer alias, alias:sid for a specific listening session, or absolute path.' },
      question: { type: 'string', description: 'Question to send.' },
      timeoutMs: { type: 'number', description: 'Max wait for response. Default 120000.' },
    },
    required: ['peer', 'question'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const sid = ctx.getCurrentSessionId();
    if (!sid) throw new Error('parley: no current session registered.');
    const manifest = await readManifest(sid);
    const fromProject = manifest?.alias ?? ctx.getCurrentProjectName();

    const result = await routeAsk({
      peerRef: String(args.peer),
      question: String(args.question),
      fromSessionId: sid,
      fromProject,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : 120_000,
      requireLive: true,
      mode: 'default',
    });

    return `[${result.alias} via ${result.tier}]\n\n${result.answer}`;
  },
};
