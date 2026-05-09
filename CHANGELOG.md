# Changelog

## [0.2.1] - 2026-05-09

- Merged `/parley` slash command and `parley-awareness` skill into a single `parley` skill. Single source of truth for triggers, actions, and the listen loop. The slash command still works (now routed through the skill).
- Fixed silent message loss in the listen loop. `parley_receive_next` now moves messages into a new `inbox/in-progress/` state instead of marking them read. `parley_respond` is what completes the transition to `read/`. If a listener consumes a query but never responds, a heartbeat sweep returns the message to the inbox after 10 minutes so the next `parley_receive_next` redelivers it. At-least-once delivery; the responder needs to be idempotent for repeat queries.
- `parley_ask` timeout errors now include the message's current location (pending, in-progress, read, or pruned) so the caller knows whether to wait, retry, or give up.
- Listen-loop skill contract: every consumed query MUST result in `parley_respond`, even on failure (send a short error ack). Silence is the bug.

## [0.2.0] - 2026-05-09

- Initial release
