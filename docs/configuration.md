# Configuration

## peers.json

User-curated peer list. Hand-editable. `parley_add` and `parley_remove` mutate it for you.

Location: `~/.claude/parley/peers.json`

```json
{
  "peers": {
    "peer-a": {
      "path": "~/code/peer-a",
      "description": "Short hint to help the skill pick this peer"
    },
    "peer-b": {
      "path": "~/code/peer-b",
      "description": "Stricter peer; opt out of skip_default",
      "skipPermissions": false
    }
  }
}
```

Per-peer fields:

| Field | Type | Effect |
|---|---|---|
| `path` | string | Absolute or `~`-expanded path to the peer's project root. |
| `description` | string | Shown in `/parley peers` and used by the skill to pick between peers. |
| `skipPermissions` | boolean | Whether to pass `--dangerously-skip-permissions` on headless spawns. Default unset, in which case `[permissions] skip_default` from `config.json` applies (default `true`). Per-peer values always win. |
| `model` | string | Optional model override for headless spawns. |
| `mcpServers` | object | Optional per-peer MCP server overrides. Additive; the peer's own `.claude/settings.local.json` MCPs still load. |
| `type` | string | Optional classification. Cooperating plugins set this to mark what a peer represents (e.g. `'persona'`). |
| `memory` | boolean | Whether durable memory is injected/accumulated for this peer. Default unset, in which case `memory.default` from `config.json` applies (default `true`). A `memory.peers` override always wins. |

## config.json

Optional file: `~/.claude/parley/config.json`. Tunes parley's routing behavior. All fields are optional; defaults match v0.3 behavior. If a pre-v0.3 `config.toml` exists, parley auto-migrates it to `config.json` on first read and deletes the old file.

```json
{
  "runtime": {
    "fallback": "headless"
  },
  "permissions": {
    "skip_default": true
  },
  "memory": {
    "default": true,
    "peers": {}
  }
}
```

`runtime.fallback` is one of `headless | ask`. See below.

### `fallback`

What `parley_ask` does when no live listener exists for the peer. (A live listener is a peer window where you ran `/parley listen`; if one exists, the ask always routes there first, regardless of this setting.)

| Value | Behavior |
|---|---|
| `headless` (default) | Spawn `claude -p` in the peer's directory, with `--resume` when there is a conversation to continue (see [routing](routing.md)). No window opens. For Claude subscription users this draws from the Agent SDK credit pool (separate from interactive limits). |
| `ask` | Error each time with a clear options list. The skill prompts you in natural language. To answer at zero SDK credit, open the peer and run `/parley listen`, then retry. An ask with a `thread` always continues headless, so under `ask` it errors and points at `headless`. |

Env override: `PARLEY_FALLBACK`.

### `skip_default`

Global default for `skipPermissions` on peers that don't set it explicitly. Default `true` (the ergonomic choice for trusted local peers). Flip to `false` to require explicit per-peer opt-in. Per-peer values in `peers.json` always win.

### `memory`

Durable per-peer memory. After a productive consultation, distil it with `/parley remember <peer>`; parley stores the bullets and prepends them to every future headless ask to that peer from the same project.

| Field | Effect |
|---|---|
| `memory.default` | Whether memory is on for peers that don't declare their own. Default `true`. |
| `memory.peers` | Per-peer overrides keyed by canonical alias, e.g. `{ "taylor": false }`. Wins over the peer's declared flag and the default. |

Resolution order: `memory.peers.<alias>` → the peer's own `memory` flag (`peers.json` or an extension manifest, e.g. a persona's `persona.json`) → `memory.default`. When off, parley neither injects nor accumulates memory for that peer. Memory reaches every conversation with the peer, fresh or continued.

## Runtime state

Auto-managed under `~/.claude/parley/`:

| Path | Contents |
|---|---|
| `sessions/<sid>/manifest.json` | Per-session registration with heartbeat. Includes `claudeSessionId` captured from the SessionStart hook payload. |
| `sessions/<sid>/inbox/` | Pending messages. Subdirs: `in-progress/`, `read/`. |
| `sessions/<sid>/outbox/` | Sent-message ledger. |
| `headless/<project_id>/<alias>.json` | The peer's record per (asker, peer): turn count, `rememberedTurn`, and the `claudeSessionId` of the listener that answered last (`origin: 'live'`), which picks that listener when several are listening. A headless turn counts itself here and leaves `claudeSessionId` and `origin` as they are. `adopted: true` once the conversation it named became a thread (see [Cleanup](#cleanup)). |
| `headless/<project_id>/<alias>/<thread>.json` | One conversation: its `claudeSessionId` and turn count. An ask that passes the thread resumes from it. Removed after 30 days without a turn. |
| `logs/<project_id>/<alias>.md` | Append-only Q&A transcript per (asker, peer). Includes the actual tier (`live` / `headless-fresh` / `headless-resumed`) for each turn, and the thread of each headless turn. |
| `memory/<project_id>/<alias>.md` | Durable distilled memory per (asker, peer). A flat `- bullet` list prepended to future headless asks. Written by `parley_remember`. |
| `locks/<project_id>-<alias>.lock` | Per-(asker, peer) lock around the record update of every ask and around adoption. Parley waits at most 2 seconds for it; when another process keeps it longer, the ask still returns its answer and thread. The turn count, the adoption and, for a live answer, the listener's id are skipped and wait for a later ask. |
| `locks/<project_id>-<alias>-<thread>.lock` | Per-thread lock to serialize concurrent asks on one thread. |
| `extensions/<name>.json` | Manifests from other plugins that register peers. See [extensions.md](extensions.md). |
| `state.json` | Runtime metadata (last-clean timestamp, etc.). |

## Permission handling

Headless spawns pass `--dangerously-skip-permissions` by default. The peer's own `.claude/settings.local.json` allowlist still applies on top.

Resolution order:

1. If the peer has `"skipPermissions"` set in `peers.json`, that wins.
2. Otherwise, `permissions.skip_default` from `config.json` decides (default `true`).

To tighten things up machine-wide, set `permissions.skip_default` to `false` and opt the trusted peers back in per-entry:

```json
"peer-a": {
  "path": "~/code/peer-a",
  "skipPermissions": true
}
```

## Environment variables

| Var | Effect |
|---|---|
| `PARLEY_DIR` | Override the parley state root (default `~/.claude/parley`). Used by tests. |
| `PARLEY_CONFIG` | Override the `config.json` path. Used by tests. |
| `PARLEY_FALLBACK` | Override `fallback` for this process. `headless` / `ask`. |

## Cleanup

The MCP server auto-cleans stale state on the first `listLiveSessions` call after a 1-hour cooldown. To clean on demand: `/parley clean`, or `/parley clean --dry-run` to preview.

What gets removed:

- Session manifests whose owning process is dead AND last heartbeat was more than 1 hour ago.
- `by-claude-pid/` sentinels for processes that no longer exist.
- Headless records and threads for peers no longer in `peers.json`.
- Threads nobody continued for 30 days.
- Extension manifests where **every** declared peer's path is missing on disk.

What's flagged but never auto-removed:

- `peers.json` entries whose path doesn't exist on disk. You decide whether to `/parley remove` them.
- Partially-stale extension manifests (some peers live, some gone). That's the extension's job to reconcile.

What gets adopted:

- A headless record whose `claudeSessionId` names a headless conversation (any `origin` but `live`) and that was used in the last 30 days becomes a thread, once. This happens on the first ask to that peer, on `/parley peers`, or on the sweep, whichever comes first. The thread keeps the record's turn count and last use, and its id is the first 6 hex characters of the SHA1 of that session id. The record gets `adopted: true` and is never adopted again, also after its thread expires. `/parley peers` lists it while it is among the peer's three most recent threads with more than one turn, and an ask that passes it continues that conversation.
- A record that was unused for 30 days when Parley first looks at it gets `adopted: true` without a thread, so a later turn that makes it look recent doesn't adopt it.
- Adoption waits at most 2 seconds for the per-peer lock. When another process keeps it longer, such as an older Parley mid-spawn, that peer is skipped and adopted on a later look.
