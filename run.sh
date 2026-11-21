#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
[ -f .env ] || cp .env.example .env
# Fetch camera-analysis assets once so the browser never depends on a CDN (safe to fail).
python scripts/download_vision_assets.py || echo "Vision assets not downloaded yet; the server will retry at startup."
python -m backend.realtime.agent dev &
AGENT_PID=$!
trap 'kill "$AGENT_PID" 2>/dev/null || true' EXIT
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
