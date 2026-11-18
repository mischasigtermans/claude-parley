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
import {
  adoptConversation,
  withPeerLockOrSkip,
  readHeadless,
  writeHeadless,
  readThread,
  writeThread,
  newThreadId,
  HeadlessRecord,
} from '../registry/headless.js';
import { withLock } from '../registry/locks.js';
import { paths, expandHome, type ProjectId } from '../registry/paths.js';
import { getClaudeDriver, type SpawnResult } from '../drivers/claude.js';
import { readParleyConfig, memoryEnabledFor, type Fallback } from '../config.js';
import { readMemory } from '../registry/memory.js';
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
  /** Continue this earlier conversation. Without it the ask starts a fresh one. */
  thread?: string;
}

export interface AskResult {
  alias: string;
  tier: Tier;
  answer: string;
  /** Turns accumulated since the last parley_remember (turnCount - rememberedTurn). */
  pending: number;
  /** Set for a headless answer: pass it back as `thread` to continue the conversation. */
  thread?: string;
}

export class UnknownThreadError extends Error {
  constructor(thread: string, alias: string) {
    super(
      `parley: no thread "${thread}" with "${alias}" in this project. Leave thread out to start a fresh conversation.`,
    );
  }
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

  // The per-peer record names the listener that answered last, which picks the
  // matching one when several are listening (B3).
  const pointer = await readHeadless(input.fromProjectId, peer.alias);

  // A thread is a headless conversation: an ask that names one continues it there.
  const live: ListeningResolution = input.thread
    ? { kind: 'none' }
    : await resolveListening(peer.alias, peer.config, peer.sessionId, input.fromSessionId, pointer?.claudeSessionId);
  switch (live.kind) {
    case 'single': {
      const answer = await routeLive({ ...input, target: live.session, timeoutMs: effectiveTimeoutMs });
      await appendTurn(input.fromProjectId, peer.alias, input.fromProject, input.question, answer, 'live');
      // The listener's session replaces the one the record names, so adopt
      // that conversation first or it can't be reached again.
      const listener = live.session.claudeSessionId;
      const counted = listener
        ? await withPeerLockOrSkip(input.fromProjectId, peer.alias, async () => {
            await adoptConversation(input.fromProjectId, peer.alias);
            return updatePointerToLive({
              pointer: await readHeadless(input.fromProjectId, peer.alias),
              peer,
              fromProjectId: input.fromProjectId,
              claudeSessionId: listener,
            });
          })
        : undefined;
      const record = counted ?? (await readHeadless(input.fromProjectId, peer.alias));
      const pending = record ? record.turnCount - (record.rememberedTurn ?? 0) : 0;
      return { alias: peer.alias, tier: 'live', answer, pending };
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
    if (input.thread) {
      throw new Error(
        `parley: thread "${input.thread}" continues headless, which fallback="ask" doesn't allow. Set fallback="headless" in ~/.claude/parley/config.json or PARLEY_FALLBACK=headless.`,
      );
    }
    throw new Error(noListenerMessage(peer.alias));
  }

  // fallback === 'headless' (default): spawn `claude -p`, with --resume for the thread the ask names.
  const cwd = expandHome(peer.config.path);
  const driver = getClaudeDriver();

  const memoryOn = memoryEnabledFor(config, peer.alias, peer.config.memory);
  const memory = memoryOn ? await readMemory(input.fromProjectId, peer.alias) : '';
  const memoryBlock = memory.trim()
    ? `[your memory from past conversations with this project]\n${memory.trim()}\n\n`
    : '';
  const wrappedPrompt = CONCISE_PREAMBLE + memoryBlock + input.question;

  const model = peer.config.model;
  const mcpServers = peer.config.mcpServers ?? {};
  // Per-peer `skipPermissions` wins; otherwise fall back to config.skipDefault.
  const skipPermissions = peer.config.skipPermissions ?? config.skipDefault;

  const baseSpawn = {
    cwd,
    prompt: wrappedPrompt,
    timeoutMs: effectiveTimeoutMs,
    skipPermissions,
    model,
    mcpServers,
  };

  const spawn = async (resume: string | undefined): Promise<{ tier: Tier; result: SpawnResult }> => {
    if (resume) {
      try {
        return { tier: 'headless-resumed', result: await driver.spawn({ ...baseSpawn, sessionId: resume }) };
      } catch (err) {
        process.stderr.write(
          `parley: resume failed for "${peer.alias}", falling back to fresh: ${errorMessage(err)}\n`,
        );
      }
    }
    return { tier: 'headless-fresh', result: await driver.spawn(baseSpawn) };
  };

  const thread = input.thread ?? newThreadId();
  if (input.thread && !(await readThread(input.fromProjectId, peer.alias, thread))) {
    throw new UnknownThreadError(thread, peer.alias);
  }

  const { tier, result } = await withLock(
    paths.threadLockFor(input.fromProjectId, peer.alias, thread),
    async () => {
      const earlier = input.thread ? await readThread(input.fromProjectId, peer.alias, thread) : null;
      const turn = await spawn(earlier?.claudeSessionId);
      const now = new Date().toISOString();
      await writeThread(input.fromProjectId, peer.alias, {
        thread,
        claudeSessionId: turn.result.sessionId,
        createdAt: earlier?.createdAt ?? now,
        lastUsedAt: now,
        turnCount: (earlier?.turnCount ?? 0) + 1,
      });
      return turn;
    },
    // Held across a spawn, so a second ask on this thread waits as long as it would for its own answer.
    { timeoutMs: effectiveTimeoutMs },
  );

  await appendTurn(input.fromProjectId, peer.alias, input.fromProject, input.question, result.output, tier, thread);

  // The per-peer record counts turns and names the listener the live tier
  // matches. A turn never puts its own session there, and keeps a live record
  // live: a 0.5.0 server on the same state folder resumes whatever a headless
  // record names, and that session is adopted as a thread. Adopting before
  // this turn counts gives the thread the record's own turn count. The answer
  // is already paid for, so a 0.5.0 spawn holding the lock skips the count
  // rather than losing it.
  const counted = await withPeerLockOrSkip(input.fromProjectId, peer.alias, async () => {
    await adoptConversation(input.fromProjectId, peer.alias);
    const earlier = await readHeadless(input.fromProjectId, peer.alias);
    const now = new Date().toISOString();
    const next: HeadlessRecord = {
      projectId: input.fromProjectId,
      alias: peer.alias,
      claudeSessionId: earlier?.claudeSessionId ?? '',
      cwd,
      createdAt: earlier?.createdAt ?? now,
      lastUsedAt: now,
      turnCount: (earlier?.turnCount ?? 0) + 1,
      origin: earlier?.origin ?? 'headless',
      rememberedTurn: earlier?.rememberedTurn,
      adopted: earlier?.adopted,
    };
    await writeHeadless(next);
    return next;
  });
  const record = counted ?? (await readHeadless(input.fromProjectId, peer.alias));
  const pending = record ? record.turnCount - (record.rememberedTurn ?? 0) : 0;
  return { alias: peer.alias, tier, answer: result.output, pending, thread };
}

/**
 * Count a live answer in the asker's per-peer record and name the listener
 * that gave it, so the next ask picks that listener when several are listening.
 * Call under the per-peer lock.
 */
async function updatePointerToLive(opts: {
  pointer: HeadlessRecord | null;
  peer: { alias: string; config: PeerConfig };
  fromProjectId: ProjectId;
  claudeSessionId: string;
}): Promise<HeadlessRecord> {
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
    rememberedTurn: opts.pointer?.rememberedTurn,
    adopted: opts.pointer?.adopted,
  };
  await writeHeadless(next);
  return next;
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
 * (record, threads, transcript, locks). Extension peers expose multiple aliases
 * for one path; all of them must map to a single key so a thread continues
 * regardless of which alias the caller typed. Falls back to the
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

/**
 * The peer's own declared memory flag (from peers.json or an extension
 * manifest), or undefined if unset. `alias` must be canonical.
 */
async function declaredMemoryFlag(alias: string): Promise<boolean | undefined> {
  const direct = findPeerInFile(alias, await readPeers());
  if (direct) return direct.config.memory;
  const ext = (await readExtensions()).find((p) => p.alias === alias);
  return ext?.memory;
}

/**
 * Resolve whether durable memory is enabled for a peer (canonical alias),
 * applying config override → declared flag → config default. Used by the
 * parley_remember tool; routeAsk resolves inline from its already-read config.
 */
export async function isMemoryEnabled(alias: string): Promise<boolean> {
  const config = await readParleyConfig();
  return memoryEnabledFor(config, alias, await declaredMemoryFlag(alias));
}

/** Whether `ref` resolves to a registered peer, an extension peer, or a live session. */
export async function peerExists(ref: string): Promise<boolean> {
  return (await resolvePeer(ref, await readPeers())) !== null;
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
      // asking the same peer via any of its aliases shares its threads.
      alias: canonicalExtensionAlias(extensions, extPeer),
      config: {
        path: extPeer.path,
        description: extPeer.description,
        type: extPeer.type,
        model: extPeer.model,
        mcpServers: extPeer.mcpServers,
        skipPermissions: extPeer.skipPermissions,
        memory: extPeer.memory,
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
  // asker's per-peer record (the listener that answered last). Falls back to the
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
