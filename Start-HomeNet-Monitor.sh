#!/bin/bash

PROJECT="$HOME/homenet-monitor"
LOGS="$PROJECT/logs"

mkdir -p "$LOGS"

# Start backend if it is not already running
if ! curl -fsS http://localhost:3001/api/health >/dev/null 2>&1; then
    cd "$PROJECT/server" || exit 1
    nohup npm run dev > "$LOGS/backend.log" 2>&1 < /dev/null &
fi

# Start frontend if it is not already running
if ! curl -fsS http://localhost:5173/ >/dev/null 2>&1; then
    cd "$PROJECT/client" || exit 1
    nohup npm run dev -- --host 127.0.0.1 > "$LOGS/frontend.log" 2>&1 < /dev/null &
fi

# Wait for dashboard, then open browser
for i in {1..30}; do
    if curl -fsS http://localhost:5173/ >/dev/null 2>&1; then
        xdg-open http://localhost:5173/
        exit 0
    fi
    sleep 1
done

xdg-open http://localhost:5173/
