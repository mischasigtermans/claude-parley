import {
  findPeerInFile,
  PeerConfig,
  PeersFile,
  readPeers,
} from '../registry/peers.js';
import { readExtensions } from '../registry/extensions.js';
import {
  findListeningByPath,
  listLiveSessions,
  readManifest,
  SessionManifest,
} from '../registry/sessions.js';
import { readHeadless, writeHeadless, HeadlessRecord } from '../registry/headless.js';
import { withLock } from '../registry/locks.js';
import { paths, expandHome, type ProjectId } from '../registry/paths.js';
import { getClaudeDriver } from '../drivers/claude.js';
import { readParleyConfig, type Fallback } from '../config.js';
import { sendMessage, waitForMessage, findInboxStatus } from './queue.js';
import { appendTurn } from './transcript.js';
import { errorMessage } from '../util/errors.js';

export type Tier = 'live' | 'headless-resumed' | 'headless-fresh';

const ASK_TIMEOUT_DEFAULT_MS = 30 * 60 * 1000;

function askTimeoutMs(): number {
  const raw = process.env.PARLEY_ASK_TIMEOUT_MS;
  if (!raw) return ASK_TIMEOUT_DEFAULT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : ASK_TIMEOUT_DEFAULT_MS;
}

export interface AskInput {
  peerRef: string;
  question: string;
  fromSessionId: string;
  fromProject: string;
  fromProjectId: ProjectId;
  timeoutMs?: number;
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
  const effectiveTimeoutMs = input.timeoutMs ?? askTimeoutMs();
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

  // Load the asker's cached session pointer for this peer up front. Used to:
  //   1. Pick the matching live listener when multiple are present (B3).
  //   2. Write the listener's claudeSessionId back into the cache after a live
  //      answer succeeds, so the next ask (live or headless) can --resume the
  //      same thread (B2).
  const pointer = await readHeadless(input.fromProjectId, peer.alias);

  const live = await resolveListening(
    peer.alias,
    peer.config,
    peer.sessionId,
    input.fromSessionId,
    pointer?.claudeSessionId,
  );
  switch (live.kind) {
    case 'single': {
      const answer = await routeLive({ ...input, target: live.session, timeoutMs: effectiveTimeoutMs });
      await appendTurn(input.fromProjectId, peer.alias, input.fromProject, input.question, answer, 'live');
      if (live.session.claudeSessionId) {
        await updatePointerToLive({
          pointer,
          peer,
          fromProjectId: input.fromProjectId,
          claudeSessionId: live.session.claudeSessionId,
        });
      }
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

  // No listener (or 'none' fallthrough from switch). Resolve fallback policy.
  const config = await readParleyConfig();
  const fallback: Fallback = config.fallback;

  if (fallback === 'ask') {
    throw new Error(noListenerMessage(peer.alias));
  }

  // fallback === 'headless' (default): spawn `claude -p` with --resume from pointer.
  const cwd = expandHome(peer.config.path);
  const driver = getClaudeDriver();

  const wrappedPrompt = CONCISE_PREAMBLE + input.question;

  const model = peer.config.model;
  const mcpServers = peer.config.mcpServers ?? {};
  // Per-peer `skipPermissions` wins; otherwise fall back to config.skipDefault.
  const skipPermissions = peer.config.skipPermissions ?? config.skipDefault;

  return withLock(paths.headlessLockFor(input.fromProjectId, peer.alias), async () => {
    // Use the pointer we already loaded above; re-read under the lock to
    // pick up any writes that landed between the initial read and now.
    const cached = await readHeadless(input.fromProjectId, peer.alias);
    let tier: Tier;
    let result;

    const baseSpawn = {
      cwd,
      prompt: wrappedPrompt,
      timeoutMs: effectiveTimeoutMs,
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
      projectId: input.fromProjectId,
      alias: peer.alias,
      claudeSessionId: result.sessionId,
      cwd,
      createdAt: cached?.createdAt ?? now,
      lastUsedAt: now,
      turnCount: (cached?.turnCount ?? 0) + 1,
      origin: 'headless',
    };
    await writeHeadless(next);
    await appendTurn(input.fromProjectId, peer.alias, input.fromProject, input.question, result.output, tier);
    return { alias: peer.alias, tier, answer: result.output };
  });
}

/**
 * Update the asker's session pointer to reflect the most recent live response.
 * The next ask (live or headless) can --resume the same claude session,
 * keeping the conversation continuous across transports.
 */
async function updatePointerToLive(opts: {
  pointer: HeadlessRecord | null;
  peer: { alias: string; config: PeerConfig };
  fromProjectId: ProjectId;
  claudeSessionId: string;
}): Promise<void> {
  // Single-user assumption: not lock-guarded. Two overlapping live replies
  // can race on turnCount/claudeSessionId. Acceptable for v0.3.0.
  const now = new Date().toISOString();
  const next: HeadlessRecord = {
    projectId: opts.fromProjectId,
    alias: opts.peer.alias,
    claudeSessionId: opts.claudeSessionId,
    cwd: expandHome(opts.peer.config.path),
    createdAt: opts.pointer?.createdAt ?? now,
    lastUsedAt: now,
    turnCount: (opts.pointer?.turnCount ?? 0) + 1,
    origin: 'live',
  };
  await writeHeadless(next);
}

function noListenerMessage(alias: string): string {
  return [
    `parley: no live listener for "${alias}" and fallback="ask". Background would draw from your Agent SDK credit pool (separate from interactive subscription).`,
    `Options:`,
    `  • Open the peer and run /parley listen, then retry to route live (zero SDK credit).`,
    `  • Spawn headless this once: set fallback="headless" in ~/.claude/parley/config.json or PARLEY_FALLBACK=headless.`,
  ].join('\n');
}

function canonicalExtensionAlias(
  extensions: { alias: string; path: string }[],
  extPeer: { alias: string; path: string },
): string {
  const first = extensions.find((p) => expandHome(p.path) === expandHome(extPeer.path));
  return first?.alias ?? extPeer.alias;
}

/**
 * Resolve a peer ref to the canonical alias used to key headless state
 * (cache, transcript, lock). Extension peers expose multiple aliases for one
 * path; all of them must map to a single key so the conversation stays
 * continuous regardless of which alias the caller typed. Falls back to the
 * typed alias when the ref doesn't match a registered peer.
 */
export async function canonicalAlias(ref: string): Promise<string> {
  const colonIdx = ref.indexOf(':');
  const aliasPart = colonIdx >= 0 ? ref.slice(0, colonIdx) : ref;

  const direct = findPeerInFile(aliasPart, await readPeers());
  if (direct) return direct.alias;

  const extensions = await readExtensions();
  const extPeer = extensions.find((p) => p.alias === aliasPart);
  if (extPeer) return canonicalExtensionAlias(extensions, extPeer);

  const live = await listLiveSessions();
  const match = live.find(
    (s) => s.alias === aliasPart || s.projectName === aliasPart || s.projectPath === expandHome(aliasPart),
  );
  return match?.alias ?? aliasPart;
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

  // Check extension-provided peers.
  // User-curated peers.json wins above; extensions can't shadow.
  const extensions = await readExtensions();
  const extPeer = extensions.find((p) => p.alias === aliasPart);
  if (extPeer) {
    return {
      // Key by the canonical alias (first manifest entry sharing this path), so
      // asking the same peer via any of its aliases resumes one session.
      alias: canonicalExtensionAlias(extensions, extPeer),
      config: {
        path: extPeer.path,
        description: extPeer.description,
        type: extPeer.type,
        model: extPeer.model,
        mcpServers: extPeer.mcpServers,
        skipPermissions: extPeer.skipPermissions,
      },
      sessionId: sessionId || undefined,
    };
  }

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
  preferredClaudeSessionId: string | null | undefined,
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

  // Multiple listeners. Prefer the one whose claudeSessionId matches the
  // asker's cached pointer (a thread continuation). Falls back to the
  // disambiguation error if none match.
  if (preferredClaudeSessionId) {
    const matched = sessions.find((s) => s.claudeSessionId === preferredClaudeSessionId);
    if (matched) return { kind: 'single', session: matched };
  }
  return { kind: 'multiple', sessions };
}

async function routeLive(opts: {
  question: string;
  target: SessionManifest;
  fromSessionId: string;
  fromProject: string;
  timeoutMs: number;
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
    { timeoutMs: opts.timeoutMs },
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
