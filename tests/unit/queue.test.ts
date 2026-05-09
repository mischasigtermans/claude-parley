import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sendMessage, waitForMessage, listInbox, pruneRead, Message } from '../../src/routing/queue.js';
import { writeManifest } from '../../src/registry/sessions.js';
import { paths } from '../../src/registry/paths.js';
import { setup } from '../helpers/tmpdir.js';

async function registerSession(sid: string) {
  await writeManifest({
    sessionId: sid,
    claudeSessionId: null,
    projectPath: `/abs/${sid}`,
    projectName: sid,
    alias: sid,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    status: 'registered',
    pid: 0,
  });
}

describe('queue / sendMessage', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('rejects sends to a session with no manifest (regression: parley_respond)', async () => {
    await registerSession('sender');
    await expect(
      sendMessage({
        fromSessionId: 'sender',
        fromProject: 'snd',
        toSessionId: 'ghost',
        type: 'response',
        content: 'should fail',
      }),
    ).rejects.toThrow(/not registered/);

    // No phantom inbox dir should have been created.
    const sessionsList = await readdir(paths.sessionsDir).catch(() => []);
    expect(sessionsList).not.toContain('ghost');
  });

  it('writes message JSON into the target inbox and a copy into the sender outbox', async () => {
    await registerSession('a');
    await registerSession('b');

    const id = await sendMessage({
      fromSessionId: 'a',
      fromProject: 'A',
      toSessionId: 'b',
      type: 'query',
      content: 'hello',
    });

    expect(id).toMatch(/^msg-/);
    const inboxFile = join(paths.sessionInbox('b'), `${id}.json`);
    const inboxMsg: Message = JSON.parse(await readFile(inboxFile, 'utf8'));
    expect(inboxMsg.content).toBe('hello');
    expect(inboxMsg.from).toBe('a');
    expect(inboxMsg.to).toBe('b');
    expect(inboxMsg.status).toBe('pending');

    const outboxFile = join(paths.sessionOutbox('a'), `${id}.json`);
    const outboxMsg: Message = JSON.parse(await readFile(outboxFile, 'utf8'));
    expect(outboxMsg.status).toBe('sent');
  });

  it('listInbox returns messages parsed as JSON', async () => {
    await registerSession('a');
    await registerSession('b');
    await sendMessage({
      fromSessionId: 'a',
      fromProject: 'A',
      toSessionId: 'b',
      type: 'query',
      content: 'one',
    });
    await sendMessage({
      fromSessionId: 'a',
      fromProject: 'A',
      toSessionId: 'b',
      type: 'query',
      content: 'two',
    });
    const inbox = await listInbox('b');
    expect(inbox.map((m) => m.content).sort()).toEqual(['one', 'two']);
  });
});

describe('queue / waitForMessage', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('returns null on timeout when no message matches', async () => {
    await registerSession('a');
    await mkdir(paths.sessionInbox('a'), { recursive: true });
    const result = await waitForMessage('a', () => true, { timeoutMs: 200 });
    expect(result).toBeNull();
  });

  it('matches a pending message and migrates it to read/ subdir with status=read', async () => {
    await registerSession('a');
    await registerSession('b');
    const id = await sendMessage({
      fromSessionId: 'a',
      fromProject: 'A',
      toSessionId: 'b',
      type: 'query',
      content: 'check',
    });
    const msg = await waitForMessage('b', (m) => m.id === id, { timeoutMs: 2000 });
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe('check');

    // Original location should be empty.
    const inboxFile = join(paths.sessionInbox('b'), `${id}.json`);
    await expect(readFile(inboxFile, 'utf8')).rejects.toThrow();

    // Should have migrated to inbox/read/.
    const readFileLoc = join(paths.sessionInboxRead('b'), `${id}.json`);
    const reread: Message = JSON.parse(await readFile(readFileLoc, 'utf8'));
    expect(reread.status).toBe('read');
  });

  it('skips messages from self (echo prevention)', async () => {
    await registerSession('self');
    // Manually inject a message with from==to
    const inbox = paths.sessionInbox('self');
    await mkdir(inbox, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    const id = 'msg-selfecho';
    await writeFile(
      join(inbox, `${id}.json`),
      JSON.stringify({
        id,
        from: 'self',
        to: 'self',
        type: 'query',
        timestamp: new Date().toISOString(),
        status: 'pending',
        content: 'echo',
        inReplyTo: null,
        metadata: { fromProject: 'self' },
      }),
    );

    const result = await waitForMessage('self', () => true, { timeoutMs: 200 });
    expect(result).toBeNull();
  });
});

describe('queue / pruneRead', () => {
  const t = setup();
  beforeEach(t.before);
  afterEach(t.after);

  it('returns 0 when no read/ subdir exists', async () => {
    expect(await pruneRead('nonexistent', 1000)).toBe(0);
  });

  it('deletes entries older than the threshold and keeps fresh ones', async () => {
    await registerSession('s');
    const readDir = paths.sessionInboxRead('s');
    await mkdir(readDir, { recursive: true });
    const { writeFile, utimes } = await import('node:fs/promises');

    // Old file — set mtime 2 days back.
    const oldPath = join(readDir, 'old.json');
    await writeFile(oldPath, '{}');
    const longAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(oldPath, longAgo, longAgo);

    // Fresh file — leave mtime at now.
    const freshPath = join(readDir, 'fresh.json');
    await writeFile(freshPath, '{}');

    const removed = await pruneRead('s', 24 * 60 * 60 * 1000); // 1 day
    expect(removed).toBe(1);

    const remaining = await readdir(readDir);
    expect(remaining).toContain('fresh.json');
    expect(remaining).not.toContain('old.json');
  });
});
