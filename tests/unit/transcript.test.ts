import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { appendTurn, readTranscript } from '../../src/routing/transcript.js';
import { setup } from '../helpers/tmpdir.js';

describe('transcript', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('returns empty string when no transcript exists', async () => {
    expect(await readTranscript('lawyer', 0)).toBe('');
  });

  it('appendTurn writes a header + Q/A block', async () => {
    await appendTurn('lawyer', 'cowork', 'q1', 'a1', 'live');
    const tail = await readTranscript('lawyer', 0);
    expect(tail).toContain('from cowork');
    expect(tail).toContain('(live)');
    expect(tail).toContain('**Q:** q1');
    expect(tail).toContain('a1');
  });

  it('multiple turns are appended in order and tail respects N', async () => {
    await appendTurn('lawyer', 'cowork', 'q1', 'a1', 'headless-fresh');
    await appendTurn('lawyer', 'cowork', 'q2', 'a2', 'headless-resumed');
    await appendTurn('lawyer', 'cowork', 'q3', 'a3', 'headless-resumed');

    const tailAll = await readTranscript('lawyer', 0);
    expect(tailAll.indexOf('q1')).toBeLessThan(tailAll.indexOf('q2'));
    expect(tailAll.indexOf('q2')).toBeLessThan(tailAll.indexOf('q3'));

    const tailLast = await readTranscript('lawyer', 1);
    expect(tailLast).toContain('q3');
    expect(tailLast).not.toContain('q1');

    const tailLastTwo = await readTranscript('lawyer', 2);
    expect(tailLastTwo).toContain('q2');
    expect(tailLastTwo).toContain('q3');
    expect(tailLastTwo).not.toContain('q1');
  });
});
