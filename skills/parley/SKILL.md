---
name: parley
description: Lets one Claude Code project consult another on the same machine. Activates when the user references another project or peer agent by name ("ask <peer> about X", "what does <peer> think"), wants several peers to discuss something together ("let steve and taylor debate X", "gather the personas on Y"), or invokes `/parley` to manage peers (list, discover, add, listen, ask, log, gather, room). Drives the listen-mode receive loop when this session answers peers. All routing goes through the `parley` MCP server.
---

# Parley

Lets one Claude Code project consult another on the same machine. Each project becomes a peer agent, addressable by short alias. Peers are real Claude Code sessions running in their own project directories with their own CLAUDE.md, skills, and tools.

State and routing are owned by the `parley` MCP server. **Use the `parley_*` tools for every operation. Never `Bash` peers.json or session manifests.** If a tool seems missing, flag it. Don't fall back to bash.

## How this skill activates

Two paths. Decide which one applies before reading further.

1. **Awareness path.** The user named another project or peer in natural language ("ask <peer> how they handle X", "what does <peer> think", "pull the spec from <peer>"). Take the *resolve → ask* sequence below. Most common case. If the user names two or more peers and wants them to discuss, debate, or weigh in together, take the *gather sequence* instead.
2. **Explicit path.** The user typed `/parley`, `/parley <action>`, or asked operationally ("list peers", "listen", "discover projects"). Jump to *Actions*.

If the user typed `/parley` with no argument, run the *discovery menu* under Actions.

---

## Awareness path

### When to fire

Look for cues that the user wants input from *another* project:

- "ask <peer> how they handle X" / "check with <peer>" / "what does <peer> think"
- "look at how <project> does this" / "pull the spec from <peer>"
- "see what <peer> did for retries" / "the design from <other-project>"
- A project name you recognize from the user's environment that isn't this one.

Don't fire for things obviously about the *current* project.

### Resolve the alias

Always call `parley_peers` first to confirm the alias exists. Match the user's reference against peer aliases or descriptions. If you can't match, ask whether they want to `parley_add` it. Don't guess an alias.

Then run the *ask sequence*.

---

## Actions

Parse the argument the user supplied with `/parley` (or the operational request) and dispatch. The MCP server auto-cleans stale state on the first session-listing call after the 1-hour cooldown expires; no manual sweep call is needed.

### `(no argument)`: discovery menu

1. Call `parley_peers`. Print the result.
2. Branch on whether peers exist:

**If no peers are registered AND no live sessions discovered**, print the first-run guide:
   ```
   No peers yet. To get started:

     parley discover                  scan ~/.claude/projects for projects you've used recently
     parley add <alias> <path>        register a peer manually
       e.g. parley add <peer> ~/code/<peer>

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
     parley gather <peer> <peer>... <question>   run a structured group discussion (add the project as grounder)
     parley room list|log|say|continue|close     manage discussion rooms
     parley remember <peer>           distill the transcript into durable memory
     parley clean                     remove dead sessions and dangling sentinels
   Or just speak naturally: "ask <peer> about X", "what does <peer> think of Y", etc.
   ```

### `peers` / `list`

Call `parley_peers`. Print the result.

### `ask <peer> <question…>`

Run the *ask sequence* below with `peer` = first argument, `question` = the remainder.

### `gather <peer> <peer>... <question…>`

Run the *gather sequence* below with `peers` = every leading argument that matches a peer alias, `question` = the remainder.

### `room <action> [room] [message]`

Call `parley_room` with the action: `list` (rooms for this project), `log <room>` (full transcript), `say <room> <message>` (post a chair message), `continue <room> [rounds]` (run more rounds), `close <room>`. Print the result. After `continue`, synthesize the new turns the same way as after gather.

### `discover`

Call `parley_discover`. Print the result. Lists project directories from `~/.claude/projects/` that aren't yet registered as peers, sorted by last-used time. The user can then `/parley add <alias> <path>` for any they want.

### `listen`

Run the *listen loop* below. It blocks until the user presses Escape.

### `add <alias> <path> [description...]`

Call `parley_add` with `alias`, `path`, and the rest of the argument as `description`. The `description` is OPTIONAL. Pass it only if the user gives one. Do not invent descriptions. Print confirmation.

### `remove <alias>`

Call `parley_remove`. Print confirmation.

### `log <alias> [tail]`

Call `parley_log` with `alias` and optional `tail` (default 20). Print the transcript.

### `reset <alias>`

Call `parley_reset`. Print confirmation. Use when a peer's headless agent has gotten stuck and you want a fresh session next time.

### `remember <peer>`

Distill the conversation with a peer into durable memory. Parley injects that memory into every future headless ask to the peer from this project, so it stays primed across sessions.

1. Call `parley_log` with the peer alias to read the transcript (use `tail: 0` for the full history).
2. Distill it yourself into 3-8 concise `- bullet` takeaways: facts, decisions, preferences, and patterns worth remembering. Persona-agnostic, self-contained lines. Skip pleasantries and one-off specifics.
3. Call `parley_remember` with `peer` and the `bullets` string. It dedupes against existing memory and reports how many were added.

If `parley_remember` reports memory is off for the peer, the user disabled it (in `~/.claude/parley/config.json` under `memory.peers`, or the peer's own config). Don't force it.

### `clean [--dry-run]`

Call `parley_clean`. Pass `dryRun: true` if `--dry-run` was supplied. Print the result. Removes stale session manifests, dead PID sentinels, and headless caches for peers no longer in `peers.json`. Idempotent. The MCP server runs the same sweep automatically once per hour, so explicit cleans are only needed for ad-hoc inspection.

### `stop`

Tell the user: *"To unregister this session, exit Claude Code. The SessionEnd hook cleans up automatically. To force-clean a stale registration: `rm -rf ~/.claude/parley/sessions/<id>`."*

### Unknown action

Print the "Common moves" hint from the discovery menu.

---

## Ask sequence (shared by awareness and `/parley ask`)

Once you have a confirmed peer alias and a user question:

1. **Craft the question.** The peer is a separate Claude session. It cannot see this conversation, your code, or your context. Treat the question like a self-contained prompt:
   - State the goal in one sentence.
   - Include any relevant snippet, error, or file content the peer needs.
   - Be specific about what you want back ("send the actual function signature, not a description").

2. **Call `parley_ask`** with `peer` and `question`. The router picks one of three routes automatically:
   - **Live**: peer has `/parley listen` running. The query goes to their inbox; their agent answers in-window.
   - **Headless resumed**: previous headless session cached. Calls `claude --resume <sid> -p "..."` in the peer's cwd.
   - **Headless fresh**: first time (or after `parley_reset`). Spawns a new `claude -p`. Subsequent calls reuse that session.

   You don't pick the route. The response prefix tells you when it routed live: `[peer · live]`. Headless (the silent default) shows as just `[peer]`. Resume vs fresh is recorded in the transcript log only.

3. **Display the answer**, then **act on it**. Don't just dump and stop. If the peer told you a type signature, apply it. If they described a migration step, run it. If they asked a follow-up, answer it (`parley_ask` again, same peer; the headless session resumes).

4. **Keep memory current.** If `parley_ask`'s response ends with a `[parley: N turns ... not yet distilled]` nudge, run the `remember` action for that peer (read the transcript, distill, `parley_remember`). Also do this proactively after a productive consultation, or before resuming a peer that `parley_peers` shows with turns "to distill". This is how memory stays reliable without any session hook.

---

## Gather sequence (group discussion)

Use when the user wants two or more peers to discuss something together rather than answer one by one. Personas and project peers mix freely.

1. **Confirm the aliases** with `parley_peers`. Every participant must be a listed peer.
2. **Craft the question** as a self-contained prompt, same rules as the ask sequence. Peers see only the question and the room transcript.
3. **Call `parley_gather`** with `peers` and `question`. Default 3 rounds. Round 1 is blind (everyone answers independently, in parallel), later rounds are sequential with each peer seeing what was said since its last turn. Peers reply `PASS` when they have nothing to add; the room converges when everyone passes. Advisors are told this project's path and may read it to check facts (`projectAccess: false` withholds it).
   - **When the question is about a codebase, add its project peer as a grounder**: `grounders: ['<project>']`. A grounder doesn't advise; it verifies the others' factual claims against its own code and data, corrects wrong ones with file references, and runs checks the advisors propose. It speaks first each round so the advisors argue over checked facts, not over the chair's framing. If the project isn't a peer yet, `parley_add` it first.
   - **You are the chair, and you have the code too.** If a participant disputes a fact or asks for a measurement you can run, run it and post the result with `parley_room say` before `parley_room continue`. Don't let a checkable claim ride through three rounds unchecked.
4. **Synthesize.** The tool returns the whole transcript. Don't dump it. Report where the participants agree, where they disagree and why, and what each one's strongest point was. Quote a line when it carries the argument. Then give the user your own read.
5. **Keep it going when useful.** If the user has a follow-up or wants to steer, `parley_room say` posts it as chair, then `parley_room continue` runs another round. `parley_room log` shows the full transcript. `parley_room close` ends it.

Every peer turn runs through the same per-peer session as `parley_ask`, so the peer's memory and transcript stay continuous. Distil with `remember` afterwards as usual.

## Listen loop (`/parley listen`)

Make this session the live answerer for its project, then run the receive loop.

1. Call `parley_listen`. Its return value contains the addressable form `alias:sid` for this session. Print that line verbatim so the user can copy the sid.
2. Tell the user: *"Listening for peer messages as `<alias:sid>`... (press Escape to interrupt)"*. Substitute the actual `alias:sid` from step 1's return.
3. Enter the loop:
   1. Call `parley_receive_next` (this BLOCKS until a message arrives).
   2. Parse the output: lines before `---` are headers (`MESSAGE_ID`, `FROM_ID`, `TO_ID`, `FROM_PROJECT`, `TYPE`, `IN_REPLY_TO`); lines after are the content.
   3. Branch on `TYPE`:
      - **`query`**: read the question, formulate a complete answer using your full project context (read real files, paste actual code, don't just describe). Call `parley_respond` with `toSessionId=FROM_ID`, `inReplyTo=MESSAGE_ID`, and your answer in `content`.
      - **`ping`**: call `parley_respond` with a short ack ("connected").
      - **`session-ended`**: tell the user *"Peer [FROM_PROJECT] disconnected."* Continue listening.
      - **`response`**: someone is responding to a question we sent. Display it; the loop continues.
   4. **IMMEDIATELY** call `parley_receive_next` again. Do not stop. Do not ask the user what to do next.

**You MUST keep looping.** Each iteration: receive → respond → receive → respond. **Never break out unless the user interrupts (Escape).**

### Always respond, even on failure

Every consumed `query` (or `ping`) MUST be paired with a `parley_respond` call. The MCP server only marks a message fully read when `parley_respond` fires; if you skip it, the server will recover the message after 5 minutes and re-deliver it on the next `parley_receive_next`. That re-delivery is a safety net, not a feature.

If you cannot answer a query (tool failure, the question doesn't apply, you got confused), call `parley_respond` anyway with a short failure note in `content` (e.g. *"Couldn't read X: <error>. Ask again with more context."*). The asker is waiting; a failure ack is far better than silence.

---

## Don'ts

- Don't call `parley_ask` without first calling `parley_peers` to confirm the alias.
- Don't fabricate peer aliases. If `parley_peers` doesn't list the project the user mentioned, ask whether to `parley_add` it.
- Don't fabricate descriptions when calling `parley_add`. The `description` arg is optional. Only pass what the user gave you.
- Don't call Parley for things obviously about the current project.
- Don't break the listen loop after answering a single query. The user exits by pressing Escape.
- Don't `Bash` peers.json, session manifests, or routing state. Every operation goes through a `parley_*` MCP tool.
