import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { appendTurn, readTranscript } from '../../src/routing/transcript.js';
import type { ProjectId } from '../../src/registry/paths.js';
import { setup } from '../helpers/tmpdir.js';

describe('transcript', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  const PROJ = 'proj1234abcd' as ProjectId;

  it('returns empty string when no transcript exists', async () => {
    expect(await readTranscript(PROJ, 'peer-a', 0)).toBe('');
  });

  it('appendTurn writes a header + Q/A block', async () => {
    await appendTurn(PROJ, 'peer-a', 'cowork', 'q1', 'a1', 'live');
    const tail = await readTranscript(PROJ, 'peer-a', 0);
    expect(tail).toContain('from cowork');
    expect(tail).toContain('(live)');
    expect(tail).toContain('**Q:** q1');
    expect(tail).toContain('a1');
  });

  it('multiple turns are appended in order and tail respects N', async () => {
    await appendTurn(PROJ, 'peer-a', 'cowork', 'q1', 'a1', 'headless-fresh');
    await appendTurn(PROJ, 'peer-a', 'cowork', 'q2', 'a2', 'headless-resumed');
    await appendTurn(PROJ, 'peer-a', 'cowork', 'q3', 'a3', 'headless-resumed');

    const tailAll = await readTranscript(PROJ, 'peer-a', 0);
    expect(tailAll.indexOf('q1')).toBeLessThan(tailAll.indexOf('q2'));
    expect(tailAll.indexOf('q2')).toBeLessThan(tailAll.indexOf('q3'));

    const tailLast = await readTranscript(PROJ, 'peer-a', 1);
    expect(tailLast).toContain('q3');
    expect(tailLast).not.toContain('q1');

    const tailLastTwo = await readTranscript(PROJ, 'peer-a', 2);
    expect(tailLastTwo).toContain('q2');
    expect(tailLastTwo).toContain('q3');
    expect(tailLastTwo).not.toContain('q1');
  });

  it('transcripts are isolated per project', async () => {
    const PROJ_A = 'aaaaaaaaaaaa' as ProjectId;
    const PROJ_B = 'bbbbbbbbbbbb' as ProjectId;
    await appendTurn(PROJ_A, 'peer-a', 'cowork', 'a-question', 'a-answer', 'live');
    await appendTurn(PROJ_B, 'peer-a', 'cowork', 'b-question', 'b-answer', 'live');

    const tailA = await readTranscript(PROJ_A, 'peer-a', 0);
    const tailB = await readTranscript(PROJ_B, 'peer-a', 0);
    expect(tailA).toContain('a-question');
    expect(tailA).not.toContain('b-question');
    expect(tailB).toContain('b-question');
    expect(tailB).not.toContain('a-question');
  });
});
