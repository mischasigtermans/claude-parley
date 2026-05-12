# Changelog

## [0.3.0] - 2026-05-12

Per-asker-project scoping for headless peer state plus a full cleanup pass. Each asking project now gets its own cached Claude session, transcript log, and turn count with each peer. Cross-asker context isolation by default. Four-persona review surfaced trivials, refactors, type-system upgrades, and two product kills that all land in this release.

**Breaking**

- Sid cache now keyed by `(asker_project_id, peer)` instead of `(peer)` alone. State moves to `~/.claude/parley/headless/<project_id>/<alias>.json`.
- Transcript log scoped per `(asker_project_id, peer)`. State moves to `~/.claude/parley/logs/<project_id>/<alias>.md`.
- Lock files scoped per `(asker_project_id, peer)`: `~/.claude/parley/locks/<project_id>-<alias>.lock`.
- `parley_peers` History column shows turns from the calling project, not global. Visible behaviour change: users upgrading will see lower History counts. A `--global` aggregate flag may land in a later release if needed.
- `parley_log <alias>` shows transcript from the calling project, not global.
- `parley_reset <alias>` only clears the calling project's cached session, not other projects'.
- `HeadlessRecord` gains `projectId: ProjectId`. Record is now self-describing.
- `readHeadless(alias)` → `readHeadless(projectId, alias)`.
- `clearHeadless(alias)` → `clearHeadless(projectId, alias)`.
- `appendTurn(...)` and `readTranscript(...)` gain `projectId` as first parameter.
- Removed `mode` parameter from `parley_ask`. The concise preamble is now always prepended on headless asks. The `mode: deep` escape hatch was speculative and rarely used.
- Removed `defaults` block from `peers.json`. Per-peer `model`, `mcpServers`, and `skipPermissions` settings still work; the global defaults layer was never used in practice. Stray `defaults` blocks are silently ignored on read.

**Added**

- `paths.projectId(cwd)` (async): SHA1 of git remote URL when available, fallback to CWD. First 12 hex chars. Matches the personas plugin's algorithm so the two plugins compute identical IDs from the same CWD.
- `paths.headlessProjectDir(projectId)` and `paths.logsProjectDir(projectId)` helpers for sweep/diagnostic tools.
- Branded `ProjectId` type. Function signatures that took `string` for project IDs now take `ProjectId`; argument-order swaps fail to compile.
- `ParleyContext.getProjectId()` with server-lifetime memoization. Subsequent `parley_*` calls within a session no longer fork `git config` repeatedly.
- `isHeadlessRecord(v)` type guard. `readHeadless` returns `null` on corrupt cache files instead of feeding garbage to `--resume`.
- `ToolDef<TArgs>` is generic. Each tool can declare a typed `parseArgs(raw)`; the dispatcher applies it before invoking `handler`. Eleven tools migrated; defensive `String(args.peer)` coercion in handlers is gone.

**Changed**

- `sweep` walks the new nested `headless/<projectId>/<alias>.json` layout. Empty `<projectId>/` subdirectories under `headless/` and `logs/` are pruned by a new `sweepEmptyProjectDirs` pass; `SweepRemoved.projectDirs` tracks them.
- `sweepHeadless` reports `<projectId>/<alias>` instead of bare alias, so the same alias removed from multiple project dirs no longer collapses.
- `router.ts` defers `resolvePeerConfig`-style work into the headless branch; the live route no longer pays the cost.
- `queue.ts` collapses three duplicated message-read loops (`waitForMessage`, `recoverStuckInProgress`, `listInbox`) into one async generator `readMessages(dir)`.
- `waitForMessage` and `recoverStuckInProgress` return freshly-constructed `Message` objects with the post-disk status instead of mutating the parsed object in place.
- `parleyPeers`'s `pushRowsForPath` is hoisted to module level (it closed over nothing).
- `parley_clean` description now accurately reflects that the auto-clean flag is invoked by the `/parley` skill, not the server.

**Fixed**

- Version string in `server.ts` now matches `plugin.json` (was lagging at `0.2.2`).
- `atomicWriteJSON` no longer does a dynamic `import('node:fs/promises')` for `rename`; statically imported.
- Magic `15` in `session-resolver.ts:findClaudePid` named as `MAX_ANCESTOR_DEPTH` with a comment explaining why.

**Migration**

No automatic migration of caches or logs. Existing global `~/.claude/parley/headless/<alias>.json` and `~/.claude/parley/logs/<alias>.md` files become orphaned and can be deleted manually. First call to each peer from each project triggers a fresh headless session.

**Required upgrade step:** delete `~/.claude/parley/locks/*.lock` before installing v0.3.0. Stale locks from pre-scoped paths become invisible to the new scoped lock paths and can cause silent hangs.

## [0.2.3] - 2026-05-11

Cleanup release: correctness fixes and a leaner API.

**Breaking**

- Removed `parley_attach`. Live-only routing is no longer a separate tool; `parley_ask` chooses the route automatically.
- Removed `parley_status`. Use `parley_peers` for peer state and `parley_discover` for unregistered Claude projects.

**Correctness**

- Fix race in `waitForMessage`: rename-as-claim pattern means concurrent readers no longer double-deliver the same message.
- Skip SIGTERM during sweep when the project path is gone (the PID is likely recycled).
- `readManifest` rejects manifests with unparseable `lastHeartbeat` instead of treating them as "live forever".
- `register.sh` retries on session-ID collision (`mkdir` without `-p` fails atomically on EEXIST).
- Router uses an exhaustive switch on `ListeningResolution` so new variants surface as compile errors.

**Cleanup**

- Dead code removed: `resolvePeerConfig`, `findLiveByPath`, `fromProjectPath` on `AskInput`, `agent: 'claude'` hardcode, `SweepScope`, `killed` field on `SweepRemoved`, the per-tool `autoSweep` and its `lastAutoSweepAt` state key.
- Auto-clean lives in one place: the skill calls `parley_clean({auto: true})` at the top of every `/parley` action with a 1-hour cooldown.

## [0.2.2] - 2026-05-11

- Multi-session per project. Each Claude Code window in the same repo registers its own parley session and shows up as a separate row in `parley_peers`. Listening sessions are addressable individually as `alias:sid` (e.g. `parley_ask onoma:a6v9lk "..."`). With 2+ listening sessions for the same path and no `:sid` suffix, the router returns an error listing the live sids so the caller can pick.
- Auto-generated aliases are lowercased. `basename` of the project path is normalized to lowercase before becoming the alias, so `~/Github/MyProject` registers as `myproject`. Aliases supplied via `parley_add` are preserved verbatim.
- `parley_peers` table reshape. New columns: `Peer | Source | Mode | History | Path | Notes`. One headless row per peer (always present, with active-window count in Notes). Plus one listening row per `/parley listen` session, addressable as `alias:sid`. `Source` shows `Code` / `Code CLI` / `Cowork` / `-` based on the underlying client.
- `parley_status` flags Claude Code projects active in the last 60 minutes that have no parley registration. Catches the case where the SessionStart hook didn't fire (e.g. plugin enabled after Claude was already open).
- `parley_peers` now auto-sweeps stale `by-claude-pid/` sentinels at most once per 60 seconds. Stops the sentinel directory from growing unbounded between explicit `parley_clean` calls.
- Dropped the `<project>/.claude/parley-session` pointer file. Self-identification goes through `PARLEY_SESSION_ID` (env) or the PID sentinel under `~/.claude/parley/by-claude-pid/<claudePid>.session`. Existing pointer files are harmless and will be cleaned up by the next session-end of the process that wrote them; you can also delete them by hand.
- Removed the `pointers` field from `SweepResult.removed` and the corresponding `parley_clean` reporting line.

## [0.2.1] - 2026-05-09

- Merged `/parley` slash command and `parley-awareness` skill into a single `parley` skill. Single source of truth for triggers, actions, and the listen loop. The slash command still works (now routed through the skill).
- Fixed silent message loss in the listen loop. `parley_receive_next` now moves messages into a new `inbox/in-progress/` state instead of marking them read. `parley_respond` is what completes the transition to `read/`. If a listener consumes a query but never responds, a heartbeat sweep returns the message to the inbox after 10 minutes so the next `parley_receive_next` redelivers it. At-least-once delivery; the responder needs to be idempotent for repeat queries.
- `parley_ask` timeout errors now include the message's current location (pending, in-progress, read, or pruned) so the caller knows whether to wait, retry, or give up.
- Listen-loop skill contract: every consumed query MUST result in `parley_respond`, even on failure (send a short error ack). Silence is the bug.

## [0.2.0] - 2026-05-09

- Initial release
