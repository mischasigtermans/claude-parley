# Changelog

## [0.4.1] - 2026-07-18

Parley works from Claude Desktop and Cowork, not just the CLI.

**Fixed**

- **Claude binary resolution.** The driver spawned a bare `claude`, which only resolves when the MCP server inherits a shell PATH. Under Desktop and Cowork the server starts from launchd, whose PATH omits `~/.local/bin`, so every headless ask failed with ENOENT. `resolveClaudeBin()` now tries `PARLEY_CLAUDE_BIN`, `~/.local/bin/claude`, `~/.claude/bin/claude` and `/usr/local/bin/claude` before falling back to the bare command, and caches the result. An explicit `PARLEY_CLAUDE_BIN` is trusted as-is so a wrong path fails loudly instead of silently resolving elsewhere.
- **Desktop sessions were labeled `cli`.** Desktop sets `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, which the platform detection in `register.sh` didn't recognise, so every Desktop session fell through to the CLI label and `parley_peers` reported its source as `Code CLI`. The `claude-desktop` value now maps to `desktop`, and an unrecognised entrypoint records `unknown` (rendered as `-`) instead of guessing `cli`.
- **jq resolution in hook scripts.** `register.sh`, `cleanup.sh` and `send-message.sh` resolve jq via PATH, which under Desktop is launchd's bare default and misses Homebrew installs at `/opt/homebrew/bin`. A failed lookup meant the session never registered, leaving discovery and messaging with nothing to find. The scripts now append `/opt/homebrew/bin` and `/usr/local/bin` to PATH; a jq that already resolves keeps precedence.
- **`parley_discover` sees Desktop and Cowork projects.** Discovery only read `~/.claude/projects/`, the CLI's own index, so projects used exclusively from Desktop never showed up. It now also reads parley's session manifests at `~/.claude/parley/sessions/<sid>/manifest.json`, written by the `register.sh` hook on every platform. Results from both sources are merged and deduplicated by path, keeping the most recent timestamp. Ephemeral Cowork output dirs (`local-agent-mode-sessions`) are excluded.

## [0.4.0] - 2026-06-17

Durable per-peer memory. Parley now carries what you learned from a peer across sessions: distil a conversation into bullets, and every future headless ask to that peer from the same project arrives pre-primed with them. Memory lives in parley (not the personas plugin), applies to every peer, and is opt-out per peer.

**Added**

- **Durable memory store.** `~/.claude/parley/memory/<projectId>/<alias>.md`, a flat `- bullet` list keyed by the peer's canonical alias (so all of a persona's aliases share one file). `src/registry/memory.ts` exposes `readMemory`, `appendMemoryBullets` (deduped, lock-guarded), and `clearMemory`. Dedup key is the bullet text lowercased, leading `- ` stripped, first 60 chars.
- **`parley_remember` tool.** Pure storage: the calling agent distils the transcript (via `parley_log`) into 3-8 bullets and passes them in; parley dedupe-appends and advances the peer's high-water mark. No extra `claude -p` spawn. Off-peer memory returns a no-op message.
- **Memory injection.** On a headless ask, if memory exists for the peer it's prepended to the prompt between the concise preamble and the question, under `[your memory from past conversations with this project]`. Empty memory injects nothing (zero overhead).
- **Dirty tracking.** `HeadlessRecord` gains `rememberedTurn` (the turnCount at the last `parley_remember`). A peer is "dirty" when `turnCount > rememberedTurn`. `parley_ask` appends a `[parley: N turns ... not yet distilled]` nudge at ≥3 pending turns; `parley_peers` shows an `N to distill` note. Detection is durable and hook-free; the skill flushes in-conversation.
- **Per-peer memory toggle.** New `memory` section in `config.json` (`{ "memory": { "default": true, "peers": { "<alias>": false } } }`). Precedence: per-peer config override → the peer's own declared `memory` flag (`peers.json` or an extension manifest) → config default. `PeerConfig.memory` and `ExtensionPeer.memory` carry the declared flag; personas can opt out via `persona.json`.

**Changed**

- `AskResult` gains `pending` (turns since last distillation).
- `sweepEmptyProjectDirs` also prunes empty `memory/<projectId>/` dirs; the removed-dir label now uses `basename(root)`. Individual memory files are never auto-deleted.
- `parley_reset` is unchanged: it clears the session pointer but leaves memory intact, so accumulated knowledge survives a reset.

## [0.3.0] - 2026-05-19

Per-asker-project scoping for headless peer state, and one continuous conversation per (project, `<peer>`) across transports. Each asking project gets its own cached Claude session, transcript log, and turn count with each peer. Closing a Terminal between turns no longer loses memory. The next ask resumes the cached claude session whether it routes live again or falls back to headless.

**Breaking**

- `mode` parameter removed from `parley_ask`. The concise preamble is now always prepended on headless asks. The `mode: deep` escape hatch was speculative and rarely used.
- `defaults` block removed from `peers.json`. Per-peer `model`, `mcpServers`, and `skipPermissions` settings still work; the global defaults layer was never used in practice.

**Added**

- **Per-asker-project scoping.** `paths.projectId(cwd)` returns SHA1 of the git remote URL when available, falling back to CWD. First 12 hex chars. The personas plugin uses the same algorithm so both compute identical IDs from the same CWD. `paths.headlessProjectDir(projectId)` and `paths.logsProjectDir(projectId)` helpers for sweep/diagnostic tools. Branded `ProjectId` type so function signatures that took `string` for project IDs now take `ProjectId`; argument-order swaps fail to compile. `ParleyContext.getProjectId()` memoizes for server lifetime, so subsequent `parley_*` calls within a session don't fork `git config` repeatedly.
- **Session pointer in the headless cache.** After a successful live answer, parley writes the listener's `claudeSessionId` into `~/.claude/parley/headless/<projectId>/<alias>.json` with `origin: "live"`. The next `parley_ask` (live or headless) resumes the same claude session. `HeadlessRecord` gains an `origin?: 'live' | 'headless'` field.
- **Listener-match on multi-listener peers.** When 2+ `/parley listen` sessions exist for the same project path, the router prefers the one whose `claudeSessionId` matches the asker's cached pointer (a thread continuation) before falling back to the existing disambiguation error.
- **`SessionStart` hook captures claude's session UUID.** `register.sh` reads the hook payload from stdin and writes `session_id` into `manifest.claudeSessionId`. Was previously always `null`. Older Claude Code versions still work via the `CLAUDE_ENV_FILE` fallback.
- **New `fallback` config knob.** `~/.claude/parley/config.json`:
  ```json
  {
    "runtime": { "fallback": "headless" },
    "permissions": { "skip_default": true }
  }
  ```
  - `headless` (default): spawn `claude -p` immediately, charging the Agent SDK credit pool. No window opens.
  - `ask`: error with options listed; the skill prompts the user in natural language. Open the peer and run `/parley listen` to answer live at zero SDK credit.
  Env override: `PARLEY_FALLBACK`.
- **Extensions mechanism.** Plugins can register peers by dropping a manifest at `~/.claude/parley/extensions/<name>.json` listing the peers they expose. Parley merges those into `parley_peers` and resolves them in `parley_ask` like any other peer. Extension peers carry `model`, `mcpServers`, and `skipPermissions` through to the headless spawn, same as `peers.json` entries. User-curated `peers.json` wins on alias collision. See [`docs/extensions.md`](docs/extensions.md) for the schema.
- **Server-side lazy auto-clean.** The MCP server runs the same sweep that `parley_clean` does, lazily on `listLiveSessions` after a 1-hour cooldown. The `parley_clean({auto: true})` skill instruction is dropped. No more wasted tool roundtrip on every `/parley` action.
- `isHeadlessRecord(v)` type guard. `readHeadless` returns `null` on corrupt cache files instead of feeding garbage to `--resume`.
- `ToolDef<TArgs>` is generic. Each tool can declare a typed `parseArgs(raw)`; the dispatcher applies it before invoking `handler`. Eleven tools migrated; defensive `String(args.peer)` coercion in handlers is gone.
- `PeerConfig.type?: string` field. Optional type classification (e.g. `'persona'`). Cooperating plugins set this to mark what a peer represents; user-managed entries leave it absent.

**Changed**

- **Config moves from TOML to JSON.** `~/.claude/parley/config.toml` becomes `~/.claude/parley/config.json`. One-time auto-migration on first read: if `config.toml` exists, parley parses it, writes the equivalent `config.json`, and deletes the old file. Nothing for users to do.
- **State scoped per (asker_project_id, `<peer>`).** Sid cache moves to `~/.claude/parley/headless/<projectId>/<alias>.json`. Transcript log moves to `~/.claude/parley/logs/<projectId>/<alias>.md`. Lock files become `~/.claude/parley/locks/<projectId>-<alias>.lock`. `parley_peers` History column, `parley_log <alias>`, and `parley_reset <alias>` are scoped to the calling project.
- `HeadlessRecord` gains `projectId: ProjectId`. Record is self-describing.
- `readHeadless(alias)` → `readHeadless(projectId, alias)`.
- `clearHeadless(alias)` → `clearHeadless(projectId, alias)`.
- `appendTurn(...)` and `readTranscript(...)` gain `projectId` as first parameter.
- `sweep` walks the new nested `headless/<projectId>/<alias>.json` layout. Empty `<projectId>/` subdirectories under `headless/` and `logs/` are pruned by a new `sweepEmptyProjectDirs` pass; `SweepRemoved.projectDirs` tracks them.
- `sweepHeadless` reports `<projectId>/<alias>` instead of bare alias, so the same alias removed from multiple project dirs no longer collapses.
- `router.ts` defers `resolvePeerConfig`-style work into the headless branch; the live route no longer pays the cost.
- `queue.ts` collapses three duplicated message-read loops (`waitForMessage`, `recoverStuckInProgress`, `listInbox`) into one async generator `readMessages(dir)`.
- `waitForMessage` and `recoverStuckInProgress` return freshly-constructed `Message` objects with the post-disk status instead of mutating the parsed object in place.
- `parleyPeers`'s `pushRowsForPath` is hoisted to module level (it closed over nothing).
- `parley_clean` description now accurately reflects that the auto-clean flag is invoked by the `/parley` skill, not the server.
- **`--strict-mcp-config` dropped from `claude -p` invocations.** The peer's own `.claude/settings.local.json` MCP servers now load in headless spawns, matching the README's promise. `--mcp-config` is passed only when `peers.json:mcpServers` is non-empty (additive merge).
- **Response prefix.** `parley_ask` returns `[<peer>]\n\n<answer>` for headless (the silent default), `[<peer> · live]` when the peer answered in their own window. Tier value (`live` / `headless-fresh` / `headless-resumed`) stays in the transcript log for forensics.
- **`parley_peers` Path column renamed to Location.** Plugin-managed peers render as `<plugin>@<marketplace>`, which isn't a path. The column header is now honest.
- **`[permissions] skip_default` config knob.** Global default for headless `--dangerously-skip-permissions`. Default `true`. Set `false` in `config.json` to require explicit per-peer opt-in. Per-peer `skipPermissions` in `peers.json` always wins.
- **`parley_ask` default timeout raised from 5 min to 30 min.** Execution work (running tests, multi-file edits) routinely takes 20+ min. Tool description updated so the AI leaves `timeoutMs` unset by default. Env override: `PARLEY_ASK_TIMEOUT_MS`.

**Removed**

- **`parley_clean` `auto` arg.** The auto-cooldown logic moved server-side. Explicit `/parley clean` still works for ad-hoc inspection. The `--dry-run` flag is unchanged.

**Fixed**

- Version string in `server.ts` now matches `plugin.json` (was lagging at `0.2.2`).
- `atomicWriteJSON` no longer does a dynamic `import('node:fs/promises')` for `rename`; statically imported.
- Magic `15` in `session-resolver.ts:findClaudePid` named as `MAX_ANCESTOR_DEPTH` with a comment explaining why.
- **Legacy `config.toml` migration preserves the source on parse failure.** Previously a malformed TOML was silently replaced with a defaulted `config.json` and the original deleted. Now the migration only deletes the legacy file when at least one field parsed; on total parse failure, a stderr warning prints and the TOML stays put.
- **Extension peer aliases are validated.** Manifests declaring path-traversal aliases (e.g. `"../foo"`) are dropped with a stderr advisory instead of being interpolated into filenames under `headless/`, `logs/`, `locks/`.
- **`readParleyConfig` surfaces non-ENOENT errors.** Previously `EACCES`/`EPERM` silently fell back to defaults (including `skip_default: true`). Now permission errors propagate to the tool surface.
- **One session per peer across all its aliases.** Headless cache, transcript, and `parley_reset` now key on the peer's canonical alias, not the typed one. Asking a multi-alias peer (e.g. a persona reachable as `steve`, `steve-jobs`, or `jobs`) by different aliases resumes one continuous session instead of forking a fresh one per alias. The `parley_peers` History column reflects the same key.
- **Headless spawns no longer self-register as peers.** A `claude -p` spawned by `parley_ask` inherits `PARLEY_SUPPRESS_REGISTER=1`, so its `SessionStart` hook skips registration. Transient queries no longer leave phantom "active windows" in the session registry.

**Known assumptions**

- Single user. The live-tier session-pointer writeback in `router.ts` is not lock-guarded; two overlapping live replies can race on `turnCount` / `claudeSessionId`. Acceptable for v0.3.0 where concurrent multi-process use is not supported. Headless asks ARE serialised via per-(asker, peer) file lock.

## [0.2.3] - 2026-05-11

**Breaking**

- `parley_attach` removed. Live-only routing is no longer a separate tool; `parley_ask` chooses the route automatically.
- `parley_status` removed. Use `parley_peers` for peer state and `parley_discover` for unregistered Claude projects.

**Changed**

- Auto-clean lives in one place: the skill calls `parley_clean({auto: true})` at the top of every `/parley` action with a 1-hour cooldown.
- Dead code removed: `resolvePeerConfig`, `findLiveByPath`, `fromProjectPath` on `AskInput`, `agent: 'claude'` hardcode, `SweepScope`, `killed` field on `SweepRemoved`, the per-tool `autoSweep` and its `lastAutoSweepAt` state key.

**Fixed**

- Race in `waitForMessage`: rename-as-claim pattern means concurrent readers no longer double-deliver the same message.
- Skip SIGTERM during sweep when the project path is gone (the PID is likely recycled).
- `readManifest` rejects manifests with unparseable `lastHeartbeat` instead of treating them as 'live forever'.
- `register.sh` retries on session-ID collision (`mkdir` without `-p` fails atomically on EEXIST).
- Router uses an exhaustive switch on `ListeningResolution` so new variants surface as compile errors.

## [0.2.2] - 2026-05-11

**Added**

- Multi-session per project. Each Claude Code window in the same repo registers its own parley session and shows up as a separate row in `parley_peers`. Listening sessions are addressable individually as `alias:sid` (e.g. `parley_ask peer:a6v9lk '...'`). With 2+ listening sessions for the same path and no `:sid` suffix, the router returns an error listing the live sids so the caller can pick.
- `parley_status` flags Claude Code projects active in the last 60 minutes that have no parley registration. Catches the case where the SessionStart hook didn't fire (e.g. plugin enabled after Claude was already open).
- `parley_peers` auto-sweeps stale `by-claude-pid/` sentinels at most once per 60 seconds. Stops the sentinel directory from growing unbounded between explicit `parley_clean` calls.

**Changed**

- Auto-generated aliases are lowercased. `basename` of the project path is normalized to lowercase before becoming the alias, so `~/Github/MyProject` registers as `myproject`. Aliases supplied via `parley_add` are preserved verbatim.
- `parley_peers` table reshape. New columns: `Peer | Source | Mode | History | Path | Notes`. One headless row per peer (always present, with active-window count in Notes). Plus one listening row per `/parley listen` session, addressable as `alias:sid`. `Source` shows `Code` / `Code CLI` / `Cowork` / `-` based on the underlying client.
- Dropped the `<project>/.claude/parley-session` pointer file. Self-identification goes through `PARLEY_SESSION_ID` (env) or the PID sentinel under `~/.claude/parley/by-claude-pid/<claudePid>.session`.
- Removed the `pointers` field from `SweepResult.removed` and the corresponding `parley_clean` reporting line.

## [0.2.1] - 2026-05-09

**Changed**

- Merged `/parley` slash command and `parley-awareness` skill into a single `parley` skill. Single source of truth for triggers, actions, and the listen loop. The slash command still works (now routed through the skill).
- `parley_ask` timeout errors now include the message's current location (pending, in-progress, read, or pruned) so the caller knows whether to wait, retry, or give up.
- Listen-loop skill contract: every consumed query MUST result in `parley_respond`, even on failure (send a short error ack). Silence is the bug.

**Fixed**

- Silent message loss in the listen loop. `parley_receive_next` now moves messages into a new `inbox/in-progress/` state instead of marking them read. `parley_respond` completes the transition to `read/`. If a listener consumes a query but never responds, a heartbeat sweep returns the message to the inbox after 10 minutes so the next `parley_receive_next` redelivers it. At-least-once delivery; the responder needs to be idempotent for repeat queries.

## [0.2.0] - 2026-05-09

- Initial release.
