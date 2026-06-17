import { optionalNumber, requireString, type ToolDef } from './types.js';
import { routeAsk } from '../routing/router.js';
import { readManifest } from '../registry/sessions.js';

interface Args {
  peer: string;
  question: string;
  timeoutMs?: number;
}

export const parleyAsk: ToolDef<Args> = {
  name: 'parley_ask',
  description:
    "Send a question to another project's Claude agent and return its answer. Parley keeps one continuous conversation per (project, peer): a live listener answers in its window when one exists; otherwise it spawns headless `claude -p` in the peer's directory. Either path resumes the same claude session via --resume, so closing a window between turns doesn't lose memory. Peer is identified by alias (preferred, see parley_peers), by absolute path, or by alias:sid for a specific listener. The peer's project directory and CLAUDE.md/skills/MCP servers are loaded. Response is logged via parley_log.",
  inputSchema: {
    type: 'object',
    properties: {
      peer: {
        type: 'string',
        description: 'Peer alias, `<alias>:<sid>` for a specific listening session (e.g. `<peer>:a6v9lk`), or absolute project path. Run parley_peers to see options.',
      },
      question: {
        type: 'string',
        description: 'The full question or instruction for the peer agent. Be specific. The peer is a separate session and only sees this prompt.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional. Max ms to wait for the peer to respond. Leave unset unless you specifically need a tight bound; peers doing execution work can take 30+ min. Default 1800000 (30 min). Override the default globally via PARLEY_ASK_TIMEOUT_MS.',
      },
    },
    required: ['peer', 'question'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    return {
      peer: requireString('parley_ask', raw, 'peer'),
      question: requireString('parley_ask', raw, 'question'),
      timeoutMs: optionalNumber(raw, 'timeoutMs'),
    };
  },
  async handler(args, ctx) {
    const sid = ctx.getCurrentSessionId();
    if (!sid) {
      throw new Error(
        'parley: this session is not registered. Restart Claude Code so the SessionStart hook can fire.',
      );
    }
    const manifest = await readManifest(sid);
    const fromProject = manifest?.alias ?? ctx.getCurrentProjectName();
    const fromProjectId = await ctx.getProjectId();

    const result = await routeAsk({
      peerRef: args.peer,
      question: args.question,
      fromSessionId: sid,
      fromProject,
      fromProjectId,
      timeoutMs: args.timeoutMs,
    });

    // Live is the noteworthy case (the peer answered in their own window);
    // headless is the silent default. Resume vs fresh stays in the transcript.
    const prefix = result.tier === 'live'
      ? `[${result.alias} · live]`
      : `[${result.alias}]`;
    // Nudge the caller to distill once a few turns have piled up undistilled.
    const nudge = result.pending >= 3
      ? `\n\n[parley: ${result.pending} turns with ${result.alias} not yet distilled — call parley_remember ${result.alias} to persist memory]`
      : '';
    return `${prefix}\n\n${result.answer}${nudge}`;
  },
};
