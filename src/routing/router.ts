import {
  findPeerInFile,
  PeerConfig,
  PeersFile,
  readPeers,
  resolvePeerConfigFromFile,
} from '../registry/peers.js';
import {
  findListeningByPath,
  listLiveSessions,
  readManifest,
  SessionManifest,
} from '../registry/sessions.js';
import { readHeadless, writeHeadless, HeadlessRecord } from '../registry/headless.js';
import { withLock } from '../registry/locks.js';
import { paths, expandHome } from '../registry/paths.js';
import { getClaudeDriver } from '../drivers/claude.js';
import { sendMessage, waitForMessage, findInboxStatus } from './queue.js';
import { appendTurn } from './transcript.js';
import { errorMessage } from '../util/errors.js';

export type Tier = 'live' | 'headless-resumed' | 'headless-fresh';

export type AskMode = 'default' | 'deep';

export interface AskInput {
  peerRef: string;
  question: string;
  fromSessionId: string;
  fromProject: string;
  timeoutMs?: number;
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

  if (peer.sessionId && peer.sessionId === input.fromSessionId) {
    throw new Error(
      `parley: "${input.peerRef}" is this session. You cannot ask yourself. Use the current session's tools directly.`,
    );
  }

  const resolved = resolvePeerConfigFromFile(peer.alias, peersFile);
  const live = await resolveListening(peer.alias, peer.config, peer.sessionId, input.fromSessionId);
  switch (live.kind) {
    case 'single': {
      const answer = await routeLive({ ...input, target: live.session });
      await appendTurn(peer.alias, input.fromProject, input.question, answer, 'live');
      return { alias: peer.alias, tier: 'live', answer };
    }
    case 'multiple': {
      const sids = live.sessions.map((s) => `${peer.alias}:${s.sessionId}`).join(', ');
      throw new Error(
        `parley: ${live.sessions.length} listening sessions for "${peer.alias}". Retry with one of: ${sids}. Or omit the suffix to use headless.`,
      );
    }
    case 'sid-not-found':
      throw new Error(
        `parley: no live session "${live.sessionId}" for peer "${peer.alias}". Check parley_peers for current sids.`,
      );
    case 'sid-not-listening':
      throw new Error(
        `parley: session "${live.session.sessionId}" exists but is not in listen mode. Run /parley listen in that window, or ask "${peer.alias}" without the :sid suffix to use headless.`,
      );
    case 'none':
      break;
    default:
      live satisfies never;
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
): Promise<{ alias: string; config: PeerConfig; sessionId?: string } | null> {
  const colonIdx = ref.indexOf(':');
  const aliasPart = colonIdx >= 0 ? ref.slice(0, colonIdx) : ref;
  const sessionId = colonIdx >= 0 ? ref.slice(colonIdx + 1).trim() : undefined;

  const direct = findPeerInFile(aliasPart, peersFile);
  if (direct) return { ...direct, sessionId: sessionId || undefined };

  const live = await listLiveSessions();
  const match = live.find(
    (s) => s.alias === aliasPart || s.projectName === aliasPart || s.projectPath === expandHome(aliasPart),
  );
  if (match) {
    return {
      alias: match.alias,
      config: { path: match.projectPath },
      sessionId: sessionId || undefined,
    };
  }
  return null;
}

type ListeningResolution =
  | { kind: 'single'; session: SessionManifest }
  | { kind: 'multiple'; sessions: SessionManifest[] }
  | { kind: 'none' }
  | { kind: 'sid-not-found'; sessionId: string }
  | { kind: 'sid-not-listening'; session: SessionManifest };

async function resolveListening(
  _alias: string,
  config: PeerConfig,
  sessionId: string | undefined,
  fromSessionId: string,
): Promise<ListeningResolution> {
  const target = expandHome(config.path);
  if (sessionId) {
    const manifest = await readManifest(sessionId);
    if (!manifest || manifest.projectPath !== target) {
      return { kind: 'sid-not-found', sessionId };
    }
    if (manifest.status !== 'listening') {
      return { kind: 'sid-not-listening', session: manifest };
    }
    return { kind: 'single', session: manifest };
  }
  const sessions = (await findListeningByPath(target)).filter(
    (s) => s.sessionId !== fromSessionId,
  );
  if (sessions.length === 0) return { kind: 'none' };
  if (sessions.length === 1) return { kind: 'single', session: sessions[0] };
  return { kind: 'multiple', sessions };
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
    const status = await findInboxStatus(opts.target.sessionId, msgId);
    const hints: Record<string, string> = {
      pending: 'message never consumed (peer may have stopped listening)',
      'in-progress': 'peer consumed the query but has not responded yet (still working, or its agent stalled, recovery will retry)',
      read: 'peer marked the query read but no matching response landed',
    };
    const hint = (status && hints[status]) ?? 'message no longer in the peer inbox (pruned, or never delivered)';
    throw new Error(
      `parley: peer "${opts.target.alias}" did not respond within timeout. Status: ${hint}.`,
    );
  }
  return reply.content;
}
