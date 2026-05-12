import type { ToolDef } from './types.js';
import { routeAsk } from '../routing/router.js';
import { readManifest } from '../registry/sessions.js';
import { paths } from '../registry/paths.js';

export const parleyAsk: ToolDef = {
  name: 'parley_ask',
  description:
    "Send a question to another project's Claude agent and return its answer. The peer is identified by alias (preferred, see parley_peers), by absolute path, or by alias:sid to target a specific listening session. Routing is automatic: live if exactly one /parley listen session matches, otherwise headless (resumed if a cached session exists, fresh otherwise). With 2+ listening sessions and no :sid, parley returns an error listing the available sids so you can retry with the explicit suffix. Headless agents run in the peer's project directory with full CLAUDE.md, skills, and tools loaded. The peer's response is appended to a transcript log readable via parley_log.",
  inputSchema: {
    type: 'object',
    properties: {
      peer: {
        type: 'string',
        description: 'Peer alias (e.g. "stagent"), alias:sid for a specific listening session (e.g. "onoma:a6v9lk"), or absolute project path. Run parley_peers to see options.',
      },
      question: {
        type: 'string',
        description: 'The full question or instruction for the peer agent. Be specific. The peer is a separate session and only sees this prompt.',
      },
      mode: {
        type: 'string',
        enum: ['default', 'deep'],
        description:
          '"default" (recommended): parley auto-prepends a concise directive so the peer answers fast and focused. "deep": no directive, pass through verbatim, peer is free to explore extensively. Use "deep" when you genuinely want the peer to investigate, not just answer a question.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional. Max time to wait for the peer to respond. Default 300000 (5 min).',
      },
    },
    required: ['peer', 'question'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const peer = String(args.peer);
    const question = String(args.question);
    const mode = args.mode === 'deep' ? 'deep' : 'default';
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;

    const sid = ctx.getCurrentSessionId();
    if (!sid) {
      throw new Error(
        'parley: this session is not registered. Restart Claude Code so the SessionStart hook can fire.',
      );
    }
    const manifest = await readManifest(sid);
    const fromProject = manifest?.alias ?? ctx.getCurrentProjectName();
    const fromProjectId = await paths.projectId(ctx.getCurrentProjectPath());

    const result = await routeAsk({
      peerRef: peer,
      question,
      fromSessionId: sid,
      fromProject,
      fromProjectId,
      timeoutMs,
      mode,
    });

    return `[${result.alias} via ${result.tier}${mode === 'deep' ? ' · deep' : ''}]\n\n${result.answer}`;
  },
};
