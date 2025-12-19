#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is not installed. Install it with: brew install jq"
  exit 1
fi

# If you pass an argument, we use it. Otherwise, we use a default.
MSG="${1:-Which package do I pick? I am confused.}"

jq -n --arg msg "$MSG" '{
  message: $msg,
  client: {name: "Test Client", ig: "@testclient", phone: "+1-555-555-0000"},
  session_id: "test-cli"
}' | curl -sS -X POST "http://localhost:${PORT:-5050}/api/chat" \
  -H "Content-Type: application/json" \
  --data-binary @- | python3 -m json.tool
