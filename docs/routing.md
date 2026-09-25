# Routing

When you ask a peer, Parley picks one of three routes automatically based on the peer's current state.

## The three tiers

| Tier | When | What happens |
|------|------|---|
| **Live** | Peer has Claude Code open and is in `/parley listen` mode. | The message routes through the peer's inbox. The peer's agent answers in its own window, so you can watch it and intervene. |
| **Headless resumed** | No live listener, but Parley has a cached headless session for this peer. | `claude --resume <id> -p '<question>'` runs in the peer's project dir. The agent has memory of prior parley turns. |
| **Headless fresh** | First time talking to this peer, or after `/parley reset`. | `claude -p '<question>'` runs in the peer's project dir. The new session ID is cached so the next call falls into 'resumed'. |

## Per-asker-project scoping

Each asking project gets its own cached Claude session per peer. When you ask the same peer from project A vs project B, they each have their own thread with that peer. Cross-asker context isolation is the default.

State paths reflect this:

- Cached headless sessions: `~/.claude/parley/headless/<project_id>/<alias>.json`
- Transcripts: `~/.claude/parley/logs/<project_id>/<alias>.md`
- Locks: `~/.claude/parley/locks/<project_id>-<alias>.lock`

`project_id` is the SHA1 of the git remote URL when available, with CWD hash as fallback. First 12 hex chars. Worktrees and clones of the same repo share the same project_id.

## Transcripts

Every turn is appended to a transcript at `~/.claude/parley/logs/<project_id>/<peer>.md`. You always have observability, even when the answer came from a headless agent you never saw. Read with `/parley log <peer>`.

## At-least-once delivery

In live mode, `parley_receive_next` moves messages into `inbox/in-progress/` when consumed but not yet responded. Every 30 seconds the heartbeat sweep returns any message older than 10 minutes back to `inbox/` as pending.

If the listener consumes a query but never calls `parley_respond` (crash, error, confusion), the next `parley_receive_next` redelivers it. Responders need to be idempotent for repeat queries.

## Rooms

`parley_gather` convenes several peers around one question. Round 1 is blind: every peer gets only the question, in parallel, so nobody anchors on the first answer. From round 2 each peer speaks in turn and sees only what was said since its last turn (its own turns and `PASS` turns excluded). A peer that was `@alias`-mentioned speaks first in the next round. A peer replies `PASS` when it has nothing to add; when everyone passes in a round the room is `converged`. Advisors are told the convening project's path and may read it to check facts (`projectAccess: false` withholds it). Peers passed as `grounders` take a verifying role instead of advising: they check the others' factual claims against their own code and data, correct wrong ones with file references, run checks the advisors propose, and speak first each round. `parley_room say` posts a chair message that every peer sees on its next turn; `parley_room continue` runs more rounds.

Each turn goes through `routeAsk`, so it uses the peer's normal per-(project, peer) session, transcript and memory. Rooms live at `~/.claude/parley/rooms/<project_id>/<room>/` as `state.json` (source of truth) and `transcript.md` (human-readable, append-only).
