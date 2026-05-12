import type { ToolDef } from './types.js';
import { sweep, type SweepResult } from '../cleanup/sweep.js';
import { readState, touchLastClean } from '../registry/state.js';

const CLEAN_INTERVAL_MS = 60 * 60 * 1000;

export const parleyClean: ToolDef = {
  name: 'parley_clean',
  description:
    "Remove stale Parley state on this machine: dead session manifests, dangling PID sentinels, and headless caches for peers that are no longer registered. peers.json entries with missing paths are flagged but never auto-removed. Idempotent. Use dryRun to preview without modifying anything. Use auto=true to no-op when state.json.lastCleanAt is younger than 1 hour (the /parley skill calls auto-clean at the top of every action via this flag).",
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
          'If true, skip the sweep when state.json.lastCleanAt is younger than 1 hour. Returns an empty string in that case.',
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
    result.removed.headless.length
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
    if (result.removed.sentinels.length > 0) {
      lines.push(`  • ${result.removed.sentinels.length} dead PID sentinel(s)`);
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
    const next = new Date(now.getTime() + CLEAN_INTERVAL_MS);
    lines.push('');
    lines.push(`Last clean: ${now.toISOString()} (next auto-clean after ${next.toISOString()})`);
  }

  return lines.join('\n');
}
