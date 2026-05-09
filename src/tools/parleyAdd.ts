import type { ToolDef } from './types.js';
import { upsertPeer, assertValidAlias } from '../registry/peers.js';

export const parleyAdd: ToolDef = {
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
  async handler(args) {
    const alias = String(args.alias);
    const path = String(args.path);
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    const skipPermissions = typeof args.skipPermissions === 'boolean' ? args.skipPermissions : true;

    assertValidAlias(alias);

    const saved = await upsertPeer(alias, {
      path,
      description: description || undefined,
      agent: 'claude',
      skipPermissions,
    });

    return `Added peer "${alias}" → ${saved.path}`;
  },
};
