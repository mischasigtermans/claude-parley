import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import {
  ClaudeDriver,
  resolveClaudeBin,
  _resetClaudeBinForTesting,
} from '../../src/drivers/claude.js';

const prev = process.env.PARLEY_CLAUDE_BIN;

afterEach(() => {
  if (prev === undefined) delete process.env.PARLEY_CLAUDE_BIN;
  else process.env.PARLEY_CLAUDE_BIN = prev;
  _resetClaudeBinForTesting();
});

describe('ClaudeDriver.spawn', () => {
  it('rejects a missing cwd with the real cause, not a binary error', async () => {
    const driver = new ClaudeDriver();
    await expect(
      driver.spawn({ cwd: '/nonexistent/peer/path', prompt: 'hi' }),
    ).rejects.toThrow('peer cwd does not exist: /nonexistent/peer/path');
  });

  it('drops the cached binary path after a spawn ENOENT', async () => {
    _resetClaudeBinForTesting();
    process.env.PARLEY_CLAUDE_BIN = '/nonexistent/claude-bin';
    expect(resolveClaudeBin()).toBe('/nonexistent/claude-bin');

    const driver = new ClaudeDriver();
    await expect(
      driver.spawn({ cwd: tmpdir(), prompt: 'hi', timeoutMs: 5000 }),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    delete process.env.PARLEY_CLAUDE_BIN;
    expect(resolveClaudeBin()).not.toBe('/nonexistent/claude-bin');
  });
});
