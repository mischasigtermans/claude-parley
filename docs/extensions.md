# Extensions

Other Claude Code plugins can register peers with Parley by dropping a manifest file. The host plugin owns the contents. Parley scans the directory and merges the peers into its registry.

## Manifest location

```
~/.claude/parley/extensions/<extension-name>.json
```

One file per extension. Filename is informational only; the extension's display name comes from the manifest's `name` field (fallback: filename without `.json`).

## Schema

```json
{
  "name": "personas",
  "version": "0.1.0",
  "description": "Optional one-line summary",
  "peers": [
    {
      "alias": "steve",
      "path": "/abs/path/to/peer/project",
      "description": "Optional human-readable hint",
      "type": "persona"
    }
  ]
}
```

Field rules:

| Field | Required | Notes |
|---|---|---|
| `name` | optional | Display name. Defaults to the filename (e.g. `personas.json` → `personas`). |
| `version` | optional | Informational. Not validated. |
| `description` | optional | Informational. Not validated. |
| `peers` | required (array) | Empty array means "extension registered, no peers right now." |
| `peers[].alias` | required | Same rules as `parley_add` aliases. Must be unique across all extension peers. |
| `peers[].path` | required | Absolute path. `~` expansion is applied. |
| `peers[].description` | optional | Surfaced in `parley_peers` notes. |
| `peers[].type` | optional | Free-form classifier (e.g. `persona`). Used only for display hints; parley treats all peers identically for routing. |
| `peers[].model` | optional | Model the headless spawn uses for this peer (e.g. `opus`). Passed as `claude --model`. |
| `peers[].mcpServers` | optional | MCP servers to expose to the headless spawn. Same shape as `peers.json` `mcpServers`. |
| `peers[].skipPermissions` | optional | Boolean. Passes `--dangerously-skip-permissions` for this peer. Falls back to `permissions.skip_default` when unset. |

Entries missing `alias` or `path` are skipped. Malformed JSON is skipped silently. Your extension doesn't break parley if the file is bad, but the peers won't show up either.

## Behavior

**Discovery / listing.** Extension peers appear in `parley_peers` alongside user-curated peers, marked `from <extension>` in the notes column. They're also addressable directly via `parley_ask peer=<alias> ...`.

**Precedence.** User-curated `peers.json` wins. If an alias exists in both `peers.json` and an extension manifest, the user's entry is used and the extension's entry is shadowed silently.

**Routing.** Extension peers route the same as any other `<peer>`: through the live tier if a listener exists, otherwise via the configured `fallback` (headless / ask).

**No allowlist.** All manifests in the extensions directory are scanned. v0.3.0 does not gate which extensions can register; a future version may add an opt-in allowlist if multiple extensions exist and isolation becomes useful.

## Maintenance

Your plugin is responsible for keeping the manifest accurate:

- Write/update the manifest when peers are added or removed
- Use `mkdir -p ~/.claude/parley/extensions` before writing
- Atomic writes recommended (write to `.tmp` then `rename`)

Parley's auto-clean removes manifest files where **every** declared peer's path is missing on disk. Partially-stale manifests (some peers live, some gone) are left alone. That's the extension's job to reconcile.

## Example: personas plugin

The personas plugin writes a manifest like this when one or more personas are enabled in a project:

```json
{
  "name": "personas",
  "version": "0.2.0",
  "description": "Persona advisors backed by knowledge modules",
  "peers": [
    {
      "alias": "steve",
      "path": "/Users/me/.claude/plugins/cache/by-mischa/steve-jobs/0.1.0",
      "description": "Channels Steve Jobs's documented decision frameworks",
      "type": "persona"
    },
    {
      "alias": "raymond",
      "path": "/Users/me/.claude/plugins/cache/by-mischa/raymond-hettinger/0.1.0",
      "description": "Pythonic code review",
      "type": "persona"
    }
  ]
}
```

The user can immediately `parley_ask peer=steve "..."` without ever calling `parley_add`.
