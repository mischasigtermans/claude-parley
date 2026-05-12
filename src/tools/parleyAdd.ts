import { optionalBool, optionalString, requireString, type ToolDef } from './types.js';
import { upsertPeer, assertValidAlias } from '../registry/peers.js';

interface Args {
  alias: string;
  path: string;
  description?: string;
  skipPermissions: boolean;
}

export const parleyAdd: ToolDef<Args> = {
  name: 'parley_add',
  description:
    'Add or update a peer in ~/.claude/parley/peers.json. Once added, the peer is reachable by alias from any Claude Code session. Pass `description` only when the user explicitly provides one. It is an optional note that helps disambiguate natural-language references; do not invent it.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Short name to address the peer by (e.g. "stagent").' },
      path: { type: 'string', description: 'Absolute or ~-prefixed project path.' },
      description: {
        type: 'string',
        description:
          'OPTIONAL. Free-text hint provided by the user to help match natural-language references (e.g. "the legal project", "the booking app"). Leave empty if the user did not specify one. Do not fabricate.',
      },
      skipPermissions: { type: 'boolean', description: 'Pass --dangerously-skip-permissions to headless spawns. Default true.' },
    },
    required: ['alias', 'path'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    return {
      alias: requireString('parley_add', raw, 'alias'),
      path: requireString('parley_add', raw, 'path'),
      description: optionalString(raw, 'description')?.trim() || undefined,
      skipPermissions: optionalBool(raw, 'skipPermissions') ?? true,
    };
  },
  async handler(args) {
    assertValidAlias(args.alias);
    const saved = await upsertPeer(args.alias, {
      path: args.path,
      description: args.description,
      skipPermissions: args.skipPermissions,
    });
    return `Added peer "${args.alias}" → ${saved.path}`;
  },
};
