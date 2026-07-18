import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  pickClaudeBin,
  claudeBinCandidates,
  resolveClaudeBin,
  _resetClaudeBinForTesting,
} from '../../src/drivers/claude.js';

describe('pickClaudeBin', () => {
  const candidates = claudeBinCandidates('/home/u');
  const none = () => false;

  it('prefers the env override without touching the filesystem', () => {
    expect(pickClaudeBin('/custom/claude', candidates, () => {
      throw new Error('should not stat');
    })).toBe('/custom/claude');
  });

  it('walks candidates in order', () => {
    const exists = (p: string) => p === '/usr/local/bin/claude' || p === join('/home/u', '.claude', 'bin', 'claude');
    expect(pickClaudeBin(undefined, candidates, exists)).toBe(join('/home/u', '.claude', 'bin', 'claude'));
  });

  it('puts ~/.local/bin ahead of the rest', () => {
    expect(pickClaudeBin(undefined, candidates, () => true)).toBe(
      join('/home/u', '.local', 'bin', 'claude'),
    );
  });

  it('falls back to the bare command when nothing exists', () => {
    expect(pickClaudeBin(undefined, candidates, none)).toBe('claude');
  });

  it('tries the installed app binary when the launcher symlinks are gone', () => {
    const appBin = join('/home/u', '.local', 'share', 'claude', 'ClaudeCode.app', 'Contents', 'MacOS', 'claude');
    expect(candidates[candidates.length - 1]).toBe(appBin);
    expect(pickClaudeBin(undefined, candidates, (p) => p === appBin)).toBe(appBin);
  });

  it('ignores an empty env override', () => {
    expect(pickClaudeBin('', candidates, none)).toBe('claude');
  });
});

describe('resolveClaudeBin', () => {
  const prev = process.env.PARLEY_CLAUDE_BIN;

  afterEach(() => {
    if (prev === undefined) delete process.env.PARLEY_CLAUDE_BIN;
    else process.env.PARLEY_CLAUDE_BIN = prev;
    _resetClaudeBinForTesting();
  });

  it('reads PARLEY_CLAUDE_BIN', () => {
    _resetClaudeBinForTesting();
    process.env.PARLEY_CLAUDE_BIN = '/opt/bin/claude';
    expect(resolveClaudeBin()).toBe('/opt/bin/claude');
  });

  it('caches the first resolution', () => {
    _resetClaudeBinForTesting();
    process.env.PARLEY_CLAUDE_BIN = '/opt/bin/claude';
    resolveClaudeBin();
    process.env.PARLEY_CLAUDE_BIN = '/somewhere/else/claude';
    expect(resolveClaudeBin()).toBe('/opt/bin/claude');
  });
});
