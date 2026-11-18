# Routing

When you ask a peer, Parley picks one of three routes automatically based on the peer's current state and whether the ask names a thread.

## The three tiers

| Tier | When | What happens |
|------|------|---|
| **Live** | Peer has Claude Code open and is in `/parley listen` mode, and the ask names no thread. | The message routes through the peer's inbox. The peer's agent answers in its own window, so you can watch it and intervene. |
| **Headless resumed** | The ask names a thread, whether or not a listener is live. | `claude --resume <id> -p '<question>'` runs in the peer's project dir. The agent has memory of that thread's earlier turns. |
| **Headless fresh** | No live listener, and the ask names no thread. | `claude -p '<question>'` runs in the peer's project dir. The answer names the new thread. |

## Conversations and threads

Every ask starts a fresh conversation, for every peer. It knows nothing of earlier asks beyond the peer's memory file, so a second review pass, a subagent and another session in the same repo each get a peer with no history. Write each question so it stands on its own.

A headless answer's first line names its thread: `[<alias> · thread k3x9qa]`. An ask that passes that id as `thread` continues that conversation, headless, also when a listener is live. Use it for a follow-up, or to have a reviewer fix its own findings. Leave it out for a fresh pass. A thread Parley doesn't know is refused before anything is spawned. When resuming a thread's session fails, Parley starts a fresh one and keeps the thread id.

A live answer starts with `[<alias> · live]` and has no thread.

To find an earlier conversation, `/parley peers` lists up to three of your project's threads per peer that have more than one turn, most recent first. `/parley log <peer>` shows the thread of every headless turn in its heading.

A thread nobody continues for 30 days is removed by the sweep, as are all threads of a peer that is removed.

## Per-asker-project scoping

Each asking project gets its own threads with each peer. When you ask the same peer from project A vs project B, each has its own. Cross-asker context isolation is the default.

State paths reflect this:

- Threads: `~/.claude/parley/headless/<project_id>/<alias>/<thread>.json`
- Turn count and the listener that answered last: `~/.claude/parley/headless/<project_id>/<alias>.json`
- Transcripts: `~/.claude/parley/logs/<project_id>/<alias>.md`
- Locks: `~/.claude/parley/locks/<project_id>-<alias>.lock` and `<project_id>-<alias>-<thread>.lock`

`project_id` is the SHA1 of the git remote URL when available, with CWD hash as fallback. First 12 hex chars. Worktrees and clones of the same repo share the same project_id.

## Transcripts

Every turn is appended to a transcript at `~/.claude/parley/logs/<project_id>/<peer>.md`. You always have observability, even when the answer came from a headless agent you never saw. Read with `/parley log <peer>`. Each entry's heading names the asking project, the tier and, for a headless turn, the thread: `## <timestamp> · from <project> (headless-fresh) · thread k3x9qa`.

## At-least-once delivery

In live mode, `parley_receive_next` moves messages into `inbox/in-progress/` when consumed but not yet responded. Every 30 seconds the heartbeat sweep returns any message older than 10 minutes back to `inbox/` as pending.

If the listener consumes a query but never calls `parley_respond` (crash, error, confusion), the next `parley_receive_next` redelivers it. Responders need to be idempotent for repeat queries.

## Rooms

`parley_gather` convenes several peers around one question. Round 1 is blind: every peer gets only the question, in parallel, so nobody anchors on the first answer. From round 2 each peer speaks in turn and sees only what was said since its last turn (its own turns and `PASS` turns excluded). A peer that was `@alias`-mentioned speaks first in the next round. A peer replies `PASS` when it has nothing to add; when everyone passes in a round the room is `converged`. Advisors are told the convening project's path and may read it to check facts (`projectAccess: false` withholds it). Peers passed as `grounders` take a verifying role instead of advising: they check the others' factual claims against their own code and data, correct wrong ones with file references, run checks the advisors propose, and speak first each round. `parley_room say` posts a chair message that every peer sees on its next turn; `parley_room continue` runs more rounds.

Each turn goes through `routeAsk`, so it writes the peer's transcript and reads its memory. Each participant gets one thread per room, kept in the room's `state.json`: its later rounds continue its earlier ones and stay apart from its other asks. When the sweep removed that thread, the participant's next round starts a new one. Rooms live at `~/.claude/parley/rooms/<project_id>/<room>/` as `state.json` (source of truth) and `transcript.md` (human-readable, append-only).
