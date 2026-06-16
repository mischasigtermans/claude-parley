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
'add ~/code/<peer> as <peer>'
```

The `parley` skill picks up the names and calls `parley_add` for each. From then on, any session can consult them by alias:

```
/parley peers
'ask docs what's our auth strategy'
'check with api how it handles rate limits'
```

You can also be explicit:

```
/parley add <peer> ~/code/<peer>
/parley ask <peer> 'Summarize the current architecture in three bullets.'
/parley log <peer>
```

## Features

- **One continuous conversation per (project, `<peer>`).** Live and headless transports share a session pointer; the next ask resumes the same claude session whichever path runs.
- **Headless by default.** `fallback = "headless"` spawns `claude -p` in the peer's directory (draws from your Agent SDK credit pool). No window pops open. To answer at zero SDK credit instead, open the peer and run `/parley listen`; an already-listening window handles the ask live. Set `fallback = "ask"` in `~/.claude/parley/config.json` to be prompted each time no listener exists.
- **Per-asker-project state.** Each calling project gets its own cached session, transcript, and turn count per `<peer>`.
- **Auto-discovery** of recent Claude projects via `/parley discover`.
- **Extensions** (e.g. personas plugin) can register peers by dropping a manifest at `~/.claude/parley/extensions/`. See [docs/extensions.md](docs/extensions.md).
- **Natural-language and slash-command interfaces**, both backed by the same skill.
- **Append-only transcripts per `<peer>`.** Full observability of every turn.
- **Works with any MCP-capable client** (Claude Desktop, Cursor) by pointing at the bundled MCP server.

## Documentation

- [Commands](docs/commands.md): slash commands and MCP tools reference
- [Routing](docs/routing.md): how Parley picks live, resumed, or fresh; session pointer / `--resume` continuity
- [Configuration](docs/configuration.md): `peers.json`, `config.json`, runtime state, permission handling, cleanup
- [Extensions](docs/extensions.md): how other plugins register peers with Parley

## Related

- **[By Mischa](https://github.com/mischasigtermans/by-mischa)** marketplace lists Parley alongside my other Claude Code plugins. One marketplace add, everything reachable.
- **[Personas](https://github.com/mischasigtermans/claude-personas)** uses Parley as its transport. Each enabled persona auto-registers as a parley peer, so 'ask steve what he thinks' works alongside any of your registered project peers.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Credits

- [Mischa Sigtermans](https://mischa.sigtermans.me)
- Inspired by Shreyas Patil's [`session-bridge`](https://github.com/shreyaspatil/session-bridge) for the live-session routing pattern.

## License

MIT. See [LICENSE](LICENSE).
