import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeManifest, setStatus } from '../../src/registry/sessions.js';
import { writePeers } from '../../src/registry/peers.js';
import { writeHeadless, readHeadless } from '../../src/registry/headless.js';
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

  it('tier-2 fresh: spawns headless and caches the resulting session', async () => {
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

    const cached = await readHeadless(CALLER_PROJ, 'peer1');
    expect(cached?.claudeSessionId).toBe('sid-fresh');
    expect(cached?.turnCount).toBe(1);
  });

  it('tier-3 resumed: passes cached sessionId and increments turnCount', async () => {
    const mock = createMockDriver({ output: 'a2', sessionId: 'sid-after' });
    _setClaudeDriverForTesting(mock);
    await writePeers({
      peers: { peer1: { path: '/abs/peer1' } },
    });
    await writeHeadless({
      projectId: CALLER_PROJ,
      alias: 'peer1',
      claudeSessionId: 'sid-before',
      cwd: '/abs/peer1',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: '2026-01-01T00:00:00Z',
      turnCount: 5,
    });

    const result = await routeAsk({
      peerRef: 'peer1',
      question: 'q3',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });

    expect(result.tier).toBe('headless-resumed');
    expect(mock.invocations[0].sessionId).toBe('sid-before');
    const cached = await readHeadless(CALLER_PROJ, 'peer1');
    expect(cached?.turnCount).toBe(6);
    expect(cached?.claudeSessionId).toBe('sid-after');
  });

  it('falls back from resume → fresh when the resumed spawn throws', async () => {
    const mock = createMockDriver({
      output: 'recovered',
      sessionId: 'sid-fresh-after-fail',
      throwOn: [0],
    });
    _setClaudeDriverForTesting(mock);
    await writePeers({ peers: { peer1: { path: '/abs/peer1' } } });
    await writeHeadless({
      projectId: CALLER_PROJ,
      alias: 'peer1',
      claudeSessionId: 'sid-stale',
      cwd: '/abs/peer1',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: '2026-01-01T00:00:00Z',
      turnCount: 1,
    });

    const result = await routeAsk({
      peerRef: 'peer1',
      question: 'q',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });

    expect(result.tier).toBe('headless-fresh');
    expect(result.answer).toBe('recovered');
    expect(mock.invocations).toHaveLength(2);
    expect(mock.invocations[0].sessionId).toBe('sid-stale');
    expect(mock.invocations[1].sessionId).toBeUndefined();
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

    await routeAsk({
      peerRef: 'peer1',
      question: 'archive me',
      fromSessionId: FROM_SESSION,
      fromProject: 'caller',
      fromProjectId: CALLER_PROJ,
    });

    const log = await readFile(paths.logFor(CALLER_PROJ, 'peer1'), 'utf8');
    expect(log).toContain('archive me');
    expect(log).toContain('recorded');
    expect(log).toContain('headless-fresh');
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

  it('keys one session per peer regardless of which alias is used', async () => {
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
