#!/bin/bash
export PATH="/Users/konradsz/.nvm/versions/node/v24.13.0/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building Smart Home Manager..."

# Install deps
cd "$DIR/backend" && npm install --ignore-scripts --silent 2>&1 | tail -1
cd "$DIR/frontend" && npm install --ignore-scripts --silent 2>&1 | tail -1

# Start backend
cd "$DIR/backend"
node node_modules/.bin/tsx src/index.ts &
BACKEND_PID=$!
echo "Backend running on http://localhost:4001"

# Build & start frontend preview
cd "$DIR/frontend"
node node_modules/.bin/vite build "$DIR/frontend" --outDir "$DIR/frontend/dist"
node node_modules/.bin/vite preview "$DIR/frontend" --port 4174 &
FRONTEND_PID=$!

sleep 2
open "http://localhost:4174"

echo ""
echo "Smart Home Manager is running!"
echo "   App: http://localhost:4174"
echo ""
echo "Press Ctrl+C to stop."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait
