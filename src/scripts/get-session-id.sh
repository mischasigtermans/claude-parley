#!/usr/bin/env bash
# get-session-id.sh — Resolve the Parley session ID for the current Claude
# Code session, even if the agent has cd'd into a subdirectory.
# Strategy:
#   1. $PARLEY_SESSION_ID env var
#   2. Walk up from $PWD to find .claude/parley-session
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

DIR="${PROJECT_DIR:-$(pwd)}"
while [ "$DIR" != "/" ] && [ -n "$DIR" ]; do
  POINTER="$DIR/.claude/parley-session"
  if [ -f "$POINTER" ]; then
    SID="$(cat "$POINTER")"
    if [ -f "$PARLEY_DIR/sessions/$SID/manifest.json" ]; then
      printf '%s' "$SID"
      exit 0
    fi
  fi
  DIR="$(dirname "$DIR")"
done

exit 1
