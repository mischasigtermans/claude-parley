import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { makeContext } from './context.js';
import { tools } from './tools/index.js';
import { touchHeartbeat, updateManifest } from './registry/sessions.js';
import { pruneRead, recoverStuckInProgress } from './routing/queue.js';
import { getClaudeDriver } from './drivers/claude.js';
import { errorMessage } from './util/errors.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const PRUNE_OLDER_THAN_MS = 24 * 60 * 60 * 1000; // 24h
const RECOVER_STUCK_OLDER_THAN_MS = 10 * 60 * 1000; // 10m

async function main() {
  const ctx = makeContext();

  const server = new Server(
    { name: 'parley', version: '0.3.0' },
    { capabilities: { tools: {} } },
  );

  const byName = new Map(tools.map((t) => [t.name, t] as const));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      throw new Error(`parley: unknown tool "${request.params.name}"`);
    }
    try {
      const raw = request.params.arguments ?? {};
      const typed = tool.parseArgs ? tool.parseArgs(raw) : raw;
      const text = await tool.handler(typed, ctx);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: errorMessage(err) }],
      };
    }
  });

  const initialSid = ctx.getCurrentSessionId();
  if (initialSid) {
    await updateManifest(initialSid, (m) => {
      if (m.pid === process.pid) return null;
      return { ...m, pid: process.pid };
    });
  }

  const heartbeat = setInterval(() => {
    const sid = ctx.getCurrentSessionId();
    if (sid) {
      touchHeartbeat(sid).catch(() => {});
      pruneRead(sid, PRUNE_OLDER_THAN_MS).catch(() => {});
      recoverStuckInProgress(sid, RECOVER_STUCK_OLDER_THAN_MS).catch(() => {});
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    try {
      await getClaudeDriver().shutdown?.();
    } catch {
      // ignore, best-effort cleanup
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  const stack = err instanceof Error ? err.stack : undefined;
  process.stderr.write(`parley server crashed: ${stack ?? errorMessage(err)}\n`);
  process.exit(1);
});
