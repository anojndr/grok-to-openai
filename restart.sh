#!/usr/bin/env bash
# Restart the grok-to-openai proxy on port 15553.
#   - kills any running instance (managed or background)
#   - starts it again detached (nohup + disown)
#   - prints a copy-paste tail command and exits (does NOT block)
set -euo pipefail

cd "$(dirname "$0")" || exit 1
PORT="${GROK_PORT:-15553}"
LOG="${GROK_LOG:-server.log}"
PIDFILE="${GROK_PIDFILE:-server.pid}"

log() { printf '\033[1;36m%s\033[0m\n' "$*"; }

log "[1/3] Stopping any running grok proxy on port $PORT ..."

# Kill via our pidfile first (safest when we started it)
if [ -f "$PIDFILE" ]; then
    OLD_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        CMD="$(tr '\0' ' ' < "/proc/$OLD_PID/cmdline" 2>/dev/null || true)"
        case "$CMD" in
            *server.py*) kill "$OLD_PID" 2>/dev/null || true ;;
        esac
    fi
    rm -f "$PIDFILE" 2>/dev/null || true
fi

# Nuke any remaining process running our server (bracket trick avoids matching
# this script's own command line)
pkill -f '[p]ython.*[s]erver\.py' 2>/dev/null || true
pkill -f '[u]vicorn.*server:app' 2>/dev/null || true

# Wait for the port to be free
for _ in $(seq 1 40); do
    if ! (exec 3<>/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then
        break
    fi
    exec 3>&- 2>/dev/null || true
    sleep 0.25
done

exec 3>&- 2>/dev/null || true
sleep 1

log "[2/3] Starting proxy in the background (logs -> $LOG) ..."
nohup ./.venv/bin/python server.py >>"$LOG" 2>&1 &
disown
echo $! > "$PIDFILE"
NEW_PID="$(cat "$PIDFILE")"

# Wait for readiness
for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done

if curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null >/dev/null; then
    log "[3/3] Running (pid $NEW_PID)."
    log "Copy-paste OpenAI-compatible base URL:"
    printf '\n  http://127.0.0.1:%s/v1\n\n' "$PORT"
    LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [ -n "${LAN_IP:-}" ]; then
        log "From another device on your network:"
        printf '\n  http://%s:%s/v1\n\n' "$LAN_IP" "$PORT"
    fi
    log "Copy-paste to follow logs (Ctrl-C stops tailing, proxy keeps running):"
    printf '\n  tail -f %s/%s\n\n' "$(pwd)" "$LOG"
    exit 0
else
    log "Startup failed; last log lines:"
    tail -n 30 "$LOG" 2>/dev/null || true
    exit 1
fi