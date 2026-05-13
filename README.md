# Claude Parley

[![Version](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/mischasigtermans/claude-parley/main/.claude-plugin/plugin.json&query=$.version&label=version&prefix=v)](https://github.com/mischasigtermans/claude-parley)
[![License](https://img.shields.io/github/license/mischasigtermans/claude-parley)](LICENSE)

Talk to your other Claude Code projects from any session.

Parley bundles an MCP server. By default it spawns a headless Claude in the peer's project directory, runs your request with that project's CLAUDE.md, skills, and context loaded, and persists the session so the agent has memory across turns. Per-peer MCP servers can be opted in via `peers.json`. If the peer is open and in `/parley listen` mode, that live window handles it instead.

## Installation

```
/plugin marketplace add mischasigtermans/by-mischa
/plugin install parley@by-mischa
```

### Requires

- Claude Code ≥ 2.1 or Claude Cowork
- `jq` for the SessionStart/SessionEnd hooks. `brew install jq` on macOS, `apt install jq` on Linux.
- macOS or Linux. Windows untested.

## Quick start

Discover projects you've used recently and aren't yet registered:

```
/parley discover
```

You'll see a list of candidate paths. Say which ones to register in plain language:

```
'add the first three as peers'
'register that one as docs and that one as api'
'add ~/projects/example as my-project'
```

The `parley` skill picks up the names and calls `parley_add` for each. From then on, any session can consult them by alias:

```
/parley peers
'ask docs what's our auth strategy'
'check with api how it handles rate limits'
```

You can also be explicit:

```
/parley add my-project ~/code/my-project
/parley ask my-project 'Summarize the current architecture in three bullets.'
/parley log my-project
```

## Features

- Three-tier routing: live peer when listening, resumed headless session when cached, fresh headless spawn otherwise.
- Per-asker-project state. Each calling project gets its own cached session, transcript, and turn count per peer.
- Auto-discovery of recent Claude projects via `/parley discover`.
- Natural-language and slash-command interfaces, both backed by the same skill.
- Append-only transcripts per peer. Full observability of headless turns.
- Works with any MCP-capable client (Claude Desktop, Cursor) by pointing at the bundled MCP server.

## Documentation

- [Commands](docs/commands.md): slash commands and MCP tools reference
- [Routing](docs/routing.md): how Parley picks live, resumed, or fresh
- [Configuration](docs/configuration.md): `peers.json`, runtime state, permission handling, cleanup

## Related

- **[By Mischa](https://github.com/mischasigtermans/by-mischa)** marketplace lists Parley alongside my other Claude Code plugins. One marketplace add, everything reachable.
- **[Personas](https://github.com/mischasigtermans/claude-personas)** uses Parley as its transport. Each enabled persona auto-registers as a parley peer, so 'ask steve what he thinks' works alongside 'ask onoma how it handles X'.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Credits

- [Mischa Sigtermans](https://github.com/mischasigtermans)
- Inspired by Shreyas Patil's [`session-bridge`](https://github.com/shreyaspatil/session-bridge) for the live-session routing pattern.

## License

MIT. See [LICENSE](LICENSE).
