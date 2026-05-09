import {
  findPeerInFile,
  PeerConfig,
  PeersFile,
  readPeers,
  resolvePeerConfigFromFile,
} from '../registry/peers.js';
import { findLiveByPath, listLiveSessions, SessionManifest } from '../registry/sessions.js';
import { readHeadless, writeHeadless, HeadlessRecord } from '../registry/headless.js';
import { withLock } from '../registry/locks.js';
import { paths, expandHome } from '../registry/paths.js';
import { getClaudeDriver } from '../drivers/claude.js';
import { sendMessage, waitForMessage } from './queue.js';
import { appendTurn } from './transcript.js';
import { errorMessage } from '../util/errors.js';

export type Tier = 'live' | 'headless-resumed' | 'headless-fresh';

export type AskMode = 'default' | 'deep';

export interface AskInput {
  peerRef: string;
  question: string;
  fromSessionId: string;
  fromProject: string;
  fromProjectPath?: string;
  timeoutMs?: number;
  requireLive?: boolean;
  mode?: AskMode;
}

export interface AskResult {
  alias: string;
  tier: Tier;
  answer: string;
}

const CONCISE_PREAMBLE = `[parley directive: answer this query from a peer Claude Code session]
Be direct. Use the minimum number of tool calls needed to answer accurately. Do NOT explore the codebase tangentially, propose follow-ups, refactor, or add work the user did not ask for. Format your answer concisely.

`;

export async function routeAsk(input: AskInput): Promise<AskResult> {
  const peersFile = await readPeers();
  const peer = await resolvePeer(input.peerRef, peersFile);
  if (!peer) {
    throw new Error(
      `parley: peer "${input.peerRef}" not found. Add it with parley_add or check parley_peers.`,
    );
  }

  if (input.fromProjectPath && expandHome(peer.config.path) === input.fromProjectPath) {
    throw new Error(
      `parley: "${peer.alias}" resolves to the current session. You cannot ask yourself. Use the current session's tools directly.`,
    );
  }

  const resolved = resolvePeerConfigFromFile(peer.alias, peersFile);
  const live = await findListeningPeer(peer.alias, peer.config);
  if (live) {
    const answer = await routeLive({
      ...input,
      target: live,
    });
    await appendTurn(peer.alias, input.fromProject, input.question, answer, 'live');
    return { alias: peer.alias, tier: 'live', answer };
  }

  if (input.requireLive) {
    throw new Error(
      `parley: peer "${peer.alias}" is not in listen mode. Run \`/parley listen\` in that session, or omit requireLive to fall back to headless.`,
    );
  }

  const cwd = expandHome(peer.config.path);
  const driver = getClaudeDriver();

  const mode: AskMode = input.mode ?? 'default';
  const wrappedPrompt = mode === 'deep' ? input.question : CONCISE_PREAMBLE + input.question;

  const model = resolved?.resolvedModel ?? peersFile.defaults?.model;
  const mcpServers = resolved?.resolvedMcpServers ?? {};
  const skipPermissions = resolved?.resolvedSkipPermissions ?? peer.config.skipPermissions ?? true;

  return withLock(paths.headlessLockFor(peer.alias), async () => {
    const cached = await readHeadless(peer.alias);
    let tier: Tier;
    let result;

    const baseSpawn = {
      cwd,
      prompt: wrappedPrompt,
      timeoutMs: input.timeoutMs,
      skipPermissions,
      model,
      mcpServers,
    };

    if (cached) {
      try {
        result = await driver.spawn({ ...baseSpawn, sessionId: cached.claudeSessionId });
        tier = 'headless-resumed';
      } catch (err) {
        process.stderr.write(
          `parley: resume failed for "${peer.alias}", falling back to fresh: ${errorMessage(err)}\n`,
        );
        result = await driver.spawn(baseSpawn);
        tier = 'headless-fresh';
      }
    } else {
      result = await driver.spawn(baseSpawn);
      tier = 'headless-fresh';
    }

    const now = new Date().toISOString();
    const next: HeadlessRecord = {
      alias: peer.alias,
      claudeSessionId: result.sessionId,
      cwd,
      createdAt: cached?.createdAt ?? now,
      lastUsedAt: now,
      turnCount: (cached?.turnCount ?? 0) + 1,
    };
    await writeHeadless(next);
    await appendTurn(peer.alias, input.fromProject, input.question, result.output, tier);
    return { alias: peer.alias, tier, answer: result.output };
  });
}

async function resolvePeer(
  ref: string,
  peersFile: PeersFile,
): Promise<{ alias: string; config: PeerConfig } | null> {
  const direct = findPeerInFile(ref, peersFile);
  if (direct) return direct;

  const live = await listLiveSessions();
  const match = live.find(
    (s) => s.alias === ref || s.projectName === ref || s.projectPath === expandHome(ref),
  );
  if (match) {
    return {
      alias: match.alias,
      config: { path: match.projectPath },
    };
  }
  return null;
}

async function findListeningPeer(
  alias: string,
  config: PeerConfig,
): Promise<SessionManifest | null> {
  const target = expandHome(config.path);
  const live = await findLiveByPath(target);
  if (!live) return null;
  return live.status === 'listening' ? live : null;
}

async function routeLive(opts: {
  question: string;
  target: SessionManifest;
  fromSessionId: string;
  fromProject: string;
  timeoutMs?: number;
}): Promise<string> {
  const msgId = await sendMessage({
    fromSessionId: opts.fromSessionId,
    fromProject: opts.fromProject,
    toSessionId: opts.target.sessionId,
    type: 'query',
    content: opts.question,
  });
  const reply = await waitForMessage(
    opts.fromSessionId,
    (m) => m.type === 'response' && m.inReplyTo === msgId,
    { timeoutMs: opts.timeoutMs ?? 120_000 },
  );
  if (!reply) {
    throw new Error(
      `parley: peer "${opts.target.alias}" did not respond within timeout. They may have stopped listening.`,
    );
  }
  return reply.content;
}
