#!/usr/bin/env bash
# Start the grok-to-openai proxy on port 15553.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi
exec .venv/bin/python server.py "$@"