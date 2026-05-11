import type { ToolDef } from './types.js';
import { listLiveSessions, readManifest } from '../registry/sessions.js';
import { listInbox } from '../routing/queue.js';
import { readHeadless } from '../registry/headless.js';
import { findPeer, readPeers } from '../registry/peers.js';
import { discoverProjects } from '../discovery/projects.js';

const UNREGISTERED_WINDOW_MS = 60 * 60 * 1000;

export const parleyStatus: ToolDef = {
  name: 'parley_status',
  description: 'Show current Parley state: this session\'s ID and listening status, pending inbox messages, configured peers, and any cached headless sessions. If alias is provided, focus the report on that peer.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Optional peer alias to focus the report on.' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const sid = ctx.getCurrentSessionId();
    const lines: string[] = [];

    if (sid) {
      const manifest = await readManifest(sid);
      if (manifest) {
        lines.push(`This session: ${manifest.alias} (${sid})`);
        lines.push(`  status: ${manifest.status}`);
        lines.push(`  path: ${manifest.projectPath}`);
        lines.push(`  last heartbeat: ${manifest.lastHeartbeat}`);
        const inbox = await listInbox(sid);
        const pending = inbox.filter((m) => m.status === 'pending').length;
        lines.push(`  inbox: ${pending} pending of ${inbox.length} total`);
      }
    } else {
      lines.push('This session is not registered. The SessionStart hook may not have run.');
    }

    if (typeof args.alias === 'string') {
      const focus = await findPeer(args.alias);
      if (!focus) {
        lines.push(`\nNo peer "${args.alias}" configured.`);
      } else {
        const headless = await readHeadless(focus.alias);
        lines.push(`\nPeer "${focus.alias}":`);
        lines.push(`  path: ${focus.config.path}`);
        if (focus.config.description) lines.push(`  description: ${focus.config.description}`);
        if (headless) {
          lines.push(`  headless session: ${headless.claudeSessionId}`);
          lines.push(`  turns: ${headless.turnCount}, last used: ${headless.lastUsedAt}`);
        } else {
          lines.push('  no cached headless session');
        }
      }
    } else {
      const peers = await readPeers();
      const aliases = Object.keys(peers.peers);
      lines.push(`\nConfigured peers: ${aliases.length === 0 ? '(none)' : aliases.join(', ')}`);
    }

    const unregistered = await findUnregisteredClaudeProjects();
    if (unregistered.length > 0) {
      lines.push('');
      lines.push('Unregistered Claude projects (recently active, no Parley session):');
      for (const path of unregistered) lines.push(`  • ${path}`);
      lines.push('  Restart Claude Code in any of these directories so the SessionStart hook can register it.');
    }

    return lines.join('\n');
  },
};

async function findUnregisteredClaudeProjects(): Promise<string[]> {
  const now = Date.now();
  const [projects, live] = await Promise.all([discoverProjects(), listLiveSessions()]);
  const registered = new Set(live.map((s) => s.projectPath));
  return projects
    .filter((p) => now - p.lastUsedMs < UNREGISTERED_WINDOW_MS && !registered.has(p.path))
    .map((p) => p.path);
}
