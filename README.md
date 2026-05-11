# Parley

Cross-session bridge for Claude Code. Each of your projects becomes a peer agent, callable from any Claude Code or Cowork session. Full project context, persistent memory.

Parley is a plugin that bundles an MCP server. From any active session, you ask another project's Claude agent for input. The peer runs in its own directory with its own CLAUDE.md, skills, and MCP servers loaded. If the peer session isn't open, Parley spawns a headless Claude there and persists the session, so the agent has memory across turns.

Available through the [Ryde Ventures plugin marketplace](https://github.com/rydeventures/claude-plugins).

## What this is for

**Cross-project consultation.** You're starting a new Laravel app. You remember [stagent](https://stagent.com) solved Stripe webhook retries cleanly. *"Ask stagent how they handle webhook retries."* The stagent agent reads its own code and replies with file:line references and the trade-offs. Follow-ups continue the thread. The headless session persists. Same pattern for any project. *"Ask onoma how it evicts context."* Each peer answers from its own loaded CLAUDE.md, with its own MCP servers (Linear, Sentry, etc.) already wired up.

**Remote control of your fleet.** Run a Claude session in your home directory with Parley plus a Claude Channels MCP (e.g. Telegram). From your phone: *"how is the Stripe webhook fix going in stagent?"* The home session routes to stagent's agent, which reads the actual code and replies. *"Ask onoma to summarise yesterday's design doc."* Done. The whole machine becomes a remote-controllable workspace. No tab-switching, no laptop required.

## Installation

```
# Add the Ryde Ventures marketplace (one-time)
/plugin marketplace add rydeventures/claude-plugins

# Install the plugin
/plugin install parley@rydeventures-claude-plugins
```

Works in both Claude Code (CLI) and Cowork. The MCP server ships as a self-contained bundle, no extra runtimes to install.

### Requirements

- `jq`, used by the SessionStart/SessionEnd hooks. `brew install jq` on macOS, `apt install jq` on Linux.

## Quick Start

```
# Discover projects you've used recently and aren't yet registered
/parley discover
```

You'll see a list of candidate paths. Just say which ones to register, in plain language:

```
"add the first three as peers"
"register that one as docs and that one as api"
"add ~/Github/example as my-project"
```

The `parley` skill picks up the names and calls `parley_add` for each. From then on, any session can consult them by alias:

```
# See who's reachable
/parley peers

# Ask a peer — natural language works
"ask docs what's our auth strategy"
"check with api how it handles rate limits"
```

You can also be explicit:

```
/parley add my-project ~/code/my-project
/parley ask my-project "Summarize the current architecture in three bullets."
/parley log my-project
/parley reset my-project
```

## How It Works

When you ask a peer something, Parley picks one of three routes automatically:

| Tier | When | What happens |
|------|------|---|
| **Live** | Peer has Claude Code open and is in `/parley listen` mode | The message routes through the peer's inbox. Their agent answers in its own window, so you can watch it happen and intervene. |
| **Headless resumed** | No live listener, but Parley has a cached headless session for this peer | `claude --resume <id> -p "<question>"` runs in the peer's project dir. The agent has memory of prior parley turns. |
| **Headless fresh** | First time talking to this peer, or after `/parley reset` | `claude -p "<question>"` runs in the peer's project dir. The new session ID is cached so the next call falls into "resumed". |

Every turn is appended to a transcript at `~/.claude/parley/logs/<peer>.md`, so you always have observability, even when the answer came from a headless agent you never saw.

## Slash Commands

| Command | Effect |
|---|---|
| `/parley` | Discovery menu. Auto-cleans hourly, lists peers, suggests next moves. |
| `/parley peers` (or `list`) | List configured peers and any live sessions on the machine |
| `/parley discover` | Scan `~/.claude/projects` for projects you've used recently and aren't yet registered |
| `/parley ask <peer> <question>` | One-shot query (silent unless the peer is listening) |
| `/parley listen` | Make this window the live answerer for its project and enter the receive loop |
| `/parley add <alias> <path> [description]` | Register a peer in `peers.json` |
| `/parley remove <alias>` | Unregister a peer |
| `/parley log <alias> [tail]` | Read recent Q&A transcript with a peer |
| `/parley reset <alias>` | Clear cached headless session. Next ask spawns fresh. |
| `/parley clean [--dry-run]` | Remove dead sessions and dangling PID sentinels |

Both the slash commands and natural-language triggers ("ask onoma about X") are handled by a single `parley` skill, which routes to the MCP tools. The slash commands are the explicit operational entry point; awareness handles the conversational case.

## MCP Tools

The bundled MCP server exposes:

`parley_peers`, `parley_ask`, `parley_listen`, `parley_receive_next`, `parley_respond`, `parley_log`, `parley_reset`, `parley_add`, `parley_remove`, `parley_clean`, `parley_discover`

These are also reachable from any other MCP-capable client (Claude Desktop, Cursor) by pointing it at `bin/parley-mcp` directly. Claude Code is just the most ergonomic surface.

## Configuration

### `~/.claude/parley/peers.json`

User-curated peer list. Hand-editable. `parley_add` and `parley_remove` mutate it for you.

```json
{
  "peers": {
    "stagent": {
      "path": "~/Sites/stagent",
      "description": "Booking and management platform for agencies and artists",
      "skipPermissions": true
    },
    "onoma": {
      "path": "~/Github/mischasigtermans/onoma",
      "description": "Memory layer for AI"
    }
  }
}
```

### Runtime state (auto-managed)

| Path | What |
|---|---|
| `~/.claude/parley/sessions/<sid>/manifest.json` | Per-session registration with heartbeat |
| `~/.claude/parley/sessions/<sid>/inbox/` | Pending messages. Subdirs: `in-progress/` (consumed but not yet responded), `read/` (responded). |
| `~/.claude/parley/sessions/<sid>/outbox/` | Sent-message ledger |
| `~/.claude/parley/headless/<peer>.json` | Cached headless session ID + turn count per peer |
| `~/.claude/parley/logs/<peer>.md` | Append-only Q&A transcript per peer |
| `~/.claude/parley/locks/<peer>.lock` | Per-peer lock to serialize concurrent asks |
| `~/.claude/parley/state.json` | Runtime metadata (last-clean timestamp, etc.) |

### Cleanup

Parley accumulates a small amount of state per session. When Claude Code crashes, gets killed, or you reboot, sessions can leave behind stale manifests. The discovery menu (`/parley` with no argument) auto-runs cleanup once every 7 days, so you rarely need to invoke it directly. To clean on demand: `/parley clean` (or `/parley clean --dry-run` to preview).

What gets removed:
- Session manifests whose owning process is dead AND last heartbeat was more than 1 hour ago
- `by-claude-pid/` sentinels for processes that no longer exist
- `.claude/parley-session` pointers in projects whose target session has been cleaned up
- Headless caches for peers no longer in `peers.json`

In addition, every 30s the listening session's heartbeat sweeps `inbox/in-progress/` and returns any message older than 10 minutes back to `inbox/` as `pending`. This guarantees at-least-once delivery: if the listener consumed a query but never called `parley_respond` (agent crashed, hit an error, hit a confused state), the next `parley_receive_next` re-delivers it. Responders should be idempotent for repeat queries.

What's flagged but never auto-removed:
- `peers.json` entries whose path doesn't exist on disk (you decide whether to `/parley remove` them)

`listSessions()` self-heals on every call: any manifest whose process is dead and heartbeat is older than 1 hour is removed inline, so `/parley peers` stays accurate without needing an explicit clean.

### Permission handling for headless spawns

Headless Claude spawns pass `--dangerously-skip-permissions` by default so they don't block on tool prompts. To opt out per peer:

```json
"stagent": {
  "path": "~/Sites/stagent",
  "skipPermissions": false
}
```

Then ensure the project has a `.claude/settings.local.json` allowlist that covers what the agent will need.

## Requirements

- [Claude Code](https://claude.com/claude-code) ≥ 2.1 or Claude Cowork
- `jq` (for hook scripts)
- macOS or Linux. Windows untested.

### For contributors

If you're hacking on the source, you'll need [Bun](https://bun.sh) to run the bundler (`bun run build`). Vitest tests run under Node. The published `dist/server.js` is a self-contained Node bundle, so users don't need Bun.

## Credits

- [Mischa Sigtermans](https://github.com/mischasigtermans)
- Inspired by Shreyas Patil's [`session-bridge`](https://github.com/shreyaspatil/session-bridge), which solved the live-to-live half of this problem first

## License

MIT
