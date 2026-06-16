#!/usr/bin/env bash
# get-session-id.sh: Resolve the Parley session ID for the current Claude
# Code session.
# Strategy:
#   1. $PARLEY_SESSION_ID env var
#   2. Walk the process tree to find Claude Code's PID and read the
#      $PARLEY_DIR/by-claude-pid/<pid>.session sentinel
#   3. Cross-check against $PARLEY_DIR/sessions/<id>/manifest.json
# Exits 0 with the session ID on stdout; exits 1 if not found.
set -euo pipefail

PARLEY_DIR="${PARLEY_DIR:-$HOME/.claude/parley}"

if [ -n "${PARLEY_SESSION_ID:-}" ]; then
  if [ -f "$PARLEY_DIR/sessions/$PARLEY_SESSION_ID/manifest.json" ]; then
    printf '%s' "$PARLEY_SESSION_ID"
    exit 0
  fi
fi

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
  SENTINEL="$PARLEY_DIR/by-claude-pid/$CLAUDE_PID.session"
  if [ -f "$SENTINEL" ]; then
    SID="$(cat "$SENTINEL")"
    if [ -f "$PARLEY_DIR/sessions/$SID/manifest.json" ]; then
      printf '%s' "$SID"
      exit 0
    fi
  fi
fi

exit 1
