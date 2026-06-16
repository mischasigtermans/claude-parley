import { optionalBool, type ToolDef } from './types.js';
import { sweep, type SweepResult } from '../cleanup/sweep.js';
import { touchLastClean } from '../registry/state.js';

const CLEAN_INTERVAL_MS = 60 * 60 * 1000;

interface Args {
  dryRun: boolean;
}

export const parleyClean: ToolDef<Args> = {
  name: 'parley_clean',
  description:
    "Remove stale Parley state on this machine: dead session manifests, dangling PID sentinels, and headless caches for peers that are no longer registered. peers.json entries with missing paths are flagged but never auto-removed. Idempotent. Use dryRun to preview without modifying anything. The MCP server also runs this sweep automatically once per hour, so explicit cleans are only needed for ad-hoc inspection.",
  inputSchema: {
    type: 'object',
    properties: {
      dryRun: {
        type: 'boolean',
        description: 'If true, report what would be removed without actually removing anything.',
      },
    },
    additionalProperties: false,
  },
  parseArgs(raw) {
    return {
      dryRun: optionalBool(raw, 'dryRun') ?? false,
    };
  },
  async handler(args) {
    const dryRun = args.dryRun;
    const now = new Date();

    const result = await sweep({ dryRun });
    const totalRemoved = countRemoved(result);

    if (!dryRun) await touchLastClean(now);

    return formatReport(result, totalRemoved, now);
  },
};

function countRemoved(result: SweepResult): number {
  return (
    result.removed.sessions.length +
    result.removed.sentinels.length +
    result.removed.headless.length +
    result.removed.projectDirs.length +
    result.removed.extensions.length
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
    if (result.removed.projectDirs.length > 0) {
      lines.push(`  • ${result.removed.projectDirs.length} empty project director(ies)`);
      for (const d of result.removed.projectDirs) lines.push(`      ${d}`);
    }
    if (result.removed.extensions.length > 0) {
      lines.push(`  • ${result.removed.extensions.length} stale extension manifest(s)`);
      for (const e of result.removed.extensions) lines.push(`      ${e}`);
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
