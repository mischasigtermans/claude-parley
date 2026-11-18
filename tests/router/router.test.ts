import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeManifest, setStatus } from '../../src/registry/sessions.js';
import { writePeers } from '../../src/registry/peers.js';
import { writeHeadless, readHeadless, readThread, writeThread, adoptConversation } from '../../src/registry/headless.js';
import { holdForeignLock } from '../helpers/foreign-lock.js';
import { touchLastClean } from '../../src/registry/state.js';
import { sweep } from '../../src/cleanup/sweep.js';
import type { PeerConfig } from '../../src/registry/peers.js';
import { paths } from '../../src/registry/paths.js';
import { routeAsk } from '../../src/routing/router.js';
import { writeParleyConfig } from '../../src/config.js';
import { _setClaudeDriverForTesting } from '../../src/drivers/claude.js';
import type { ProjectId } from '../../src/registry/paths.js';
import { createMockDriver } from '../helpers/mock-driver.js';
import { setup } from '../helpers/tmpdir.js';

const FROM_SESSION = 'caller';
const CALLER_PROJ = 'caller000000' as ProjectId;

async function registerCaller() {
  await writeManifest({
    sessionId: FROM_SESSION,
    claudeSessionId: null,
    projectPath: '/abs/caller',
    projectName: 'caller',
    alias: 'caller',
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    status: 'registered',
    pid: 0,
  });
}

describe('routeAsk', () => {
  const t = setup();
  beforeEach(async () => {
    await t.before();
    await registerCaller();
  });
  afterEach(async () => {
    _setClaudeDriverForTesting(null);
    await t.after();
  });

  it('throws when peer is not configured', async () => {
    await expect(
      routeAsk({
        peerRef: 'ghost',
        question: 'hi',
        fromSessionId: FROM_SESSION,
        fromProject: 'caller',
        fromProjectId: CALLER_PROJ,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('a first ask spawns fresh, answers with a thread, and counts the turn', async () => {
    const mock = createMockDriver({ output: 'a1', sessionId: 'sid-fresh' });
    _setClaudeDriverForTesting(mock);
    await writePeers({
      peers: { peer1: { path: '/abs/peer1' } },
    });

    const result = await routeAsk({
      peerRef: 'peer1',
      question: 'q1',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });

    expect(result.tier).toBe('headless-fresh');
    expect(result.alias).toBe('peer1');
    expect(result.answer).toBe('a1');
    expect(result.thread).toMatch(/^[a-z0-9]{6}$/);
    expect((await readThread(CALLER_PROJ, 'peer1', result.thread!))?.claudeSessionId).toBe('sid-fresh');

    const cached = await readHeadless(CALLER_PROJ, 'peer1');
    expect(cached?.claudeSessionId).toBe('');
    expect(cached?.turnCount).toBe(1);
  });

  it('passes per-peer model and mcpServers to the driver', async () => {
    const mock = createMockDriver();
    _setClaudeDriverForTesting(mock);
    await writePeers({
      peers: {
        peer1: {
          path: '/abs/peer1',
          model: 'opus',
          mcpServers: { Linear: { command: 'foo' } },
        },
      },
    });

    await routeAsk({
      peerRef: 'peer1',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });

    expect(mock.invocations[0].model).toBe('opus');
    expect(mock.invocations[0].mcpServers).toEqual({ Linear: { command: 'foo' } });
  });

  it('always prepends the concise directive to the prompt', async () => {
    const mock = createMockDriver();
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });

    await routeAsk({
      peerRef: 'peer1',
      question: 'literal-q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });
    expect(mock.invocations[0].prompt).toContain('parley directive');
    expect(mock.invocations[0].prompt).toContain('literal-q');
  });

  it('appends the turn to the transcript after a successful spawn', async () => {
    const mock = createMockDriver({ output: 'recorded', sessionId: 'sid-rec' });
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });

    const result = await routeAsk({
      peerRef: 'peer1',
      question: 'archive me',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });

    const log = await readFile(paths.logFor(CALLER_PROJ, 'peer1'), 'utf8');
    expect(log).toContain('archive me');
    expect(log).toContain('recorded');
    expect(log).toContain(`(headless-fresh) · thread ${result.thread}`);
  });

  it('routes live when exactly one listening session matches the peer path', async () => {
    const mock = createMockDriver();
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    await writeManifest({
      sessionId: 'listen1',
      claudeSessionId: null,
      projectPath: '/abs/peer1',
      projectName: 'peer1',
      alias: 'peer1',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'registered',
      pid: process.pid,
    });
    await setStatus('listen1', 'listening');

    const ask = routeAsk({
      peerRef: 'peer1',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
      timeoutMs: 50,
    });
    await expect(ask).rejects.toThrow(/did not respond/);
  });

  it('bare alias with 2+ listening sessions throws a multi-listener error', async () => {
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    for (const sid of ['lstn1a', 'lstn1b']) {
      await writeManifest({
        sessionId: sid,
        claudeSessionId: null,
        projectPath: '/abs/peer1',
        projectName: 'peer1',
        alias: 'peer1',
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        status: 'registered',
        pid: process.pid,
      });
      await setStatus(sid, 'listening');
    }

    await expect(
      routeAsk({
        peerRef: 'peer1',
        question: 'q',
        fromSessionId: FROM_SESSION,
        fromProject: 'caller',
        fromProjectId: CALLER_PROJ,
      }),
    ).rejects.toThrow(/2 listening sessions for "peer1".*lstn1a.*lstn1b/);
  });

  it('alias:sid routes to the named listening session', async () => {
    const mock = createMockDriver();
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    for (const sid of ['lstn1a', 'lstn1b']) {
      await writeManifest({
        sessionId: sid,
        claudeSessionId: null,
        projectPath: '/abs/peer1',
        projectName: 'peer1',
        alias: 'peer1',
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        status: 'registered',
        pid: process.pid,
      });
      await setStatus(sid, 'listening');
    }

    const ask = routeAsk({
      peerRef: 'peer1:lstn1b',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
      timeoutMs: 50,
    });
    await expect(ask).rejects.toThrow(/did not respond/);
  });

  it('alias:sid throws when the named session is not listening', async () => {
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    await writeManifest({
      sessionId: 'lstn1a',
      claudeSessionId: null,
      projectPath: '/abs/peer1',
      projectName: 'peer1',
      alias: 'peer1',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'registered',
      pid: process.pid,
    });

    await expect(
      routeAsk({
        peerRef: 'peer1:lstn1a',
        question: 'q',
        fromSessionId: FROM_SESSION,
        fromProject: 'caller',
        fromProjectId: CALLER_PROJ,
      }),
    ).rejects.toThrow(/is not in listen mode/);
  });

  it('alias:sid throws when the named session does not exist for that path', async () => {
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });

    await expect(
      routeAsk({
        peerRef: 'peer1:ghostt',
        question: 'q',
        fromSessionId: FROM_SESSION,
        fromProject: 'caller',
        fromProjectId: CALLER_PROJ,
      }),
    ).rejects.toThrow(/no live session "ghostt"/);
  });

  it('reads peers.json at most once per routeAsk', async () => {
    const mock = createMockDriver();
    _setClaudeDriverForTesting(mock);
    await writePeers({
      peers: { peer1: { path: '/abs/peer1' } },
    });

    const peersModule = await import('../../src/registry/peers.js');
    const spy = vi.spyOn(peersModule, 'readPeers');
    try {
      await routeAsk({
        peerRef: 'peer1',
        question: 'q',
        fromSessionId: FROM_SESSION,
        fromProject: 'caller',
        fromProjectId: CALLER_PROJ,
      });
      // routeAsk itself reads peers.json once; the lazy auto-sweep (triggered
      // by the first listLiveSessions call after cooldown expiry) reads it again.
      // sweepInFlight dedupes further calls.
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('live writeback updates pointer with listener claudeSessionId + origin=live', async () => {
    const mock = createMockDriver();
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    await writeManifest({
      sessionId: 'lst-live',
      claudeSessionId: 'claude-uuid-live',
      projectPath: '/abs/peer1',
      projectName: 'peer1',
      alias: 'peer1',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'registered',
      pid: process.pid,
    });
    await setStatus('lst-live', 'listening');

    // Kick off routeAsk; inject a response so routeLive resolves.
    const askPromise = routeAsk({
      peerRef: 'peer1',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
      timeoutMs: 2000,
    });
    const queue = await import('../../src/routing/queue.js');
    await new Promise((r) => setTimeout(r, 80));
    const fs = await import('node:fs/promises');
    let msgId: string | undefined;
    for (const dir of [paths.sessionInbox('lst-live'), paths.sessionInboxInProgress('lst-live')]) {
      const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
      if (files.length > 0) {
        msgId = JSON.parse(await fs.readFile(`${dir}/${files[0]}`, 'utf8')).id;
        break;
      }
    }
    expect(msgId).toBeTruthy();
    await queue.sendMessage({
      fromSessionId: 'lst-live',
      fromProject: 'peer1',
      toSessionId: FROM_SESSION,
      type: 'response',
      content: 'live answer',
      inReplyTo: msgId!,
    });
    const result = await askPromise;
    expect(result.tier).toBe('live');
    expect(result.answer).toBe('live answer');

    const cached = await readHeadless(CALLER_PROJ, 'peer1');
    expect(cached?.claudeSessionId).toBe('claude-uuid-live');
    expect(cached?.origin).toBe('live');
  });

  it('listener-match picks the listener whose claudeSessionId matches the cached pointer', async () => {
    const mock = createMockDriver();
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    // Two listeners, only one matches.
    for (const [sid, csid] of [['lst-other', 'claude-other'], ['lst-mine', 'claude-mine']] as const) {
      await writeManifest({
        sessionId: sid,
        claudeSessionId: csid,
        projectPath: '/abs/peer1',
        projectName: 'peer1',
        alias: 'peer1',
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        status: 'registered',
        pid: process.pid,
      });
      await setStatus(sid, 'listening');
    }
    await writeHeadless({
      projectId: CALLER_PROJ,
      alias: 'peer1',
      claudeSessionId: 'claude-mine',
      cwd: '/abs/peer1',
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 5,
      origin: 'live',
    });

    // Should route to lst-mine, not error with multi-listener disambiguation.
    const askPromise = routeAsk({
      peerRef: 'peer1',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
      timeoutMs: 1500,
    });
    const fs = await import('node:fs/promises');
    const queue = await import('../../src/routing/queue.js');
    await new Promise((r) => setTimeout(r, 80));
    let msgId: string | undefined;
    for (const dir of [paths.sessionInbox('lst-mine'), paths.sessionInboxInProgress('lst-mine')]) {
      const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
      if (files.length > 0) {
        msgId = JSON.parse(await fs.readFile(`${dir}/${files[0]}`, 'utf8')).id;
        break;
      }
    }
    expect(msgId).toBeTruthy(); // Confirms message went to lst-mine, not lst-other
    await queue.sendMessage({
      fromSessionId: 'lst-mine',
      fromProject: 'peer1',
      toSessionId: FROM_SESSION,
      type: 'response',
      content: 'matched',
      inReplyTo: msgId!,
    });
    const result = await askPromise;
    expect(result.answer).toBe('matched');
  });

  it('injects the memory block between preamble and question when memory exists', async () => {
    const mock = createMockDriver();
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    const { appendMemoryBullets } = await import('../../src/registry/memory.js');
    await appendMemoryBullets(CALLER_PROJ, 'peer1', '- remembered fact');

    await routeAsk({
      peerRef: 'peer1',
      question: 'literal-q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });

    const prompt = mock.invocations[0].prompt;
    expect(prompt).toContain('past conversations');
    expect(prompt).toContain('- remembered fact');
    expect(prompt.indexOf('parley directive')).toBeLessThan(prompt.indexOf('- remembered fact'));
    expect(prompt.indexOf('- remembered fact')).toBeLessThan(prompt.indexOf('literal-q'));
  });

  it('does not inject a memory block when no memory exists', async () => {
    const mock = createMockDriver();
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });

    await routeAsk({
      peerRef: 'peer1',
      question: 'literal-q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });
    expect(mock.invocations[0].prompt).not.toContain('past conversations');
  });

  it('skips memory injection when disabled for the peer', async () => {
    const mock = createMockDriver();
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    const { appendMemoryBullets } = await import('../../src/registry/memory.js');
    await appendMemoryBullets(CALLER_PROJ, 'peer1', '- remembered fact');
    await writeParleyConfig({ memory: { default: true, peers: { peer1: false } } });

    await routeAsk({
      peerRef: 'peer1',
      question: 'literal-q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });
    expect(mock.invocations[0].prompt).not.toContain('remembered fact');
  });

  it('reports pending turns and resets after remember', async () => {
    const mock = createMockDriver({ output: 'a', sessionId: 'sid' });
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });

    const r1 = await routeAsk({
      peerRef: 'peer1',
      question: 'q1',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });
    expect(r1.pending).toBe(1);

    const headless = await readHeadless(CALLER_PROJ, 'peer1');
    await writeHeadless({ ...headless!, rememberedTurn: headless!.turnCount });

    const r2 = await routeAsk({
      peerRef: 'peer1',
      question: 'q2',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });
    expect(r2.pending).toBe(1);
  });

  it('fallback="ask" throws the no-listener error with cost note', async () => {
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    await writeParleyConfig({ fallback: 'ask' });

    await expect(
      routeAsk({
        peerRef: 'peer1',
        question: 'q',
        fromSessionId: FROM_SESSION,
        fromProject: 'caller',
        fromProjectId: CALLER_PROJ,
      }),
    ).rejects.toThrow(/no live listener for "peer1".*fallback="ask".*Agent SDK credit pool/s);
  });

  it('fallback="ask" refuses an ask with a thread, saying a thread needs fallback="headless"', async () => {
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    await writeParleyConfig({ fallback: 'ask' });

    const ask = routeAsk({
      peerRef: 'peer1',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
      thread: 'k3x9qa',
    });

    await expect(ask).rejects.toThrow(/thread "k3x9qa" continues headless.*fallback="headless"/);
    await expect(ask).rejects.not.toThrow(/parley listen/);
  });

  it('a live answer keeps the adoption marker on the per-peer record', async () => {
    _setClaudeDriverForTesting(createMockDriver());
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    await writeHeadless({
      projectId: CALLER_PROJ,
      alias: 'peer1',
      claudeSessionId: 'sid-050',
      cwd: '/abs/peer1',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: new Date().toISOString(),
      turnCount: 3,
      origin: 'headless',
      adopted: true,
    });
    await writeManifest({
      sessionId: 'lst-live',
      claudeSessionId: 'claude-uuid-live',
      projectPath: '/abs/peer1',
      projectName: 'peer1',
      alias: 'peer1',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'registered',
      pid: process.pid,
    });
    await setStatus('lst-live', 'listening');

    const askPromise = routeAsk({
      peerRef: 'peer1',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
      timeoutMs: 2000,
    });
    const queue = await import('../../src/routing/queue.js');
    const fs = await import('node:fs/promises');
    await new Promise((r) => setTimeout(r, 80));
    let msgId: string | undefined;
    for (const dir of [paths.sessionInbox('lst-live'), paths.sessionInboxInProgress('lst-live')]) {
      const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
      if (files.length > 0) {
        msgId = JSON.parse(await fs.readFile(`${dir}/${files[0]}`, 'utf8')).id;
        break;
      }
    }
    await queue.sendMessage({
      fromSessionId: 'lst-live',
      fromProject: 'peer1',
      toSessionId: FROM_SESSION,
      type: 'response',
      content: 'live answer',
      inReplyTo: msgId!,
    });
    expect((await askPromise).tier).toBe('live');

    const record = await readHeadless(CALLER_PROJ, 'peer1');
    expect(record?.origin).toBe('live');
    expect(record?.adopted).toBe(true);
  });

  it('a live answer while another process holds the peer lock reports the pending turns the record holds', async () => {
    await touchLastClean();
    _setClaudeDriverForTesting(createMockDriver());
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    await writeHeadless({
      projectId: CALLER_PROJ,
      alias: 'peer1',
      claudeSessionId: 'sid-050',
      cwd: '/abs/peer1',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: new Date().toISOString(),
      turnCount: 3,
      origin: 'headless',
      rememberedTurn: 1,
      adopted: true,
    });
    await holdForeignLock(paths.headlessLockFor(CALLER_PROJ, 'peer1'));
    await writeManifest({
      sessionId: 'lst-live',
      claudeSessionId: 'claude-uuid-live',
      projectPath: '/abs/peer1',
      projectName: 'peer1',
      alias: 'peer1',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'registered',
      pid: process.pid,
    });
    await setStatus('lst-live', 'listening');

    const askPromise = routeAsk({
      peerRef: 'peer1',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
      timeoutMs: 2000,
    });
    const queue = await import('../../src/routing/queue.js');
    const fs = await import('node:fs/promises');
    await new Promise((r) => setTimeout(r, 80));
    let msgId: string | undefined;
    for (const dir of [paths.sessionInbox('lst-live'), paths.sessionInboxInProgress('lst-live')]) {
      const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
      if (files.length > 0) {
        msgId = JSON.parse(await fs.readFile(`${dir}/${files[0]}`, 'utf8')).id;
        break;
      }
    }
    await queue.sendMessage({
      fromSessionId: 'lst-live',
      fromProject: 'peer1',
      toSessionId: FROM_SESSION,
      type: 'response',
      content: 'live answer',
      inReplyTo: msgId!,
    });
    const result = await askPromise;

    expect(result.tier).toBe('live');
    const record = await readHeadless(CALLER_PROJ, 'peer1');
    expect(record?.turnCount).toBe(3);
    expect(result.pending).toBe(record!.turnCount - record!.rememberedTurn!);
  });

  it('a first ask answered live adopts the 0.5.0 conversation before the listener takes the record', async () => {
    await touchLastClean();
    _setClaudeDriverForTesting(createMockDriver());
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    const lastUsedAt = new Date(Date.now() - 60_000).toISOString();
    await writeHeadless({
      projectId: CALLER_PROJ,
      alias: 'peer1',
      claudeSessionId: 'sid-050',
      cwd: '/abs/peer1',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt,
      turnCount: 44,
      origin: 'headless',
    });
    await writeManifest({
      sessionId: 'lst-live',
      claudeSessionId: 'claude-uuid-live',
      projectPath: '/abs/peer1',
      projectName: 'peer1',
      alias: 'peer1',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'registered',
      pid: process.pid,
    });
    await setStatus('lst-live', 'listening');

    const askPromise = routeAsk({
      peerRef: 'peer1',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
      timeoutMs: 2000,
    });
    const queue = await import('../../src/routing/queue.js');
    const fs = await import('node:fs/promises');
    await new Promise((r) => setTimeout(r, 80));
    let msgId: string | undefined;
    for (const dir of [paths.sessionInbox('lst-live'), paths.sessionInboxInProgress('lst-live')]) {
      const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
      if (files.length > 0) {
        msgId = JSON.parse(await fs.readFile(`${dir}/${files[0]}`, 'utf8')).id;
        break;
      }
    }
    await queue.sendMessage({
      fromSessionId: 'lst-live',
      fromProject: 'peer1',
      toSessionId: FROM_SESSION,
      type: 'response',
      content: 'live answer',
      inReplyTo: msgId!,
    });
    expect((await askPromise).tier).toBe('live');

    const id = createHash('sha1').update('sid-050').digest('hex').slice(0, 6);
    expect(await readThread(CALLER_PROJ, 'peer1', id)).toMatchObject({ claudeSessionId: 'sid-050', turnCount: 44, lastUsedAt });
    expect(await readHeadless(CALLER_PROJ, 'peer1')).toMatchObject({
      claudeSessionId: 'claude-uuid-live',
      origin: 'live',
      adopted: true,
    });
  });
});

describe.each<[string, PeerConfig]>([
  ['a project peer', { path: '/abs/advisor' }],
  ['a persona', { path: '/abs/advisor', type: 'persona' }],
])('routeAsk to %s', (_kind, config) => {
  const t = setup();
  let mock: ReturnType<typeof createMockDriver>;
  beforeEach(async () => {
    await t.before();
    await registerCaller();
    let n = 0;
    mock = createMockDriver({ output: 'a', sessionId: () => `sid-${++n}` });
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { advisor: config } });
  });
  afterEach(async () => {
    _setClaudeDriverForTesting(null);
    await t.after();
  });

  const ask = (thread?: string) =>
    routeAsk({
      peerRef: 'advisor',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
      thread,
    });

  it('a second ask starts a fresh session', async () => {
    const first = await ask();
    const second = await ask();

    expect(first.tier).toBe('headless-fresh');
    expect(second.tier).toBe('headless-fresh');
    expect(mock.invocations[1].sessionId).toBeUndefined();
    expect(second.thread).not.toBe(first.thread);
    expect((await readHeadless(CALLER_PROJ, 'advisor'))?.turnCount).toBe(2);
  });

  it('an ask leaves the session the per-peer record names alone', async () => {
    await writeHeadless({
      projectId: CALLER_PROJ,
      alias: 'advisor',
      claudeSessionId: 'sid-continuous',
      cwd: '/abs/advisor',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: '2026-01-01T00:00:00Z',
      turnCount: 5,
    });

    await ask();

    expect(mock.invocations[0].sessionId).toBeUndefined();
    const record = await readHeadless(CALLER_PROJ, 'advisor');
    expect(record?.claudeSessionId).toBe('sid-continuous');
    expect(record?.turnCount).toBe(6);
  });

  it('an ask to a peer without a record names no session in it', async () => {
    await ask();
    await ask();

    const record = await readHeadless(CALLER_PROJ, 'advisor');
    expect(record?.claudeSessionId).toBe('');
    expect(record?.turnCount).toBe(2);
  });

  it('an ask with the thread of an earlier answer resumes that session', async () => {
    const first = await ask();
    await ask();
    const followUp = await ask(first.thread);

    expect(followUp.tier).toBe('headless-resumed');
    expect(followUp.thread).toBe(first.thread);
    expect(mock.invocations[2].sessionId).toBe('sid-1');
  });

  it('refuses a thread it does not know, before any spawn', async () => {
    await expect(ask('nope42')).rejects.toThrow(/no thread "nope42"/);
    await expect(ask('../../etc')).rejects.toThrow(/no thread/);
    expect(mock.invocations).toHaveLength(0);
  });

  it('an ask with a thread continues it headless, also when a listener is live', async () => {
    const first = await ask();
    await writeManifest({
      sessionId: 'listen1',
      claudeSessionId: null,
      projectPath: '/abs/advisor',
      projectName: 'advisor',
      alias: 'advisor',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'registered',
      pid: process.pid,
    });
    await setStatus('listen1', 'listening');

    const followUp = await ask(first.thread);

    expect(followUp.tier).toBe('headless-resumed');
    expect(mock.invocations[1].sessionId).toBe('sid-1');
  });

  it('a resume that fails starts fresh and keeps the thread', async () => {
    const first = await ask();
    mock.configure({ output: 'recovered', sessionId: 'sid-new', throwOn: [1] });

    const result = await ask(first.thread);

    expect(result.tier).toBe('headless-fresh');
    expect(result.thread).toBe(first.thread);
    expect(mock.invocations[2].sessionId).toBeUndefined();
    expect((await ask(first.thread)).tier).toBe('headless-resumed');
    expect(mock.invocations[3].sessionId).toBe('sid-new');
  });

  it('continues a 0.5.0 conversation by the thread the sweep adopted it as', async () => {
    await writeHeadless({
      projectId: CALLER_PROJ,
      alias: 'advisor',
      claudeSessionId: 'sid-050',
      cwd: '/abs/advisor',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: new Date().toISOString(),
      turnCount: 44,
      origin: 'headless',
    });
    await sweep();

    const result = await ask(createHash('sha1').update('sid-050').digest('hex').slice(0, 6));

    expect(result.tier).toBe('headless-resumed');
    expect(mock.invocations[0].sessionId).toBe('sid-050');
  });

  it('a first ask adopts a 0.5.0 conversation with its own turn count, and every later turn keeps the marker', async () => {
    await touchLastClean();
    const lastUsedAt = new Date(Date.now() - 60_000).toISOString();
    await writeHeadless({
      projectId: CALLER_PROJ,
      alias: 'advisor',
      claudeSessionId: 'sid-050',
      cwd: '/abs/advisor',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt,
      turnCount: 44,
      origin: 'headless',
    });
    const id = createHash('sha1').update('sid-050').digest('hex').slice(0, 6);

    await ask();

    expect(await readThread(CALLER_PROJ, 'advisor', id)).toMatchObject({ turnCount: 44, lastUsedAt });
    expect(await readHeadless(CALLER_PROJ, 'advisor')).toMatchObject({ turnCount: 45, adopted: true });

    await ask();

    expect(await readHeadless(CALLER_PROJ, 'advisor')).toMatchObject({ turnCount: 46, adopted: true });
    expect((await readThread(CALLER_PROJ, 'advisor', id))?.turnCount).toBe(44);
  });

  it('an ask returns its answer and thread within seconds while another process holds the per-peer lock', async () => {
    await holdForeignLock(paths.headlessLockFor(CALLER_PROJ, 'advisor'));

    const started = Date.now();
    const result = await ask();

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.answer).toBe('a');
    expect(result.thread).toMatch(/^[a-z0-9]{6}$/);
    expect((await readThread(CALLER_PROJ, 'advisor', result.thread!))?.claudeSessionId).toBe('sid-1');
    expect(await readFile(paths.logFor(CALLER_PROJ, 'advisor'), 'utf8')).toContain(`· thread ${result.thread}`);
    expect(await readHeadless(CALLER_PROJ, 'advisor')).toBeNull();
    expect(result.pending).toBe(0);
  }, 40_000);

  it('an ask whose thread another ask holds waits up to its own timeout', async () => {
    await writeThread(CALLER_PROJ, 'advisor', {
      thread: 'k3x9qa',
      claudeSessionId: 'sid-k3',
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 1,
    });
    await holdForeignLock(paths.threadLockFor(CALLER_PROJ, 'advisor', 'k3x9qa'));

    const started = Date.now();
    const result = routeAsk({
      peerRef: 'advisor',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
      thread: 'k3x9qa',
      timeoutMs: 500,
    });

    await expect(result).rejects.toThrow(/timed out acquiring lock/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(mock.invocations).toHaveLength(0);
  }, 40_000);

  it('two asks on one thread at once both answer, one spawn after the other', async () => {
    const first = await ask();
    const spans: [number, number][] = [];
    _setClaudeDriverForTesting({
      ...mock,
      async spawn(opts) {
        const start = Date.now();
        await new Promise((r) => setTimeout(r, 300));
        const out = await mock.spawn(opts);
        spans.push([start, Date.now()]);
        return out;
      },
    });

    const results = await Promise.all([ask(first.thread), ask(first.thread)]);

    expect(results.map((r) => r.thread)).toEqual([first.thread, first.thread]);
    expect(spans).toHaveLength(2);
    const [a, b] = spans.sort((x, y) => x[0] - y[0]);
    expect(b[0]).toBeGreaterThanOrEqual(a[1]);
    expect((await readThread(CALLER_PROJ, 'advisor', first.thread!))?.turnCount).toBe(3);
  });

  it('an unreadable thread file at the adopted id leaves the ask and the record alone', async () => {
    await writeHeadless({
      projectId: CALLER_PROJ,
      alias: 'advisor',
      claudeSessionId: 'sid-050',
      cwd: '/abs/advisor',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: new Date().toISOString(),
      turnCount: 44,
      origin: 'headless',
    });
    const id = createHash('sha1').update('sid-050').digest('hex').slice(0, 6);
    await mkdir(paths.threadsDirFor(CALLER_PROJ, 'advisor'), { recursive: true });
    await writeFile(paths.threadFor(CALLER_PROJ, 'advisor', id), '{ not json');

    expect(await adoptConversation(CALLER_PROJ, 'advisor')).toBeNull();
    const result = await ask();

    expect(result.answer).toBe('a');
    expect(await readHeadless(CALLER_PROJ, 'advisor')).toMatchObject({ turnCount: 45 });
  });

  it('a record too old to adopt stays unadopted after an ask brings its last use up to date', async () => {
    await writeHeadless({
      projectId: CALLER_PROJ,
      alias: 'advisor',
      claudeSessionId: 'sid-050',
      cwd: '/abs/advisor',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      turnCount: 44,
      origin: 'headless',
    });
    const id = createHash('sha1').update('sid-050').digest('hex').slice(0, 6);

    await ask();

    expect(await adoptConversation(CALLER_PROJ, 'advisor')).toBeNull();
    expect(await readThread(CALLER_PROJ, 'advisor', id)).toBeNull();
    expect(await readHeadless(CALLER_PROJ, 'advisor')).toMatchObject({ adopted: true, turnCount: 45 });
  });

  it('a headless turn keeps a live record live, so the sweep never adopts a listener session', async () => {
    await writeHeadless({
      projectId: CALLER_PROJ,
      alias: 'advisor',
      claudeSessionId: 'claude-listener',
      cwd: '/abs/advisor',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: new Date().toISOString(),
      turnCount: 3,
      origin: 'live',
    });

    await ask();
    const result = await sweep();

    expect((await readHeadless(CALLER_PROJ, 'advisor'))?.origin).toBe('live');
    expect(result.adopted).toEqual([]);
  });
});

describe('routeAsk extension peers', () => {
  const t = setup();
  beforeEach(async () => {
    await t.before();
    await registerCaller();
  });
  afterEach(async () => {
    _setClaudeDriverForTesting(null);
    await t.after();
  });

  // Use a real directory so the lazy auto-clean (which prunes manifests whose
  // peer paths are all missing on disk) doesn't delete it between asks.
  async function writePersonasManifest(): Promise<string> {
    const stevePath = join(t.tmp.root, 'steve-plugin');
    await mkdir(stevePath, { recursive: true });
    await mkdir(paths.extensionsDir, { recursive: true });
    await writeFile(
      join(paths.extensionsDir, 'personas.json'),
      JSON.stringify({
        name: 'personas',
        peers: [
          { alias: 'steve-jobs', path: stevePath, type: 'persona', model: 'opus', skipPermissions: true },
          { alias: 'steve', path: stevePath, type: 'persona', model: 'opus', skipPermissions: true },
          { alias: 'jobs', path: stevePath, type: 'persona', model: 'opus', skipPermissions: true },
        ],
      }),
    );
    return stevePath;
  }

  it('passes model/skipPermissions/cwd from the manifest to the driver', async () => {
    const mock = createMockDriver({ output: 'a', sessionId: 'sid-1' });
    _setClaudeDriverForTesting(mock);
    const stevePath = await writePersonasManifest();

    await routeAsk({
      peerRef: 'steve',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });

    expect(mock.invocations[0].model).toBe('opus');
    expect(mock.invocations[0].skipPermissions).toBe(true);
    expect(mock.invocations[0].cwd).toBe(stevePath);
  });

  it('continues a thread regardless of which alias is used', async () => {
    const mock = createMockDriver({ output: 'a', sessionId: 'sid-shared' });
    _setClaudeDriverForTesting(mock);
    await writePersonasManifest();

    const r1 = await routeAsk({
      peerRef: 'jobs',
      question: 'q1',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });
    expect(r1.alias).toBe('steve-jobs');
    expect(r1.tier).toBe('headless-fresh');

    const r2 = await routeAsk({
      peerRef: 'steve',
      question: 'q2',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
      thread: r1.thread,
    });
    expect(r2.alias).toBe('steve-jobs');
    expect(r2.tier).toBe('headless-resumed');
    expect(mock.invocations[1].sessionId).toBe('sid-shared');

    const canonical = await readHeadless(CALLER_PROJ, 'steve-jobs');
    expect(canonical?.turnCount).toBe(2);
    expect(await readHeadless(CALLER_PROJ, 'steve')).toBeNull();
    expect(await readHeadless(CALLER_PROJ, 'jobs')).toBeNull();
  });
});
