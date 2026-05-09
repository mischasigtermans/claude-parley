import type { ToolDef } from './types.js';
import { sweep, type SweepResult } from '../cleanup/sweep.js';
import { readState, touchLastClean } from '../registry/state.js';

const CLEAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export const parleyClean: ToolDef = {
  name: 'parley_clean',
  description:
    'Remove stale Parley state on this machine: dead session manifests, dangling PID sentinels, orphaned project pointers, and headless caches for peers that are no longer registered. peers.json entries with missing paths are flagged but never auto-removed. Idempotent. Use dryRun to preview without modifying anything. Use auto=true to no-op when the last clean ran less than 7 days ago (used by the /parley discovery menu).',
  inputSchema: {
    type: 'object',
    properties: {
      dryRun: {
        type: 'boolean',
        description: 'If true, report what would be removed without actually removing anything.',
      },
      auto: {
        type: 'boolean',
        description:
          'If true, skip the sweep when state.json.lastCleanAt is younger than 7 days. Returns an empty string in that case.',
      },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const dryRun = args.dryRun === true;
    const auto = args.auto === true;
    const now = new Date();

    if (auto) {
      const state = await readState();
      if (state.lastCleanAt) {
        const last = new Date(state.lastCleanAt).getTime();
        if (Number.isFinite(last) && now.getTime() - last < CLEAN_INTERVAL_MS) {
          return '';
        }
      }
    }

    const result = await sweep({ dryRun });
    const totalRemoved = countRemoved(result);

    if (!dryRun) await touchLastClean(now);

    if (auto && totalRemoved === 0 && result.advisories.length === 0) return '';

    return formatReport(result, totalRemoved, now);
  },
};

function countRemoved(result: SweepResult): number {
  return (
    result.removed.sessions.length +
    result.removed.sentinels.length +
    result.removed.pointers.length +
    result.removed.headless.length +
    result.removed.killed.length
  );
}

function formatReport(result: SweepResult, totalRemoved: number, now: Date): string {
  const lines: string[] = [];
  const verb = result.dryRun ? 'Would clean' : 'Cleaned';

  if (totalRemoved === 0) {
    lines.push(result.dryRun ? 'Nothing to clean.' : 'Already clean. Nothing removed.');
  } else {
    lines.push(`${verb}:`);
    if (result.removed.sessions.length > 0) {
      lines.push(`  • ${result.removed.sessions.length} stale session manifest(s) (heartbeat >1h, dead PID or missing path)`);
    }
    if (result.removed.killed.length > 0) {
      const verbKill = result.dryRun ? 'would terminate' : 'terminated';
      lines.push(`  • ${verbKill} ${result.removed.killed.length} orphan MCP server process(es): ${result.removed.killed.join(', ')}`);
    }
    if (result.removed.sentinels.length > 0) {
      lines.push(`  • ${result.removed.sentinels.length} dead PID sentinel(s)`);
    }
    if (result.removed.pointers.length > 0) {
      lines.push(`  • ${result.removed.pointers.length} orphaned project pointer(s)`);
      for (const p of result.removed.pointers) lines.push(`      ${p}`);
    }
    if (result.removed.headless.length > 0) {
      lines.push(`  • ${result.removed.headless.length} headless cache(s) for removed peers`);
      for (const a of result.removed.headless) lines.push(`      ${a}`);
    }
  }

  if (result.advisories.length > 0) {
    lines.push('');
    lines.push('Advisories (not auto-removed):');
    for (const a of result.advisories) lines.push(`  • ${a}`);
  }

  if (!result.dryRun) {
    const next = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    lines.push('');
    lines.push(`Last clean: ${now.toISOString()} (next auto-clean after ${next.toISOString().slice(0, 10)})`);
  }

  return lines.join('\n');
}
