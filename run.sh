#!/usr/bin/env bash
# Start the journal: API on :8000, UI on :5173. Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "$0")"

[ -f data/journal.db ] || python3 -m server.demo
[ -d web/node_modules ] || (cd web && npm install)

python3 -m uvicorn server.api:app --port 8000 &
API=$!
trap 'kill $API 2>/dev/null' EXIT

cd web && npm run dev -- --port 5173 --strictPort
