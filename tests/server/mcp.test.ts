import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile, readFile, access, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from '../helpers/tmpdir.js';
import { paths } from '../../src/registry/paths.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const serverPath = join(repoRoot, 'dist', 'server.js');
const mockDriverPath = join(here, '..', 'helpers', 'mock-driver.cjs');

const SESSION_ID = 'tt0001';

interface Harness {
  child: ChildProcessWithoutNullStreams;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>;
  nextId: number;
  send(method: string, params?: unknown): Promise<any>;
  notify(method: string, params?: unknown): void;
  shutdown(): Promise<void>;
}

async function startHarness(opts: { parleyDir: string; mockConfigPath?: string }): Promise<Harness> {
  await access(serverPath); // fail fast if dist isn't built

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PARLEY_DIR: opts.parleyDir,
    PARLEY_SESSION_ID: SESSION_ID,
    PARLEY_DRIVER_OVERRIDE: mockDriverPath,
  };
  if (opts.mockConfigPath) env.PARLEY_MOCK_CONFIG = opts.mockConfigPath;

  const child = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  let nextId = 1;
  let stdoutBuf = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg: any;
      try {
        msg = JSON.parse(t);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const slot = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else slot.resolve(msg.result);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  // child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  function send(method: string, params: unknown = {}): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function notify(method: string, params: unknown = {}): void {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  // Initialize handshake
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  notify('notifications/initialized');

  return {
    child,
    pending,
    nextId,
    send,
    notify,
    async shutdown() {
      child.stdin.end();
      try {
        child.kill('SIGTERM');
      } catch {}
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', () => resolve());
        setTimeout(() => resolve(), 1000).unref();
      });
    },
  };
}

async function writeSessionManifest(parleyDir: string, sid: string, projectPath = '/abs/test') {
  const dir = join(parleyDir, 'sessions', sid);
  await mkdir(join(dir, 'inbox'), { recursive: true });
  await mkdir(join(dir, 'outbox'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      sessionId: sid,
      claudeSessionId: null,
      projectPath,
      projectName: 'test',
      alias: 'test',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'registered',
      pid: 0,
    }),
  );
}

function callContent(result: any): string {
  expect(result?.content?.[0]?.type).toBe('text');
  return String(result.content[0].text);
}

describe('MCP server harness', () => {
  const t = setup();
  let h: Harness | null = null;

  beforeEach(async () => {
    await t.before();
    await writeSessionManifest(t.tmp.root, SESSION_ID);
  });

  afterEach(async () => {
    if (h) {
      await h.shutdown();
      h = null;
    }
    await t.after();
  });

  it('lists all parley tools via tools/list', async () => {
    h = await startHarness({ parleyDir: t.tmp.root });
    const result = await h.send('tools/list');
    const names = (result.tools as any[]).map((t) => t.name).sort();
    expect(names).toEqual([
      'parley_add',
      'parley_ask',
      'parley_clean',
      'parley_discover',
      'parley_listen',
      'parley_log',
      'parley_peers',
      'parley_receive_next',
      'parley_remove',
      'parley_reset',
      'parley_respond',
    ]);
  });

  it('parley_peers shows discovered live sessions even when peers.json is empty', async () => {
    await writeSessionManifest(t.tmp.root, 'other1', '/abs/other');
    h = await startHarness({ parleyDir: t.tmp.root });
    const result = await h.send('tools/call', {
      name: 'parley_peers',
      arguments: {},
    });
    const text = callContent(result);
    expect(text).toMatch(/\| Peer \| Type \| Source \| Mode \| History \| Location \| Notes \|/);
    expect(text).toContain('test');
    expect(text).toMatch(/discovered/);
  });

  it('parley_peers shows one headless row per peer plus one listening row per /parley listen session', async () => {
    // Two listening sessions plus one registered (not listening) at the same path.
    for (const sid of ['lst001', 'lst002']) {
      await writeSessionManifest(t.tmp.root, sid, '/abs/multi');
      const manifestPath = join(t.tmp.root, 'sessions', sid, 'manifest.json');
      const m = JSON.parse(await readFile(manifestPath, 'utf8'));
      await writeFile(manifestPath, JSON.stringify({ ...m, status: 'listening' }));
    }
    await writeSessionManifest(t.tmp.root, 'reg001', '/abs/multi');

    h = await startHarness({ parleyDir: t.tmp.root });
    await h.send('tools/call', {
      name: 'parley_add',
      arguments: { alias: 'multi', path: '/abs/multi' },
    });

    const result = await h.send('tools/call', {
      name: 'parley_peers',
      arguments: {},
    });
    const text = callContent(result);
    expect(text).toMatch(/\| multi \| project \| [^|]+ \| headless \|/);
    expect(text).toContain('multi:lst001');
    expect(text).toContain('multi:lst002');
    expect(text).toMatch(/1 active window/);
  });

  it('parley_peers filters out the current session', async () => {
    h = await startHarness({ parleyDir: t.tmp.root });
    const result = await h.send('tools/call', {
      name: 'parley_peers',
      arguments: {},
    });
    const text = callContent(result);
    expect(text).not.toContain(SESSION_ID);
  });

  it('parley_peers includes a configured peer alongside discovered live sessions', async () => {
    h = await startHarness({ parleyDir: t.tmp.root });
    await h.send('tools/call', {
      name: 'parley_add',
      arguments: { alias: 'peer1', path: '/abs/peer1' },
    });
    const result = await h.send('tools/call', {
      name: 'parley_peers',
      arguments: {},
    });
    const text = callContent(result);
    expect(text).toContain('peer1');
    expect(text).toMatch(/\| headless \| -/);
  });

  it('parley_clean reports state and is idempotent', async () => {
    h = await startHarness({ parleyDir: t.tmp.root });
    await mkdir(join(t.tmp.root, 'by-claude-pid'), { recursive: true });
    await writeFile(join(t.tmp.root, 'by-claude-pid', '999999.session'), 'x');

    const first = await h.send('tools/call', { name: 'parley_clean', arguments: {} });
    const firstText = callContent(first);
    expect(firstText).toMatch(/Cleaned|Already clean/);
    expect(firstText).toMatch(/Last clean:/);

    const stateRaw = await readFile(join(t.tmp.root, 'state.json'), 'utf8');
    expect(JSON.parse(stateRaw).lastCleanAt).toBeTruthy();

    const second = await h.send('tools/call', { name: 'parley_clean', arguments: {} });
    expect(callContent(second)).toMatch(/Already clean/);
  });

  it('parley_clean dryRun does not touch state.json', async () => {
    h = await startHarness({ parleyDir: t.tmp.root });
    const result = await h.send('tools/call', {
      name: 'parley_clean',
      arguments: { dryRun: true },
    });
    expect(callContent(result)).toMatch(/Would clean|Nothing to clean/);
    await expect(readFile(join(t.tmp.root, 'state.json'), 'utf8')).rejects.toThrow();
  });

  it('parley_clean second call still reports "Already clean" (server auto-clean handles cooldown internally)', async () => {
    h = await startHarness({ parleyDir: t.tmp.root });
    await h.send('tools/call', { name: 'parley_clean', arguments: {} });
    const second = await h.send('tools/call', {
      name: 'parley_clean',
      arguments: {},
    });
    expect(callContent(second)).toMatch(/Already clean/);
  });

  it('parley_add → parley_remove round-trips through peers.json', async () => {
    h = await startHarness({ parleyDir: t.tmp.root });
    const added = await h.send('tools/call', {
      name: 'parley_add',
      arguments: { alias: 'foo', path: '/abs/foo' },
    });
    expect(callContent(added)).toMatch(/Added peer "foo"/);

    const peersJson = JSON.parse(await readFile(join(t.tmp.root, 'peers.json'), 'utf8'));
    expect(peersJson.peers.foo.path).toBe('/abs/foo');

    const removed = await h.send('tools/call', {
      name: 'parley_remove',
      arguments: { alias: 'foo' },
    });
    expect(callContent(removed)).toMatch(/Removed/);

    const removeAgain = await h.send('tools/call', {
      name: 'parley_remove',
      arguments: { alias: 'foo' },
    });
    expect(callContent(removeAgain)).toMatch(/No peer named/);
  });

  it('parley_ask routes to mock driver and caches the headless session', async () => {
    const mockCfg = join(t.tmp.root, 'mock.json');
    await writeFile(mockCfg, JSON.stringify({ output: 'mock-answer', sessionId: 'mock-sid' }));
    h = await startHarness({ parleyDir: t.tmp.root, mockConfigPath: mockCfg });

    await h.send('tools/call', {
      name: 'parley_add',
      arguments: { alias: 'peer1', path: '/abs/peer1' },
    });
    const ask = await h.send('tools/call', {
      name: 'parley_ask',
      arguments: { peer: 'peer1', question: 'hi' },
    });
    const text = callContent(ask);
    // v0.3.0: response prefix is just `[alias]`. Transport stays in the
    // transcript log only.
    expect(text).toMatch(/^\[peer1\]/);
    expect(text).toContain('mock-answer');

    // Server picks projectId based on its parent's CWD (the test runner's).
    // Walk headless/ to find the resulting file regardless of the hash.
    const projectDirs = await readdir(join(t.tmp.root, 'headless'));
    expect(projectDirs).toHaveLength(1);
    const headlessJson = JSON.parse(
      await readFile(join(t.tmp.root, 'headless', projectDirs[0], 'peer1.json'), 'utf8'),
    );
    expect(headlessJson.claudeSessionId).toBe('mock-sid');
    expect(headlessJson.projectId).toBe(projectDirs[0]);
  });

  it('parley_listen flips this session to listening status', async () => {
    h = await startHarness({ parleyDir: t.tmp.root });
    const result = await h.send('tools/call', { name: 'parley_listen', arguments: {} });
    expect(callContent(result)).toMatch(/Listening as test:/);

    const manifest = JSON.parse(
      await readFile(join(t.tmp.root, 'sessions', SESSION_ID, 'manifest.json'), 'utf8'),
    );
    expect(manifest.status).toBe('listening');
  });

  it('parley_receive_next returns a TIMEOUT marker when no messages arrive', async () => {
    h = await startHarness({ parleyDir: t.tmp.root });
    const result = await h.send('tools/call', {
      name: 'parley_receive_next',
      arguments: { timeoutMs: 500 },
    });
    expect(callContent(result)).toMatch(/TIMEOUT/);
  });

  it('parley_respond rejects sends to an unknown session (regression)', async () => {
    h = await startHarness({ parleyDir: t.tmp.root });
    const result = await h.send('tools/call', {
      name: 'parley_respond',
      arguments: {
        toSessionId: 'ghost',
        inReplyTo: 'msg-fake',
        content: 'should fail',
      },
    });
    expect(result.isError).toBe(true);
    expect(callContent(result)).toMatch(/not registered/);
  });

  it('parley_log returns empty-state when no transcript exists', async () => {
    h = await startHarness({ parleyDir: t.tmp.root });
    const result = await h.send('tools/call', {
      name: 'parley_log',
      arguments: { alias: 'peer1' },
    });
    expect(callContent(result)).toMatch(/No transcript yet/);
  });

  it('parley_reset is a graceful no-op when no headless cache exists', async () => {
    h = await startHarness({ parleyDir: t.tmp.root });
    const result = await h.send('tools/call', {
      name: 'parley_reset',
      arguments: { alias: 'peer1' },
    });
    expect(callContent(result)).toMatch(/No cached headless session/);
  });

  it('parley_peers pluralizes turn counts correctly (regression)', async () => {
    const mockCfg = join(t.tmp.root, 'mock.json');
    await writeFile(mockCfg, JSON.stringify({ output: 'ack', sessionId: 'mock-sid' }));
    h = await startHarness({ parleyDir: t.tmp.root, mockConfigPath: mockCfg });
    await h.send('tools/call', {
      name: 'parley_add',
      arguments: { alias: 'singleton', path: '/abs/singleton' },
    });
    await h.send('tools/call', {
      name: 'parley_add',
      arguments: { alias: 'plural', path: '/abs/plural' },
    });

    // Populate turn counts via real parley_ask round-trips so the server picks
    // its own projectId; we don't have to guess what lsof returns for the worker.
    await h.send('tools/call', {
      name: 'parley_ask',
      arguments: { peer: 'singleton', question: 'q1' },
    });
    for (let i = 1; i <= 7; i++) {
      await h.send('tools/call', {
        name: 'parley_ask',
        arguments: { peer: 'plural', question: `q${i}` },
      });
    }

    const result = await h.send('tools/call', { name: 'parley_peers', arguments: {} });
    const text = callContent(result);
    expect(text).toContain('1 turn');
    expect(text).not.toMatch(/\| 1 turns /);
    expect(text).toContain('7 turns');
  });
});
