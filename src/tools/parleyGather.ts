import { optionalBool, optionalNumber, optionalString, requireString, InvalidToolArgsError, type ToolDef } from './types.js';
import { canonicalAlias, peerExists, routeAsk } from '../routing/router.js';
import { runRounds } from '../routing/gather.js';
import { readManifest } from '../registry/sessions.js';
import { createRoom, readRoom, renderRoom, slugForQuestion } from '../registry/rooms.js';
import { withLock } from '../registry/locks.js';
import { paths } from '../registry/paths.js';

interface Args {
  peers: string[];
  grounders: string[];
  question: string;
  room?: string;
  rounds: number;
  projectAccess: boolean;
  timeoutMs?: number;
}

const DEFAULT_ROUNDS = 3;

export const parleyGather: ToolDef<Args> = {
  name: 'parley_gather',
  description:
    "Convene two or more peers in a shared room and run a structured discussion. Round 1 is blind: every peer answers the question independently, in parallel. Later rounds are sequential: each peer sees what was said since its last turn, must agree or disagree explicitly, and may address others with @alias; a peer with nothing to add replies PASS. The room converges early when everyone passes. Each peer answers from its own continuous parley session (memory and transcript intact), so personas stay in character across rooms. By default every advisor is told the convening project's path and may read it to check facts before asserting them (`projectAccess: false` withholds it). Peers listed in `grounders` take a different role: they don't advise, they verify. Give the project under discussion as a grounder whenever the question makes claims about a codebase, so the advisors argue over checked facts instead of the chair's framing. Returns the full room transcript for the caller to synthesize; the room stays open for parley_room say/continue. Rooms are stored under ~/.claude/parley/rooms/<projectId>/<room>/.",
  inputSchema: {
    type: 'object',
    properties: {
      peers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Two or more peer aliases (see parley_peers). Personas and projects mix freely.',
      },
      grounders: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional subset of `peers` that ground instead of advise: verify factual claims against their own code and data, correct wrong ones with file references, run checks others propose. Typically the project the room is about. Grounders speak first each round.',
      },
      question: {
        type: 'string',
        description: 'The question or decision to discuss. Self-contained: peers see only this text plus the room transcript.',
      },
      room: {
        type: 'string',
        description: 'Optional room name (lowercase, digits, hyphens). Defaults to a slug of the question.',
      },
      rounds: {
        type: 'number',
        description: 'Total rounds including the blind first round. Default 3.',
      },
      projectAccess: {
        type: 'boolean',
        description: 'Whether advisors are given this project\'s path and told they may read it. Default true.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional. Max ms to wait for each individual peer turn. Default 1800000 (30 min).',
      },
    },
    required: ['peers', 'question'],
    additionalProperties: false,
  },
  parseArgs(raw) {
    const peers = raw.peers;
    if (!Array.isArray(peers) || peers.length < 2 || !peers.every((p) => typeof p === 'string' && p.length > 0)) {
      throw new InvalidToolArgsError('parley_gather', '`peers` must be an array of at least two peer aliases');
    }
    const grounders = raw.grounders ?? [];
    if (!Array.isArray(grounders) || !grounders.every((p) => typeof p === 'string' && p.length > 0)) {
      throw new InvalidToolArgsError('parley_gather', '`grounders` must be an array of peer aliases');
    }
    const rounds = optionalNumber(raw, 'rounds') ?? DEFAULT_ROUNDS;
    if (rounds < 1) throw new InvalidToolArgsError('parley_gather', '`rounds` must be at least 1');
    return {
      peers: peers as string[],
      grounders: grounders as string[],
      question: requireString('parley_gather', raw, 'question'),
      room: optionalString(raw, 'room'),
      rounds: Math.floor(rounds),
      projectAccess: optionalBool(raw, 'projectAccess') ?? true,
      timeoutMs: optionalNumber(raw, 'timeoutMs'),
    };
  },
  async handler(args, ctx) {
    const sid = ctx.getCurrentSessionId();
    if (!sid) {
      throw new Error(
        'parley: this session is not registered. Restart Claude Code so the SessionStart hook can fire.',
      );
    }
    const manifest = await readManifest(sid);
    const fromProject = manifest?.alias ?? ctx.getCurrentProjectName();
    const fromProjectId = await ctx.getProjectId();

    const participants: string[] = [];
    for (const ref of args.peers) {
      if (!(await peerExists(ref))) {
        throw new Error(`parley: peer "${ref}" not found. Add it with parley_add or check parley_peers.`);
      }
      const alias = await canonicalAlias(ref);
      if (!participants.includes(alias)) participants.push(alias);
    }
    if (participants.length < 2) {
      throw new Error('parley: a room needs at least two distinct peers.');
    }
    const grounders: string[] = [];
    for (const ref of args.grounders) {
      const alias = await canonicalAlias(ref);
      if (!participants.includes(alias)) {
        throw new Error(`parley: grounder "${ref}" is not one of the room's peers.`);
      }
      if (!grounders.includes(alias)) grounders.push(alias);
    }
    if (grounders.length === participants.length) {
      throw new Error('parley: a room needs at least one peer that advises; not every peer can be a grounder.');
    }

    let room = args.room ?? slugForQuestion(args.question);
    if (!args.room) {
      let n = 2;
      const base = room;
      while (await readRoom(fromProjectId, room)) room = `${base}-${n++}`;
    } else if (await readRoom(fromProjectId, room)) {
      throw new Error(`parley: room "${room}" already exists. Use parley_room continue, or pick another name.`);
    }

    const state = await createRoom({
      projectId: fromProjectId,
      room,
      question: args.question,
      participants,
      grounders,
      convenedBy: fromProject,
      projectPath: args.projectAccess ? ctx.getCurrentProjectPath() : undefined,
    });

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

    const result = await withLock(paths.roomLockFor(fromProjectId, room), () =>
      runRounds({ state, rounds: args.rounds, ask }),
    );

    const tail = result.state.status === 'converged'
      ? `\n\n[parley: room converged, everyone passed. Synthesize the discussion for the user. Reopen with parley_room continue if needed.]`
      : `\n\n[parley: ${result.roundsRun} round(s) run. Synthesize the discussion for the user. Add your own point with parley_room say, then parley_room continue for another round.]`;
    return renderRoom(result.state) + tail;
  },
};
