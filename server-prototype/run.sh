#!/usr/bin/env bash
# Start the Reference Viewer prototype.
#   ./run.sh            -> http://127.0.0.1:8000
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8000}"
echo "Reference Viewer → http://127.0.0.1:${PORT}"
exec python3 -m uvicorn app:app --host 127.0.0.1 --port "${PORT}" "$@"
