# Configuration

## peers.json

User-curated peer list. Hand-editable. `parley_add` and `parley_remove` mutate it for you.

Location: `~/.claude/parley/peers.json`

```json
{
  "peers": {
    "stagent": {
      "path": "~/Sites/stagent",
      "description": "Booking and management platform for agencies and artists",
      "skipPermissions": false
    },
    "onoma": {
      "path": "~/Github/mischasigtermans/onoma",
      "description": "Memory layer for AI"
    }
  }
}
```

Per-peer fields:

| Field | Type | Effect |
|---|---|---|
| `path` | string | Absolute or `~`-expanded path to the peer's project root. |
| `description` | string | Shown in `/parley peers` and used by the skill to pick between peers. |
| `skipPermissions` | boolean | Default `true`. Headless spawns pass `--dangerously-skip-permissions` to avoid tool prompts. |
| `model` | string | Optional model override for headless spawns. |
| `mcpServers` | object | Optional per-peer MCP server overrides. |
| `type` | string | Optional classification. Cooperating plugins set this to mark what a peer represents (e.g. `'persona'`). |

## Runtime state

Auto-managed under `~/.claude/parley/`:

| Path | Contents |
|---|---|
| `sessions/<sid>/manifest.json` | Per-session registration with heartbeat. |
| `sessions/<sid>/inbox/` | Pending messages. Subdirs: `in-progress/`, `read/`. |
| `sessions/<sid>/outbox/` | Sent-message ledger. |
| `headless/<project_id>/<alias>.json` | Cached headless session ID + turn count per (asker, peer). |
| `logs/<project_id>/<alias>.md` | Append-only Q&A transcript per (asker, peer). |
| `locks/<project_id>-<alias>.lock` | Per-(asker, peer) lock to serialize concurrent asks. |
| `state.json` | Runtime metadata (last-clean timestamp, etc.). |

## Permission handling

Headless spawns pass `--dangerously-skip-permissions` by default. To opt out per peer:

```json
"stagent": {
  "path": "~/Sites/stagent",
  "skipPermissions": false
}
```

Then ensure the project has a `.claude/settings.local.json` allowlist covering what the agent will need.

## Cleanup

Parley accumulates state per session. When Claude Code crashes, gets killed, or you reboot, sessions can leave behind stale manifests. The discovery menu (`/parley` with no argument) auto-runs cleanup once every 7 days, so you rarely invoke it directly. To clean on demand: `/parley clean`, or `/parley clean --dry-run` to preview.

What gets removed:

- Session manifests whose owning process is dead AND last heartbeat was more than 1 hour ago.
- `by-claude-pid/` sentinels for processes that no longer exist.
- `.claude/parley-session` pointers in projects whose target session has been cleaned up.
- Headless caches for peers no longer in `peers.json`.

What's flagged but never auto-removed:

- `peers.json` entries whose path doesn't exist on disk. You decide whether to `/parley remove` them.

`listSessions()` self-heals on every call: any manifest whose process is dead and heartbeat older than 1 hour is removed inline, so `/parley peers` stays accurate without an explicit clean.
