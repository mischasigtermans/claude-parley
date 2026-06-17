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
| `headless` (default) | Spawn `claude -p` in the peer's directory with `--resume <cached sid>` when a pointer exists. No window opens. For Claude subscription users this draws from the Agent SDK credit pool (separate from interactive limits). |
| `ask` | Error each time with a clear options list. The skill prompts you in natural language. To answer at zero SDK credit, open the peer and run `/parley listen`, then retry. |

Env override: `PARLEY_FALLBACK`.

### `skip_default`

Global default for `skipPermissions` on peers that don't set it explicitly. Default `true` (the ergonomic choice for trusted local peers). Flip to `false` to require explicit per-peer opt-in. Per-peer values in `peers.json` always win.

### `memory`

Durable per-peer memory. After a productive consultation, distil it with `/parley remember <peer>`; parley stores the bullets and prepends them to every future headless ask to that peer from the same project.

| Field | Effect |
|---|---|
| `memory.default` | Whether memory is on for peers that don't declare their own. Default `true`. |
| `memory.peers` | Per-peer overrides keyed by canonical alias, e.g. `{ "taylor": false }`. Wins over the peer's declared flag and the default. |

Resolution order: `memory.peers.<alias>` → the peer's own `memory` flag (`peers.json` or an extension manifest, e.g. a persona's `persona.json`) → `memory.default`. When off, parley neither injects nor accumulates memory for that peer. Memory survives `/parley reset`; it's independent of the cached session pointer.

## Runtime state

Auto-managed under `~/.claude/parley/`:

| Path | Contents |
|---|---|
| `sessions/<sid>/manifest.json` | Per-session registration with heartbeat. Includes `claudeSessionId` captured from the SessionStart hook payload. |
| `sessions/<sid>/inbox/` | Pending messages. Subdirs: `in-progress/`, `read/`. |
| `sessions/<sid>/outbox/` | Sent-message ledger. |
| `headless/<project_id>/<alias>.json` | The peer's session pointer per (asker, peer). Records the last known `claudeSessionId`, `origin: 'live' \| 'headless'`, turn count. Both transports read and write this file so `--resume` works across them. |
| `logs/<project_id>/<alias>.md` | Append-only Q&A transcript per (asker, peer). Includes the actual tier (`live` / `headless-fresh` / `headless-resumed`) for each turn. |
| `memory/<project_id>/<alias>.md` | Durable distilled memory per (asker, peer). A flat `- bullet` list prepended to future headless asks. Written by `parley_remember`; survives `parley_reset`. |
| `locks/<project_id>-<alias>.lock` | Per-(asker, peer) lock to serialize concurrent asks. |
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
- Headless caches for peers no longer in `peers.json`.
- Extension manifests where **every** declared peer's path is missing on disk.

What's flagged but never auto-removed:

- `peers.json` entries whose path doesn't exist on disk. You decide whether to `/parley remove` them.
- Partially-stale extension manifests (some peers live, some gone). That's the extension's job to reconcile.
