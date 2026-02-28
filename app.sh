#!/usr/bin/env bash
# app.sh — Start MeanTime backend and frontend dev server
set -e

REPO="$(cd "$(dirname "$0")" && pwd)"

# Load .env
if [ -f "$REPO/.env" ]; then
  set -a; source "$REPO/.env"; set +a
else
  echo "Warning: .env not found — backend may fail" >&2
fi

# Backend
echo "==> Starting backend  → http://localhost:3001"
cd "$REPO/backend"
npm install --silent 2>/dev/null
node --import tsx/esm src/index.ts &
BACKEND_PID=$!

# Frontend
echo "==> Starting frontend → http://localhost:5173"
cd "$REPO/frontend"
npm install --silent 2>/dev/null
npm run dev &
FRONTEND_PID=$!

echo ""
echo "  Backend:  http://localhost:3001"
echo "  Frontend: http://localhost:5173"
echo ""
echo "  Ctrl+C to stop"

trap 'kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo "Stopped."' INT TERM
wait $BACKEND_PID $FRONTEND_PID
