#!/usr/bin/env bash
# cleanup.sh: Tear down this session's Parley registration on SessionEnd.
# Notifies any peers who've connected (sent us a ping) so they can clear their
# view of us. Removes the session directory.
set -euo pipefail

# Hooks launched from Desktop inherit launchd's bare PATH. Append the dirs
# Homebrew and local installs put jq in; an already-resolvable jq still wins.
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

# Headless spawns never registered (see register.sh), so they have nothing to
# tear down. Skip to avoid touching another session's state.
[ -n "${PARLEY_SUPPRESS_REGISTER:-}" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

PARLEY_DIR="${PARLEY_DIR:-$HOME/.claude/parley}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Find Claude Code's PID (same walk as register.sh) and read its sentinel.
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
[ -n "$CLAUDE_PID" ] || exit 0

SENTINEL="$PARLEY_DIR/by-claude-pid/$CLAUDE_PID.session"
[ -f "$SENTINEL" ] || exit 0
SESSION_ID="$(cat "$SENTINEL")"
SESSION_DIR="$PARLEY_DIR/sessions/$SESSION_ID"

rm -f "$SENTINEL"

[ -d "$SESSION_DIR" ] || exit 0

# Notify connected peers (those who've pinged us) that we're going away.
if [ -d "$SESSION_DIR/inbox" ]; then
  PEERS="$(find "$SESSION_DIR/inbox" -name '*.json' -exec jq -r 'select(.type == "ping") | .from' {} \; 2>/dev/null | sort -u)"
  for PEER in $PEERS; do
    [ -d "$PARLEY_DIR/sessions/$PEER/inbox" ] || continue
    BRIDGE_SESSION_ID="$SESSION_ID" bash "$SCRIPT_DIR/send-message.sh" "$PEER" session-ended "peer disconnected" >/dev/null 2>&1 || true
  done
fi

rm -rf "$SESSION_DIR"
