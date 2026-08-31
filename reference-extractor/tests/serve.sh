#!/bin/sh
# Serve the repo so the e2e harness can fetch dataset files, then open it.
# Usage: sh reference-extractor/tests/serve.sh [port]
PORT="${1:-8000}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
echo "serving $ROOT on http://localhost:$PORT"
echo "harness: http://localhost:$PORT/reference-extractor/tests/harness.html"
cd "$ROOT" && exec python3 -m http.server "$PORT"
