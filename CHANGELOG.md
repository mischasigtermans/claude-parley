# Changelog

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
