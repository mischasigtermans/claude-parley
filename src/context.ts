import { existsSync } from 'node:fs';
import { paths } from './registry/paths.js';
import { parentCwd, resolveSession, ResolveResult } from './registry/session-resolver.js';

export interface ParleyContext {
  pluginRoot: string;
  cwd: string;
  getCurrentSessionId(): string | null;
  getCurrentSessionResolution(): ResolveResult | null;
  getCurrentProjectName(): string;
  getCurrentProjectPath(): string;
}

/**
 * Build the per-process context. `cwd` is captured at construction time
 * (the MCP server is long-lived and its cwd doesn't change at runtime).
 * Session resolution recomputes only when the cached manifest is gone.
 */
export function makeContext(): ParleyContext {
  const pluginRoot = process.env.PARLEY_PLUGIN_ROOT ?? '';
  const cwd = process.cwd();
  let cached: ResolveResult | null = null;

  function resolve(): ResolveResult | null {
    if (cached && existsSync(paths.sessionManifest(cached.sid))) return cached;
    cached = resolveSession({ cwd });
    return cached;
  }

  function projectPath(): string {
    const ppCwd = parentCwd(process.ppid);
    return ppCwd ?? cwd;
  }

  return {
    pluginRoot,
    cwd,
    getCurrentSessionId() {
      return resolve()?.sid ?? null;
    },
    getCurrentSessionResolution() {
      return resolve();
    },
    getCurrentProjectPath: projectPath,
    getCurrentProjectName() {
      return projectPath().split('/').pop() || 'unknown';
    },
  };
}
