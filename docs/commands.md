# Commands

Parley exposes two surfaces: slash commands for explicit operations, and natural-language triggers handled by the `parley` skill ('ask <peer> about X'). Both route to the same MCP tools.

## Slash commands

| Command | Effect |
|---|---|
| `/parley` | Discovery menu. Auto-cleans hourly, lists peers, suggests next moves. |
| `/parley peers` (or `list`) | List configured peers and any live sessions on the machine. |
| `/parley discover` | Scan Claude Code history for projects you've used recently and aren't yet registered. |
| `/parley ask <peer> <question>` | One-shot query. Silent unless the peer is listening. |
| `/parley listen` | Make this window the live answerer for its project and enter the receive loop. |
| `/parley add <alias> <path> [description]` | Register a peer in `peers.json`. |
| `/parley remove <alias>` | Unregister a peer. |
| `/parley log <alias> [tail]` | Read recent Q&A transcript with a peer. |
| `/parley remember <peer>` | Distil the transcript into durable memory, prepended to future asks. |
| `/parley reset <alias>` | Clear cached headless session. Next ask spawns fresh. Memory is left intact. |
| `/parley clean [--dry-run]` | Remove dead sessions and dangling PID sentinels. |

## MCP tools

The bundled MCP server exposes the underlying tools:

`parley_peers`, `parley_ask`, `parley_listen`, `parley_receive_next`, `parley_respond`, `parley_log`, `parley_remember`, `parley_reset`, `parley_add`, `parley_remove`, `parley_clean`, `parley_discover`.

These are reachable from any other MCP-capable client (Claude Desktop, Cursor) by pointing it at the parley MCP server directly. Claude Code is the most ergonomic surface but not the only one.

## How the skill routes

The `parley` skill picks up both slash commands and natural-language triggers ('ask <peer> about X'). It calls the relevant MCP tool, formats the result, and decides whether to continue listening or close out. The slash commands are explicit operational entry points; the skill handles conversational cases.

## Multi-session disambiguation

With 2+ listening sessions for the same path, address a specific one as `<alias>:<sid>` (e.g. `/parley ask <peer>:a6v9lk '...'`). Without `:sid` and multiple live sessions, the router returns an error listing the live sids so the caller can pick.
