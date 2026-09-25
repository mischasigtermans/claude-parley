import { optionalNumber, optionalString, requireString, InvalidToolArgsError, type ToolDef } from './types.js';
import { routeAsk } from '../routing/router.js';
import { runRounds } from '../routing/gather.js';
import { readManifest } from '../registry/sessions.js';
import {
  listRooms,
  postMessage,
  readRoom,
  readRoomTranscript,
  renderRoom,
  writeRoom,
  type RoomState,
} from '../registry/rooms.js';
import { withLock } from '../registry/locks.js';
import { paths } from '../registry/paths.js';

type Action = 'list' | 'log' | 'say' | 'continue' | 'close';
const ACTIONS: Action[] = ['list', 'log', 'say', 'continue', 'close'];

interface Args {
  action: Action;
  room?: string;
  message?: string;
  rounds: number;
  timeoutMs?: number;
}

export const parleyRoom: ToolDef<Args> = {
  name: 'parley_room',
  description:
    "Manage discussion rooms created by parley_gather. Actions: `list` rooms for this project; `log` the full transcript of a room; `say` to post a message into the room as chair (participants see it on their next turn); `continue` to run more rounds (default 1); `close` to end the room. Rooms are per calling project.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS, description: 'One of list, log, say, continue, close.' },
      room: { type: 'string', description: 'Room name. Required for every action except list.' },
      message: { type: 'string', description: 'For say: the message to post as chair.' },
      rounds: { type: 'number', description: 'For continue: how many more rounds to run. Default 1.' },
      timeoutMs: { type: 'number', description: 'For continue: max ms per peer turn. Default 1800000.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    const action = requireString('parley_room', raw, 'action') as Action;
    if (!ACTIONS.includes(action)) {
      throw new InvalidToolArgsError('parley_room', `\`action\` must be one of ${ACTIONS.join(', ')}`);
    }
    const room = optionalString(raw, 'room');
    if (action !== 'list' && !room) {
      throw new InvalidToolArgsError('parley_room', `\`room\` is required for ${action}`);
    }
    const rounds = optionalNumber(raw, 'rounds') ?? 1;
    if (rounds < 1) throw new InvalidToolArgsError('parley_room', '`rounds` must be at least 1');
    return {
      action,
      room,
      message: optionalString(raw, 'message'),
      rounds: Math.floor(rounds),
      timeoutMs: optionalNumber(raw, 'timeoutMs'),
    };
  },
  async handler(args, ctx) {
    const fromProjectId = await ctx.getProjectId();

    if (args.action === 'list') {
      const rooms = await listRooms(fromProjectId);
      if (rooms.length === 0) return 'No rooms yet for this project. Start one with parley_gather.';
      return rooms
        .map((r) => `${r.room}  ${r.status}  round ${r.round}  [${r.participants.join(', ')}]  ${r.updatedAt}\n  ${r.question}`)
        .join('\n');
    }

    const room = args.room!;
    const state = await readRoom(fromProjectId, room);
    if (!state) throw new Error(`parley: room "${room}" not found. Run parley_room list.`);

    switch (args.action) {
      case 'log': {
        const transcript = await readRoomTranscript(fromProjectId, room);
        return transcript || renderRoom(state);
      }
      case 'say': {
        if (!args.message) throw new InvalidToolArgsError('parley_room', '`message` is required for say');
        if (state.status === 'closed') throw new Error(`parley: room "${room}" is closed.`);
        await withLock(paths.roomLockFor(fromProjectId, room), async () => {
          state.status = 'open';
          await postMessage(state, `${state.convenedBy} (chair)`, args.message!);
        });
        return `Posted to room "${room}". Participants see it on their next turn: parley_room continue.`;
      }
      case 'continue': {
        const sid = ctx.getCurrentSessionId();
        if (!sid) {
          throw new Error(
            'parley: this session is not registered. Restart Claude Code so the SessionStart hook can fire.',
          );
        }
        const manifest = await readManifest(sid);
        const fromProject = manifest?.alias ?? ctx.getCurrentProjectName();
        const ask = async (peer: string, question: string) => {
          const result = await routeAsk({
            peerRef: peer,
            question,
            fromSessionId: sid,
            fromProject,
            fromProjectId,
            timeoutMs: args.timeoutMs,
          });
          return result.answer;
        };
        const before = state.messages.length;
        const result = await withLock(paths.roomLockFor(fromProjectId, room), () =>
          runRounds({ state, rounds: args.rounds, ask }),
        );
        const fresh: RoomState = { ...result.state, messages: result.state.messages.slice(before) };
        const tail = result.state.status === 'converged'
          ? '\n\n[parley: room converged, everyone passed.]'
          : `\n\n[parley: ${result.roundsRun} round(s) run.]`;
        return renderRoom(fresh) + tail;
      }
      case 'close': {
        state.status = 'closed';
        state.updatedAt = new Date().toISOString();
        await writeRoom(state);
        return `Room "${room}" closed.`;
      }
      default:
        args.action satisfies never;
        throw new Error('unreachable');
    }
  },
};
