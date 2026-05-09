#!/usr/bin/env bash
# cleanup.sh — Tear down this session's Parley registration on SessionEnd.
# Notifies any peers who've connected (sent us a ping) so they can clear their
# view of us. Removes the session directory.
set -euo pipefail

command -v jq >/dev/null 2>&1 || exit 0

PARLEY_DIR="${PARLEY_DIR:-$HOME/.claude/parley}"
PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"
POINTER="$PROJECT_DIR/.claude/parley-session"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

[ -f "$POINTER" ] || exit 0
SESSION_ID="$(cat "$POINTER")"
SESSION_DIR="$PARLEY_DIR/sessions/$SESSION_ID"
[ -d "$SESSION_DIR" ] || { rm -f "$POINTER"; exit 0; }

# Find Claude Code's PID (same walk as register.sh) and clear its sentinel.
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
if [ -n "$CLAUDE_PID" ]; then
  rm -f "$PARLEY_DIR/by-claude-pid/$CLAUDE_PID.session"
fi

# Notify connected peers (those who've pinged us) that we're going away.
if [ -d "$SESSION_DIR/inbox" ]; then
  PEERS="$(find "$SESSION_DIR/inbox" -name '*.json' -exec jq -r 'select(.type == "ping") | .from' {} \; 2>/dev/null | sort -u)"
  for PEER in $PEERS; do
    [ -d "$PARLEY_DIR/sessions/$PEER/inbox" ] || continue
    BRIDGE_SESSION_ID="$SESSION_ID" bash "$SCRIPT_DIR/send-message.sh" "$PEER" session-ended "peer disconnected" >/dev/null 2>&1 || true
  done
fi

rm -rf "$SESSION_DIR"
rm -f "$POINTER"
