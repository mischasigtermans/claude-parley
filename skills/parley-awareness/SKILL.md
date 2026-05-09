---
name: parley-awareness
description: Activates when the user references another project or agent by name. Routes parley_* MCP tool calls to consult the right peer, and drives the listen-mode receive loop when this session answers peers.
---

# Parley Awareness

You can consult other Claude Code projects on this machine via the Parley MCP tools. Each peer is a real Claude agent running in its own project directory with its own CLAUDE.md, skills, and tools, addressed by short alias (e.g. `stagent`, `onoma`, `steve`).

## When to call Parley tools

Call `parley_peers` first whenever the user mentions another project by name or asks for input from another codebase. Look for cues like:

- "ask stagent how they handle X" / "check with onoma" / "what does <peer> think"
- "look at how <project> does this" / "pull the spec from <peer>"
- "see what <peer> did for retries" / "the design from <other-project>"
- A project name you recognize from the user's environment that isn't this one

After `parley_peers`, match the user's reference against the peer aliases (or the descriptions). Then call `parley_ask` with the matched alias. Don't guess an alias. Confirm it exists in the peers list first.

## What `parley_ask` does

It routes one of three ways automatically:

1. **Live**. Peer has a Claude Code window open and is in `/parley listen` mode. The query goes into their inbox; their agent answers in-window; the response routes back to you. The user may see it happen on the other side.
2. **Headless resumed**. No live listener, but a previous headless session is cached. Parley calls `claude --resume <sid> -p "<your question>"` in the peer's cwd, so the agent has memory of prior parley turns.
3. **Headless fresh**. First time talking to this peer (or after `parley_reset`). Parley spawns a new `claude -p` in the peer's cwd. Subsequent calls reuse that session.

You don't pick the route. The router does. The response prefix tells you which route was used: `[stagent via headless-resumed]`.

## Crafting the question

The peer is a separate Claude session. It cannot see this conversation, your code, or your context. Treat the question like a self-contained prompt:

- State your goal in one sentence.
- Include any relevant snippet, error, or file content the peer needs.
- Be specific about what you want back ("send the actual function signature, not a description").

If the peer's first answer is incomplete, follow up with another `parley_ask` to the same peer. It will resume from the cached headless session and see the prior turn.

## Acting on the answer

When `parley_ask` returns, **use the answer to continue the user's task**. Don't just dump it. If the peer told you a type signature, apply it. If the peer described a migration step, run it. If the peer asked you a follow-up question, answer it and ask again.

## Listening mode

When the user runs `/parley listen`, you become the live answerer for this project. The slash command file gives the loop instructions. Critical points:

- The loop is `parley_receive_next` → branch on type → `parley_respond` → repeat.
- **Never break the loop on your own.** The user exits by pressing Escape.
- When answering a `query`: read real files in this project, paste actual code in your response, don't just describe.
- Use `FROM_ID` and `MESSAGE_ID` from the received message header as `toSessionId` and `inReplyTo` when responding.

## Operational tools

- `parley_status`: see this session's state, configured peers, cached headless sessions
- `parley_log <alias>`: read past Q&A with a peer
- `parley_reset <alias>`: clear cached headless session if a peer agent has gotten stuck
- `parley_add <alias> <path>`: register a new peer. The `description` is OPTIONAL. Pass it only if the user gives one as a hint. Do not invent descriptions to "be helpful."
- `parley_remove <alias>`: unregister
- `parley_attach <peer> <question>`: same as parley_ask but errors out if peer isn't in live listen mode (use only when the user explicitly wants live)

## Don'ts

- Don't call `parley_ask` without first calling `parley_peers` to confirm the alias.
- Don't fabricate descriptions when calling `parley_add`. The `description` argument is optional. Only set it when the user provides one explicitly.
- Don't call Parley for things that are obviously about the current project. Only when the user specifically wants another project's perspective or context.
- Don't break the listen loop after answering a single query. The user exits by pressing Escape.
- Don't fabricate peer aliases. If `parley_peers` doesn't list the project the user mentioned, ask whether they want to `parley_add` it.
