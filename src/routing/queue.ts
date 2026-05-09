import { mkdir, readdir, readFile, writeFile, rename, access, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { paths } from '../registry/paths.js';
import { isErrnoException } from '../util/errors.js';

export type MessageType = 'query' | 'response' | 'ping' | 'session-ended';

export interface Message {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  timestamp: string;
  status: 'pending' | 'read' | 'sent';
  content: string;
  inReplyTo: string | null;
  metadata: { fromProject: string };
}

const POLL_INTERVAL_MS = 500;

export async function sendMessage(opts: {
  fromSessionId: string;
  fromProject: string;
  toSessionId: string;
  type: MessageType;
  content: string;
  inReplyTo?: string;
}): Promise<string> {
  try {
    await access(paths.sessionManifest(opts.toSessionId));
  } catch {
    throw new Error(`parley: target session ${opts.toSessionId} is not registered`);
  }

  const id = `msg-${randomBytes(6).toString('hex')}`;
  const message: Message = {
    id,
    from: opts.fromSessionId,
    to: opts.toSessionId,
    type: opts.type,
    timestamp: new Date().toISOString(),
    status: 'pending',
    content: opts.content,
    inReplyTo: opts.inReplyTo ?? null,
    metadata: { fromProject: opts.fromProject },
  };
  const inbox = paths.sessionInbox(opts.toSessionId);
  await mkdir(inbox, { recursive: true });
  const target = join(inbox, `${id}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(message, null, 2));
  await rename(tmp, target);

  const outbox = paths.sessionOutbox(opts.fromSessionId);
  await mkdir(outbox, { recursive: true });
  const outTarget = join(outbox, `${id}.json`);
  const outTmp = `${outTarget}.${process.pid}.tmp`;
  await writeFile(outTmp, JSON.stringify({ ...message, status: 'sent' }, null, 2));
  await rename(outTmp, outTarget);

  return id;
}

export async function waitForMessage(
  sessionId: string,
  predicate: (msg: Message) => boolean,
  opts: { timeoutMs: number; markRead?: boolean } = { timeoutMs: 90_000 },
): Promise<Message | null> {
  const inbox = paths.sessionInbox(sessionId);
  const readDir = paths.sessionInboxRead(sessionId);
  await mkdir(inbox, { recursive: true });
  const deadline = Date.now() + opts.timeoutMs;

  while (Date.now() < deadline) {
    const entries = await readdir(inbox).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const path = join(inbox, entry);
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      let msg: Message;
      try {
        msg = JSON.parse(raw) as Message;
      } catch {
        continue;
      }
      if (msg.status !== 'pending') continue;
      if (msg.from === sessionId) continue;
      if (!predicate(msg)) continue;

      if (opts.markRead ?? true) {
        msg.status = 'read';
        await mkdir(readDir, { recursive: true });
        const target = join(readDir, entry);
        const tmp = `${target}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(msg, null, 2));
        await rename(tmp, target);
        await unlink(path).catch(() => {});
      }
      return msg;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return null;
}

/** Delete entries in the read/ subdir whose mtime is older than `olderThanMs` ago. */
export async function pruneRead(sessionId: string, olderThanMs: number): Promise<number> {
  const readDir = paths.sessionInboxRead(sessionId);
  let entries: string[];
  try {
    entries = await readdir(readDir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const entry of entries) {
    const path = join(readDir, entry);
    try {
      const s = await stat(path);
      if (s.mtimeMs < cutoff) {
        await unlink(path);
        removed++;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

export async function listInbox(sessionId: string): Promise<Message[]> {
  const inbox = paths.sessionInbox(sessionId);
  let entries: string[];
  try {
    entries = await readdir(inbox);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    throw err;
  }
  const out: Message[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(inbox, entry), 'utf8');
      out.push(JSON.parse(raw) as Message);
    } catch {
      // ignore malformed
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
