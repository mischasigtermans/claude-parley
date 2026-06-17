import { requireString, type ToolDef } from './types.js';
import { appendMemoryBullets } from '../registry/memory.js';
import { readHeadless, writeHeadless } from '../registry/headless.js';
import { canonicalAlias, isMemoryEnabled } from '../routing/router.js';

interface Args {
  peer: string;
  bullets: string;
}

export const parleyRemember: ToolDef<Args> = {
  name: 'parley_remember',
  description:
    "Persist durable memory about a peer so future parley_ask calls from this project arrive pre-primed. YOU distill the conversation: read the transcript with parley_log, then pass 3-8 concise `- bullet` takeaways (facts, decisions, preferences, patterns worth remembering) as `bullets`. Bullets are deduped against existing memory and prepended to the peer's next headless prompt. Call this at the end of a productive consultation, or when parley_ask reports pending turns. Memory is keyed per (this project, peer) and survives parley_reset.",
  inputSchema: {
    type: 'object',
    properties: {
      peer: { type: 'string', description: 'Peer alias whose memory to update.' },
      bullets: {
        type: 'string',
        description: 'Markdown bullet lines (each starting with "- ") distilled from the transcript. 3-8 concise, self-contained takeaways.',
      },
    },
    required: ['peer', 'bullets'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    return {
      peer: requireString('parley_remember', raw, 'peer'),
      bullets: requireString('parley_remember', raw, 'bullets'),
    };
  },
  async handler(args, ctx) {
    const projectId = await ctx.getProjectId();
    const alias = await canonicalAlias(args.peer);

    if (!(await isMemoryEnabled(alias))) {
      return `Memory is off for "${args.peer}". Turn it on in ~/.claude/parley/config.json (memory.peers.${alias} = true) or the peer's own config.`;
    }

    const stats = await appendMemoryBullets(projectId, alias, args.bullets);

    const headless = await readHeadless(projectId, alias);
    if (headless) {
      await writeHeadless({ ...headless, rememberedTurn: headless.turnCount });
    }

    if (stats.added === 0 && stats.deduped === 0) {
      return `No bullets found in input for "${alias}". Pass lines starting with "- ".`;
    }
    return `Remembered ${stats.added} new bullet(s) for "${alias}" (${stats.deduped} duplicate(s) skipped).`;
  },
};
