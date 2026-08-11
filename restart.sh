#!/usr/bin/env bash
#
# restart.sh - restart the grok-to-openai bridge.
#
# Usage:
#   ./restart.sh               Stop any running instance, then start in the
#                              foreground (same as `npm start`).
#   ./restart.sh --background  Stop any running instance, then start detached,
#                              logging to .data/server.log.
#
# Safe to run when the server is already running: the old process is stopped
# gracefully (SIGTERM, with a grace period for browser shutdown), leftover
# browser processes are cleaned up, the port is verified free, and only then
# is a fresh instance started.

set -euo pipefail

cd "$(dirname "$0")"

MODE="foreground"
for arg in "$@"; do
  case "$arg" in
    -b | --background) MODE="background" ;;
    -h | --help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--background]" >&2
      exit 2
      ;;
  esac
done

# --- read port/host/api key from .env ----------------------------------------
env_port=""
env_host=""
env_key=""
if [[ -f ".env" ]]; then
  env_port="$(grep -E '^PORT=' .env | tail -n 1 | cut -d= -f2- | tr -d '"')"
  env_host="$(grep -E '^HOST=' .env | tail -n 1 | cut -d= -f2- | tr -d '"')"
  env_key="$(grep -E '^BRIDGE_API_KEY=' .env | tail -n 1 | cut -d= -f2- | tr -d '"')"
fi
PORT="${env_port:-62774}"
HOST="${env_host:-127.0.0.1}"
API_KEY="${env_key:-}"

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "Invalid PORT in .env: $PORT" >&2
  exit 1
fi

STOP_GRACE_SECONDS=45  # server shutdown timeout (30s) + browser close margin
START_TIMEOUT_SECONDS=90

command -v npm >/dev/null 2>&1 || {
  echo "npm not found in PATH" >&2
  exit 1
}
NPM_BIN="$(command -v npm)"

# --- process helpers -----------------------------------------------------------
alive() { # true if pid exists and is not a zombie
  local stat
  stat="$(ps -o stat= -p "$1" 2>/dev/null || true)"
  [[ -n "$stat" && "$stat" != *Z* ]]
}

server_pids() { # pids of `node src/server.js` and its sh/npm wrapper
  pgrep -f 'node src/server\.js' || true
}

port_is_listening() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q .
  else
    (exec 3<>"/dev/tcp/$HOST/$PORT") 2>/dev/null
  fi
}

# --- stop any running instance -------------------------------------------------
pids="$(server_pids)"
if [[ -n "$pids" ]]; then
  echo "Stopping running grok-to-openai (pid(s): $(echo "$pids" | tr '\n' ' '))..."
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true

  alive_pids=""
  for _ in $(seq 1 "$STOP_GRACE_SECONDS"); do
    alive_pids=""
    for pid in $pids; do
      if alive "$pid"; then
        alive_pids="$alive_pids $pid"
      fi
    done
    [[ -z "$alive_pids" ]] && break
    sleep 1
  done

  if [[ -n "$alive_pids" ]]; then
    echo "Still alive after ${STOP_GRACE_SECONDS}s, force-killing:$alive_pids" >&2
    # shellcheck disable=SC2086
    kill -KILL $alive_pids 2>/dev/null || true
  fi
fi

# leftover headless Chrome from a force-killed run would hold profile locks
profile_pattern="--user-data-dir=$PWD/.browser-profile"
if pgrep -f "$profile_pattern" >/dev/null 2>&1; then
  echo "Stopping leftover browser processes from a previous run..."
  pkill -TERM -f "$profile_pattern" 2>/dev/null || true
  sleep 3
  pkill -KILL -f "$profile_pattern" 2>/dev/null || true
fi

# wait until the port is actually free before binding
for _ in $(seq 1 10); do
  port_is_listening || break
  sleep 1
done

# --- start ----------------------------------------------------------------------
if [[ "$MODE" == "background" ]]; then
  mkdir -p .data
  nohup "$NPM_BIN" start >>.data/server.log 2>&1 &
  bg_pid=$!
  echo "Started grok-to-openai (pid $bg_pid), log: .data/server.log"

  for _ in $(seq 1 "$START_TIMEOUT_SECONDS"); do
    if ! alive "$bg_pid"; then
      echo "Server exited immediately; last log lines:" >&2
      tail -n 30 .data/server.log >&2
      exit 1
    fi
    if BRIDGE_API_KEY="$API_KEY" HOST="$HOST" PORT="$PORT" node -e '
      const key = process.env.BRIDGE_API_KEY;
      fetch(`http://${process.env.HOST}:${process.env.PORT}/healthz`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
      })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((j) => {
          if (!j.ok) throw new Error("healthz not ok");
        })
        .catch(() => process.exit(1));
    ' >/dev/null 2>&1; then
      echo "grok-to-openai listening on http://$HOST:$PORT"
      exit 0
    fi
    sleep 1
  done

  echo "Timed out waiting for grok-to-openai to start; last log lines:" >&2
  tail -n 30 .data/server.log >&2
  exit 1
fi

# foreground: same behavior as `npm start`
echo "Starting grok-to-openai (foreground, Ctrl-C to stop)..."
exec "$NPM_BIN" start
