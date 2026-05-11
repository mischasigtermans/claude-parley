#!/usr/bin/env bash
# register.sh — Register this Claude Code session as a Parley peer.
# Called by SessionStart hook. Each Claude process gets a fresh session ID;
# multiple Claude windows opened in the same project are independent peers.
# Outputs the 6-char parley session ID on stdout.
set -euo pipefail

command -v jq >/dev/null 2>&1 || {
  echo "parley: jq is required (brew install jq / apt install jq)" >&2
  exit 1
}

PARLEY_DIR="${PARLEY_DIR:-$HOME/.claude/parley}"
PROJECT_DIR="${PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(pwd)}}"

# Detect platform + mode. Mirrors Anthropic's vocabulary from
# https://code.claude.com/docs/en/platforms (platform = cli, desktop, ...).
# Cowork is Desktop's "parallel sessions" feature; we capture that as a sub-mode.
detect_platform_mode() {
  case "$PROJECT_DIR" in
    */local-agent-mode-sessions/*/local_*/outputs)
      echo "desktop cowork"
      return
      ;;
  esac
  case "${CLAUDE_CODE_ENTRYPOINT:-}" in
    cli)         echo "cli code"        ;;
    desktop|app) echo "desktop code"    ;;
    *)           echo "cli code"        ;;
  esac
}
read -r PLATFORM MODE < <(detect_platform_mode)

# Generate the alias. Cowork sessions get cowork-<short> instead of "outputs".
if [ "$PLATFORM/$MODE" = "desktop/cowork" ]; then
  COWORK_LOCAL=$(echo "$PROJECT_DIR" | sed -E 's|.*/local_([^/]+)/outputs.*|\1|')
  COWORK_SHORT=$(echo "$COWORK_LOCAL" | tr -d '-' | tail -c 7 | head -c 6)
  PROJECT_NAME="cowork-$COWORK_SHORT"
else
  PROJECT_NAME="$(basename "$PROJECT_DIR" | tr '[:upper:]' '[:lower:]')"
fi

mkdir -p "$PARLEY_DIR/sessions" "$PARLEY_DIR/by-claude-pid"

# Walk up process tree to find the Claude Code parent PID. The MCP server
# can do the same walk and both will land on the same PID, letting us key
# a sentinel by it.
find_claude_pid() {
  local pid=$$
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    pid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
    [ -z "$pid" ] && return 1
    [ "$pid" -le 1 ] && return 1
    local comm
    comm=$(ps -p "$pid" -o comm= 2>/dev/null | awk '{print $NF}')
    case "$comm" in
      *claude*|*Claude*) printf '%s' "$pid"; return 0 ;;
    esac
  done
  return 1
}
CLAUDE_PID="$(find_claude_pid 2>/dev/null || true)"

now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Generate fresh 6-char session ID.
SESSION_ID="$(set +o pipefail; LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 6)"
SESSION_DIR="$PARLEY_DIR/sessions/$SESSION_ID"
mkdir -p "$SESSION_DIR/inbox" "$SESSION_DIR/outbox"

# Capture Claude Code's full session UUID if exposed via the env file.
CLAUDE_SESSION_UUID=""
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -f "$CLAUDE_ENV_FILE" ]; then
  CLAUDE_SESSION_UUID="$(grep -E '^(CLAUDE_SESSION_ID|SESSION_ID)=' "$CLAUDE_ENV_FILE" | head -1 | cut -d= -f2- || true)"
fi

NOW="$(now)"
TMP="$(mktemp "$SESSION_DIR/manifest.XXXXXX")"
jq -n \
  --arg sid "$SESSION_ID" \
  --arg cuid "$CLAUDE_SESSION_UUID" \
  --arg path "$PROJECT_DIR" \
  --arg name "$PROJECT_NAME" \
  --arg platform "$PLATFORM" \
  --arg mode "$MODE" \
  --arg now "$NOW" \
  --argjson pid "$$" \
  '{
    sessionId: $sid,
    claudeSessionId: ($cuid | select(length > 0) // null),
    projectPath: $path,
    projectName: $name,
    alias: $name,
    platform: $platform,
    mode: $mode,
    startedAt: $now,
    lastHeartbeat: $now,
    status: "registered",
    pid: $pid
  }' > "$TMP"
mv "$TMP" "$SESSION_DIR/manifest.json"

# Write a PID-keyed sentinel so the MCP server can find us regardless of cwd.
if [ -n "$CLAUDE_PID" ]; then
  printf '%s' "$SESSION_ID" > "$PARLEY_DIR/by-claude-pid/$CLAUDE_PID.session"
fi

# Surface the ID to the running session's environment if Claude provided a hook env file.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "PARLEY_SESSION_ID=$SESSION_ID" >> "$CLAUDE_ENV_FILE"
fi

printf '%s' "$SESSION_ID"
