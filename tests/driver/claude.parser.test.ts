import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseClaudeStreamOutput,
  buildClaudeArgs,
  DriverInvocationError,
} from '../../src/drivers/claude.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude-stream-json');
const fx = (name: string) => readFileSync(join(fixturesDir, name), 'utf8');

describe('parseClaudeStreamOutput', () => {
  it('parses tier-2 fresh spawn output', () => {
    const result = parseClaudeStreamOutput({ stdout: fx('tier2-fresh.txt'), exitCode: 0 });
    expect(result.sessionId).toBe('sess-fresh-uuid');
    expect(result.output).toBe('Here is the answer.');
  });

  it('parses tier-3 resume output', () => {
    const result = parseClaudeStreamOutput({ stdout: fx('tier3-resume.txt'), exitCode: 0 });
    expect(result.sessionId).toBe('sess-resumed-uuid');
    expect(result.output).toBe('Building on what we discussed earlier.');
  });

  it('throws DriverInvocationError on result with is_error=true', () => {
    expect(() => parseClaudeStreamOutput({ stdout: fx('error-event.txt'), exitCode: 0 })).toThrowError(
      DriverInvocationError,
    );
  });

  it('throws when stdout is empty and exit code is non-zero', () => {
    expect(() =>
      parseClaudeStreamOutput({
        stdout: fx('empty.txt'),
        stderr: 'claude: oops',
        exitCode: 1,
      }),
    ).toThrow(/exited with code 1/);
  });

  it('throws DriverInvocationError when there is no session_id at all', () => {
    expect(() => parseClaudeStreamOutput({ stdout: fx('empty.txt'), exitCode: 0 })).toThrowError(
      DriverInvocationError,
    );
  });

  it('skips non-JSON noise lines and still extracts the result', () => {
    const result = parseClaudeStreamOutput({ stdout: fx('noise-and-result.txt'), exitCode: 0 });
    expect(result.sessionId).toBe('sess-noise-uuid');
    expect(result.output).toBe('Final answer.');
  });

  it('falls back to firstSessionId when no result event arrives', () => {
    // No 'result' event in this fixture; we should still resolve via the init session_id
    // when exit code is 0. Output will be empty.
    const result = parseClaudeStreamOutput({ stdout: fx('no-result-event.txt'), exitCode: 0 });
    expect(result.sessionId).toBe('sess-truncated-uuid');
    expect(result.output).toBe('');
  });
});

describe('buildClaudeArgs', () => {
  it('sets stream-json output and verbose; omits mcp-config and skip-permissions by default', () => {
    const args = buildClaudeArgs({ cwd: '/tmp', prompt: 'hi' });
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
    // v0.3.0: don't pass --strict-mcp-config so the peer's own MCP servers load.
    expect(args).not.toContain('--strict-mcp-config');
    // No --mcp-config when peers.json:mcpServers is absent.
    expect(args).not.toContain('--mcp-config');
    // skipPermissions defaults to undefined; flag only appears when explicitly true.
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('passes --resume when sessionId is set', () => {
    const args = buildClaudeArgs({ cwd: '/tmp', prompt: 'hi', sessionId: 'abc' });
    const idx = args.indexOf('--resume');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('abc');
  });

  it('passes --model when model is set', () => {
    const args = buildClaudeArgs({ cwd: '/tmp', prompt: 'hi', model: 'sonnet' });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('sonnet');
  });

  it('emits the per-peer mcpServers config when provided (additive, no --strict-mcp-config)', () => {
    const args = buildClaudeArgs({
      cwd: '/tmp',
      prompt: 'hi',
      mcpServers: { Linear: { command: 'foo', args: [] } },
    });
    const cfgIdx = args.indexOf('--mcp-config');
    expect(cfgIdx).toBeGreaterThan(-1);
    const cfg = JSON.parse(args[cfgIdx + 1]);
    expect(cfg.mcpServers.Linear).toBeDefined();
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('adds --dangerously-skip-permissions when skipPermissions=true', () => {
    const args = buildClaudeArgs({ cwd: '/tmp', prompt: 'hi', skipPermissions: true });
    expect(args).toContain('--dangerously-skip-permissions');
  });
});
