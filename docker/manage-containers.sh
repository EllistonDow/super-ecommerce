#!/usr/bin/env bash
# ==============================================================================
# Super Ecommerce - Apple Container Infrastructure Manager
# Uses /opt/homebrew/bin/container with external NVMe storage volume
# (/Volumes/samsung2tb980pro/DeveloperData/apple-container)
# ==============================================================================

set -eo pipefail

ACTION=${1:-status}
CONTAINER_BIN="/opt/homebrew/bin/container"

PG_CONTAINER_NAME="super-postgres"
PG_VOLUME_NAME="super-postgres-data"
PG_HOST_PORT="${SUPER_PG_PORT:-5438}"
PG_USER="${SUPER_PG_USER:-super}"
PG_PASSWORD="${SUPER_PG_PASSWORD:-superpassword}"
PG_DB="${SUPER_PG_DB:-super_ecommerce}"

if [ ! -x "$CONTAINER_BIN" ]; then
  echo "❌ Apple Container CLI not found at: $CONTAINER_BIN"
  exit 1
fi

ensure_volume() {
  if ! "$CONTAINER_BIN" volume list | awk '{print $1}' | grep -qx "$PG_VOLUME_NAME"; then
    echo "💾 Creating Apple Container named volume: $PG_VOLUME_NAME ..."
    "$CONTAINER_BIN" volume create "$PG_VOLUME_NAME"
  fi
}

start_containers() {
  echo "🚀 [Super Ecommerce] Starting Apple Container PostgreSQL ($PG_CONTAINER_NAME on port $PG_HOST_PORT:5432)..."
  ensure_volume

  if ! "$CONTAINER_BIN" list --all | awk '{print $1}' | grep -qx "$PG_CONTAINER_NAME"; then
    echo "📦 Creating & starting $PG_CONTAINER_NAME ($PG_HOST_PORT:5432) [volume: $PG_VOLUME_NAME]..."
    "$CONTAINER_BIN" run -d --name "$PG_CONTAINER_NAME" -p "${PG_HOST_PORT}:5432" \
      -v "${PG_VOLUME_NAME}:/var/lib/postgresql/data" \
      -e PGDATA=/var/lib/postgresql/data/pgdata \
      -e POSTGRES_USER="$PG_USER" \
      -e POSTGRES_PASSWORD="$PG_PASSWORD" \
      -e POSTGRES_DB="$PG_DB" \
      postgres:16-alpine
  elif ! "$CONTAINER_BIN" list | awk '{print $1}' | grep -qx "$PG_CONTAINER_NAME"; then
    echo "🔄 Starting existing $PG_CONTAINER_NAME container..."
    "$CONTAINER_BIN" start "$PG_CONTAINER_NAME"
  else
    echo "✅ $PG_CONTAINER_NAME is already running."
  fi

  echo "⏳ Waiting for PostgreSQL wire port 127.0.0.1:${PG_HOST_PORT} to accept connections..."
  for i in {1..30}; do
    if nc -z 127.0.0.1 "$PG_HOST_PORT" 2>/dev/null; then
      echo "✅ $PG_CONTAINER_NAME is accepting TCP connections on 127.0.0.1:${PG_HOST_PORT}."
      break
    fi
    sleep 1
  done

  echo ""
  echo "📊 [Super Ecommerce] Apple Container Status:"
  "$CONTAINER_BIN" list | grep -E "ID|$PG_CONTAINER_NAME" || true
}

stop_containers() {
  echo "🛑 Stopping $PG_CONTAINER_NAME..."
  "$CONTAINER_BIN" stop "$PG_CONTAINER_NAME" 2>/dev/null || true
  echo "✅ Stopped $PG_CONTAINER_NAME."
}

clean_containers() {
  echo "🧹 Deleting $PG_CONTAINER_NAME..."
  "$CONTAINER_BIN" delete -f "$PG_CONTAINER_NAME" 2>/dev/null || true
  echo "✅ Deleted $PG_CONTAINER_NAME."
}

case "$ACTION" in
  start)
    start_containers
    ;;
  stop)
    stop_containers
    ;;
  clean)
    clean_containers
    ;;
  status)
    "$CONTAINER_BIN" list --all | grep -E "ID|$PG_CONTAINER_NAME" || true
    ;;
  *)
    echo "Usage: $0 {start|stop|clean|status}"
    exit 1
    ;;
esac
