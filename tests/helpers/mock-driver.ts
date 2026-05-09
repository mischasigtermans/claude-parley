import type { ClaudeDriverShape, SpawnOptions, SpawnResult } from '../../src/drivers/claude.js';

export interface MockSpawnRecord {
  cwd: string;
  prompt: string;
  sessionId?: string;
  model?: string;
  mcpServers?: Record<string, unknown>;
  skipPermissions?: boolean;
  timeoutMs?: number;
}

export interface MockDriverOptions {
  output?: string | ((opts: SpawnOptions) => string);
  sessionId?: string | ((opts: SpawnOptions) => string);
  /** When set, throw on the matching invocation indices (zero-based). */
  throwOn?: number[];
  /** When `throwOn` matches, throw this. Defaults to a generic Error. */
  throwError?: Error;
}

export interface MockDriver extends ClaudeDriverShape {
  name: string;
  invocations: MockSpawnRecord[];
  reset(): void;
  configure(opts: MockDriverOptions): void;
  shutdownCalls: number;
}

export function createMockDriver(initial: MockDriverOptions = {}): MockDriver {
  let opts: MockDriverOptions = { ...initial };
  const invocations: MockSpawnRecord[] = [];
  let shutdownCalls = 0;

  return {
    name: 'claude',
    invocations,
    get shutdownCalls() { return shutdownCalls; },
    reset() {
      invocations.length = 0;
      shutdownCalls = 0;
    },
    configure(next) {
      opts = { ...opts, ...next };
    },
    async shutdown() {
      shutdownCalls++;
    },
    async spawn(call: SpawnOptions): Promise<SpawnResult> {
      const idx = invocations.length;
      invocations.push({
        cwd: call.cwd,
        prompt: call.prompt,
        sessionId: call.sessionId,
        model: call.model,
        mcpServers: call.mcpServers,
        skipPermissions: call.skipPermissions,
        timeoutMs: call.timeoutMs,
      });

      if (opts.throwOn?.includes(idx)) {
        throw opts.throwError ?? new Error(`mock driver: scheduled throw on call #${idx}`);
      }

      const out =
        typeof opts.output === 'function' ? opts.output(call) : opts.output ?? `mock-output-${idx}`;
      const sid =
        typeof opts.sessionId === 'function'
          ? opts.sessionId(call)
          : opts.sessionId ?? `mock-session-${idx}`;
      return { output: out, sessionId: sid };
    },
  };
}
