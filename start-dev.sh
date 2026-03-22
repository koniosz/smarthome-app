#!/bin/bash
export PATH="/Users/konradsz/.nvm/versions/node/v24.13.0/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Starting Smart Home Manager (dev mode)..."

# Install deps if needed
cd "$DIR/backend" && npm install --ignore-scripts --silent 2>&1 | tail -1
cd "$DIR/frontend" && npm install --ignore-scripts --silent 2>&1 | tail -1

# Start backend (tsx watch = auto-reload on file changes)
cd "$DIR/backend"
node node_modules/.bin/tsx watch src/index.ts &
BACKEND_PID=$!
echo "Backend started (PID $BACKEND_PID) on http://localhost:4001"

# Start frontend
cd "$DIR/frontend"
node node_modules/.bin/vite "$DIR/frontend" --port 3001 &
FRONTEND_PID=$!
echo "Frontend started (PID $FRONTEND_PID) on http://localhost:3001"

sleep 2
open "http://localhost:3001" 2>/dev/null || true

echo ""
echo "Smart Home Manager is running!"
echo "   Frontend: http://localhost:3001"
echo "   Backend:  http://localhost:4001"
echo ""
echo "Press Ctrl+C to stop both servers."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait
