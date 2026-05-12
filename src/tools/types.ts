import type { ParleyContext } from '../context.js';

export interface ToolDef<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /**
   * Optional validator/coercer applied to the raw MCP argument bag before
   * `handler` runs. Tools that declare it get type-safe args; tools that omit
   * it receive the raw `Record<string, unknown>` (default TArgs).
   */
  parseArgs?(raw: Record<string, unknown>): TArgs;
  handler(args: TArgs, ctx: ParleyContext): Promise<string>;
}

export class InvalidToolArgsError extends Error {
  constructor(toolName: string, detail: string) {
    super(`parley: ${toolName} received invalid arguments: ${detail}`);
  }
}

export function requireString(toolName: string, raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new InvalidToolArgsError(toolName, `\`${key}\` must be a non-empty string`);
  }
  return v;
}

export function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function optionalNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function optionalBool(raw: Record<string, unknown>, key: string): boolean | undefined {
  const v = raw[key];
  return typeof v === 'boolean' ? v : undefined;
}
