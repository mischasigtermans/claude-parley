#!/usr/bin/env bash
# send-message.sh: Drop a message JSON into a target session's inbox.
# Usage:   send-message.sh <target-id> <type> <content> [in-reply-to]
# Env:     BRIDGE_SESSION_ID (required): sender's parley session ID
#          PARLEY_DIR (default ~/.claude/parley)
# Outputs: message ID on stdout
set -euo pipefail

TARGET_ID="$1"
MSG_TYPE="$2"
CONTENT="$3"
IN_REPLY_TO="${4:-null}"

PARLEY_DIR="${PARLEY_DIR:-$HOME/.claude/parley}"
SENDER_ID="${BRIDGE_SESSION_ID:?BRIDGE_SESSION_ID must be set}"

TARGET_INBOX="$PARLEY_DIR/sessions/$TARGET_ID/inbox"
SENDER_OUTBOX="$PARLEY_DIR/sessions/$SENDER_ID/outbox"

[ -d "$TARGET_INBOX" ] || { echo "parley: target session $TARGET_ID not found" >&2; exit 1; }
mkdir -p "$SENDER_OUTBOX"

MSG_ID="msg-$(set +o pipefail; LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"
NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

SENDER_PROJECT="unknown"
SENDER_MANIFEST="$PARLEY_DIR/sessions/$SENDER_ID/manifest.json"
[ -f "$SENDER_MANIFEST" ] && SENDER_PROJECT="$(jq -r '.projectName // "unknown"' "$SENDER_MANIFEST")"

if [ "$IN_REPLY_TO" = "null" ]; then
  IN_REPLY_TO_JSON="null"
else
  IN_REPLY_TO_JSON="\"$IN_REPLY_TO\""
fi

MSG_JSON="$(jq -n \
  --arg id "$MSG_ID" \
  --arg from "$SENDER_ID" \
  --arg to "$TARGET_ID" \
  --arg type "$MSG_TYPE" \
  --arg ts "$NOW" \
  --arg content "$CONTENT" \
  --arg fromProject "$SENDER_PROJECT" \
  --argjson inReplyTo "$IN_REPLY_TO_JSON" \
  '{
    id: $id, from: $from, to: $to, type: $type, timestamp: $ts,
    status: "pending", content: $content, inReplyTo: $inReplyTo,
    metadata: { fromProject: $fromProject }
  }')"

TMP="$(mktemp "$TARGET_INBOX/$MSG_ID.XXXXXX")"
printf '%s' "$MSG_JSON" > "$TMP"
mv "$TMP" "$TARGET_INBOX/$MSG_ID.json"

OUTBOX_JSON="$(printf '%s' "$MSG_JSON" | jq '.status = "sent"')"
TMP="$(mktemp "$SENDER_OUTBOX/$MSG_ID.XXXXXX")"
printf '%s' "$OUTBOX_JSON" > "$TMP"
mv "$TMP" "$SENDER_OUTBOX/$MSG_ID.json"

printf '%s' "$MSG_ID"
