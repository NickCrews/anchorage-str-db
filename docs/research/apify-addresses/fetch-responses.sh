#!/usr/bin/env bash
# Runs the Apify actor on input.json and writes its output to responses.js.
# Each run uses Apify quota, so it is not re-run automatically.
#
#   APIFY_TOKEN=apify_api_... docs/research/apify-addresses/fetch-responses.sh
set -euo pipefail

ACTOR_ID=fKjuTGhSmE1YcZqSB
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${APIFY_TOKEN:?Set APIFY_TOKEN}"

requested_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
raw="$(mktemp)"
trap 'rm -f "$raw"' EXIT

# run-sync-get-dataset-items waits for the run to finish (up to `timeout` seconds) and returns the dataset.
curl --fail-with-body --silent --show-error --max-time 300 \
  -X POST "https://api.apify.com/v2/acts/$ACTOR_ID/run-sync-get-dataset-items?timeout=280" \
  -H "Authorization: Bearer $APIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  --data @"$HERE/input.json" \
  -o "$raw"

# Stored as a script, not JSON, so review.html can load it when opened from disk.
{
  echo "// Apify actor $ACTOR_ID output for input.json, requested $requested_at."
  echo "// Written by fetch-responses.sh. Stored as a script, not JSON, so review.html can load it when opened from disk."
  printf 'window.APIFY_RESPONSES = '
  jq 'sort_by(.room_id)' "$raw"
  echo ';'
} > "$HERE/responses.js"

echo "wrote $(jq length "$raw") responses to responses.js"
