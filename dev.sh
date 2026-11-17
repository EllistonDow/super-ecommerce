#!/usr/bin/env bash
# ==============================================================================
# Super Ecommerce - Full-Stack Local Launcher (Apple Container + Rust N-API + Node 22)
# ==============================================================================

set -eo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_MGR="$ROOT_DIR/docker/manage-containers.sh"

ACTION="${1:-start}"

if [ "$ACTION" == "stop" ]; then
  echo "🛑 [Super Ecommerce] Stopping API server on port 4100..."
  pids=$(lsof -ti :4100 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
  fi
  if [ "${2:-}" == "--all" ] || [ "${2:-}" == "-a" ]; then
    "$CONTAINER_MGR" stop
  fi
  echo "✅ Stopped."
  exit 0
elif [ "$ACTION" == "status" ]; then
  echo "📊 [Super Ecommerce] Stack Status:"
  echo "  - Apple Container PG (5438): $(nc -z 127.0.0.1 5438 2>/dev/null && echo '🟢 Running' || echo '🔴 Stopped')"
  echo "  - Dual-Protocol API (4100):  $(nc -z 127.0.0.1 4100 2>/dev/null && echo '🟢 Running' || echo '🔴 Stopped')"
  "$CONTAINER_MGR" status
  exit 0
fi

echo "========================================================================"
echo "⚡ Starting Super Ecommerce Full Stack (Apple Container + Rust Kernel)"
echo "========================================================================"

echo "🐳 [1/3] Ensuring Apple Container PostgreSQL (super-postgres:5438) is running..."
"$CONTAINER_MGR" start

echo "🗄️  [2/3] Applying PostgreSQL 17 DDL & Seeding CQRS Projections + MSI Quants..."
node --experimental-strip-types "$ROOT_DIR/packages/db/src/pg-container-bootstrap.ts"

echo "🚀 [3/3] Starting Super Ecommerce Server on http://localhost:4100 ..."
exec npm start
