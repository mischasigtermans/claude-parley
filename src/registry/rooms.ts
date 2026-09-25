import { appendFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { paths, type ProjectId } from './paths.js';
import { atomicWriteJSON } from './locks.js';
import { isErrnoException } from '../util/errors.js';

export type RoomStatus = 'open' | 'converged' | 'closed';

export interface RoomMessage {
  seq: number;
  round: number;
  from: string;
  text: string;
  at: string;
  /** A turn where the participant had nothing to add. Kept for the record, hidden from deltas. */
  pass?: boolean;
}

export interface RoomState {
  projectId: ProjectId;
  room: string;
  question: string;
  participants: string[];
  /** Participants that verify facts instead of advising. Subset of participants. */
  grounders: string[];
  convenedBy: string;
  /** Absolute path of the convening project. Advisors are told they may read it. */
  projectPath?: string;
  createdAt: string;
  updatedAt: string;
  round: number;
  status: RoomStatus;
  messages: RoomMessage[];
  /** Highest message seq each participant has been shown. */
  seen: Record<string, number>;
}

const ROOM_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class InvalidRoomNameError extends Error {
  constructor(room: string) {
    super(`parley: invalid room name "${room}". Use lowercase letters, digits and hyphens.`);
  }
}

export function assertValidRoomName(room: string): void {
  if (!ROOM_NAME.test(room)) throw new InvalidRoomNameError(room);
}

export function slugForQuestion(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-');
  return (slug || 'room').slice(0, 48);
}

export function isRoomState(v: unknown): v is RoomState {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<RoomState>;
  return (
    typeof r.projectId === 'string' &&
    typeof r.room === 'string' &&
    typeof r.question === 'string' &&
    Array.isArray(r.participants) &&
    (r.grounders === undefined || Array.isArray(r.grounders)) &&
    Array.isArray(r.messages) &&
    typeof r.round === 'number' &&
    typeof r.status === 'string' &&
    typeof r.seen === 'object' && r.seen !== null
  );
}

export async function readRoom(projectId: ProjectId, room: string): Promise<RoomState | null> {
  try {
    const raw = await readFile(paths.roomState(projectId, room), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isRoomState(parsed) ? { ...parsed, grounders: parsed.grounders ?? [] } : null;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeRoom(state: RoomState): Promise<void> {
  await mkdir(paths.roomDir(state.projectId, state.room), { recursive: true });
  await atomicWriteJSON(paths.roomState(state.projectId, state.room), state);
}

export async function createRoom(input: {
  projectId: ProjectId;
  room: string;
  question: string;
  participants: string[];
  grounders?: string[];
  convenedBy: string;
  projectPath?: string;
}): Promise<RoomState> {
  assertValidRoomName(input.room);
  const now = new Date().toISOString();
  const state: RoomState = {
    ...input,
    grounders: input.grounders ?? [],
    createdAt: now,
    updatedAt: now,
    round: 0,
    status: 'open',
    messages: [],
    seen: Object.fromEntries(input.participants.map((p) => [p, 0])),
  };
  await writeRoom(state);
  await appendFile(
    paths.roomTranscript(state.projectId, state.room),
    `# Room: ${state.room}\n\nConvened by ${state.convenedBy} at ${now}.\n` +
      `Participants: ${describeParticipants(state)}.\n\n**Question:** ${state.question}\n\n---\n\n`,
    'utf8',
  );
  return state;
}

/**
 * Append a message to the room. Mutates and persists `state`, and mirrors the
 * message into the human-readable transcript.
 */
export async function postMessage(
  state: RoomState,
  from: string,
  text: string,
  pass = false,
): Promise<RoomMessage> {
  const seq = (state.messages.at(-1)?.seq ?? 0) + 1;
  const at = new Date().toISOString();
  const msg: RoomMessage = { seq, round: state.round, from, text, at, ...(pass ? { pass } : {}) };
  state.messages.push(msg);
  state.updatedAt = at;
  await writeRoom(state);
  await appendFile(
    paths.roomTranscript(state.projectId, state.room),
    `## ${at} · round ${state.round} · ${from}\n\n${text}\n\n---\n\n`,
    'utf8',
  );
  return msg;
}

export function unseenBy(state: RoomState, participant: string): RoomMessage[] {
  const mark = state.seen[participant] ?? 0;
  return state.messages.filter((m) => m.seq > mark && m.from !== participant && !m.pass);
}

export function renderMessages(messages: RoomMessage[]): string {
  return messages.map((m) => `**${m.from}:** ${m.text.trim()}`).join('\n\n');
}

export function isGrounder(state: RoomState, alias: string): boolean {
  return state.grounders.includes(alias);
}

export function describeParticipants(state: RoomState): string {
  return state.participants
    .map((p) => (isGrounder(state, p) ? `${p} (grounding)` : p))
    .join(', ');
}

export function renderRoom(state: RoomState): string {
  const head =
    `[room ${state.room} · ${state.status} · round ${state.round}]\n` +
    `Participants: ${describeParticipants(state)}\n` +
    `Question: ${state.question}\n`;
  const byRound = new Map<number, RoomMessage[]>();
  for (const m of state.messages) {
    const list = byRound.get(m.round) ?? [];
    list.push(m);
    byRound.set(m.round, list);
  }
  const body = [...byRound.entries()]
    .map(([round, msgs]) => `### Round ${round}\n\n${renderMessages(msgs)}`)
    .join('\n\n');
  return `${head}\n${body}`.trim();
}

export async function listRooms(projectId: ProjectId): Promise<RoomState[]> {
  let names: string[];
  try {
    names = await readdir(paths.roomsProjectDir(projectId));
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    throw err;
  }
  const rooms = await Promise.all(names.map((n) => readRoom(projectId, n)));
  return rooms
    .filter((r): r is RoomState => r !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readRoomTranscript(projectId: ProjectId, room: string): Promise<string> {
  try {
    return await readFile(paths.roomTranscript(projectId, room), 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return '';
    throw err;
  }
}

export async function deleteRoom(projectId: ProjectId, room: string): Promise<void> {
  await rm(paths.roomDir(projectId, room), { recursive: true, force: true });
}
