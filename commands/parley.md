---
name: parley
description: Cross-session bridge. Consult other projects' agents from this session. Subcommands: peers, list, discover, ask, listen, add, remove, log, reset, clean, status, stop.
argument-hint: "[action] [args]"
---

# Parley

Manage cross-session communication with other projects on this machine.

Most of the time you don't need this command. Just say things like "ask stagent about X" and the `parley-awareness` skill calls the MCP tools for you. Use the slash command for explicit control or operational tasks.

Parse the user's argument to pick an action. If no argument is given, run the **discovery menu** (see below).

## Actions

### `(no argument)`: discovery menu

1. Call `parley_clean` with `auto: true`. If the result is non-empty, print it as a header.
2. Call `parley_peers`. Print the result.
3. Branch on whether peers exist:

**If no peers are registered AND no live sessions discovered**, print the first-run guide:
   ```
   No peers yet. To get started:

     parley discover                  scan ~/.claude/projects for projects you've used recently
     parley add <alias> <path>        register a peer manually
       e.g. parley add stagent ~/Sites/stagent

   Or open another Claude Code or Cowork session in any project.
   It auto-registers itself the moment its session starts, and shows up here.
   ```

**If peers exist**, print the help block:
   ```
   Common moves:
     parley ask <peer> <question>     send a one-off query (silent unless the peer is listening)
     parley listen                    make THIS window the live answerer for its project
     parley discover                  find more recently-used projects to register
     parley add <alias> <path>        register a new peer
     parley log <alias>               read the Q&A transcript with a peer
     parley clean                     remove dead sessions, dangling PID sentinels, orphan pointers
     parley status [alias]            show bridge state
   Or just speak naturally: "ask <peer> about X", "what does <peer> think of Y", etc.
   ```

### `peers` / `list`

Call `parley_peers`. Print the result.

### `ask <peer> <question…>`

Call `parley_ask` with `peer` = first argument, `question` = remainder of the line. Print the answer.

### `attach <peer> <question…>`

Call `parley_attach` (requires the peer to be in listen mode). Print the answer or the error.

### `discover`

Call `parley_discover`. Print the result. Lists project directories from `~/.claude/projects/` (Claude Code's session history) that aren't yet registered as peers, sorted by last-used time. The user can then `/parley add <alias> <path>` for any they want as a peer.

### `listen`

Make this session the live answerer for its project, then enter the receive loop.

1. Call `parley_listen`. Print the confirmation.
2. Tell the user: "Listening for peer messages... (press Escape to interrupt)"
3. Enter the loop:
   1. Call `parley_receive_next` (this BLOCKS until a message arrives).
   2. Parse the output: lines before `---` are headers (`MESSAGE_ID`, `FROM_ID`, `TO_ID`, `FROM_PROJECT`, `TYPE`, `IN_REPLY_TO`); lines after are the question content.
   3. Branch on `TYPE`:
      - **`query`**: read the question, formulate a complete answer using your full project context (read files, include real code), then call `parley_respond` with `toSessionId=FROM_ID`, `inReplyTo=MESSAGE_ID`, and your answer in `content`.
      - **`ping`**: call `parley_respond` with a short ack ("connected").
      - **`session-ended`**: tell the user "Peer [FROM_PROJECT] disconnected." Continue listening.
      - **`response`**: someone is responding to a question we sent. Display it; the loop continues.
   4. **IMMEDIATELY** call `parley_receive_next` again. Do not stop. Do not ask the user what to do next. The only exit is the user pressing Escape.

**You MUST keep looping.** Each iteration: receive → respond → receive → respond. Never break out unless the user interrupts (Escape).

### `add <alias> <path> [description...]`

Call `parley_add` with `alias`, `path`, and the rest of the argument as `description`. Print confirmation.

### `remove <alias>`

Call `parley_remove`. Print confirmation.

### `log <alias> [tail]`

Call `parley_log` with `alias` and optional `tail` (default 20). Print the transcript.

### `reset <alias>`

Call `parley_reset`. Print confirmation.

### `clean [--dry-run]`

Call `parley_clean`. Pass `dryRun: true` if `--dry-run` was supplied. Print the result. Removes stale session manifests, dead PID sentinels, orphaned project pointers, and headless caches for peers no longer in `peers.json`. Flags missing `peers.json` paths as advisories without removing them. Idempotent.

### `status [alias]`

Call `parley_status` with optional `alias`. Print the report.

### `stop`

Tell the user: "To unregister this session, exit Claude Code. The SessionEnd hook cleans up automatically. To force-clean a stale registration: `rm -rf ~/.claude/parley/sessions/<id>`."

## Unknown action

Print the help block from the no-argument case.
