## Super Ecommerce v0.1.1

Production Containerization, Zero-SQLite PostgreSQL 17 Architecture, and Transactional Advisory Locking.

### What's Changed

#### 1. Complete Legacy SQLite Removal & Zero-SQLite Primary Architecture
- Purged all legacy `node:sqlite` persistence layers, `SqlDatabaseEngine`, and `SqlWorkflowStateStore`.
- Migrated all persistence workflows exclusively to PostgreSQL 17:
  - **Production Runtime**: Zero-dependency PostgreSQL v3 Wire Protocol client (`PgPool`) with SCRAM-SHA-256 authentication over TCP.
  - **Offline Hermetic Tests**: High-fidelity in-memory AST-level PostgreSQL 17 engine (`OfflinePgPool`), eliminating experimental SQLite warnings while executing real transactional SQL, CHECK constraints, and savepoints.

#### 2. Transactional Advisory Locking for Concurrent Migrations
- Added 64-bit transactional advisory locking (`SELECT pg_advisory_xact_lock(742918237192)`) in `runMigrations()`.
- Guarantees that concurrent app instances, multi-replica container boots, and parallel test runners serialize DDL execution cleanly, preventing PostgreSQL catalog race conditions (`pg_type_typname_nsp_index` duplicate key errors on concurrent `CREATE TABLE IF NOT EXISTS`).
- Implemented in-memory advisory lock emulation in `OfflinePgPool` using transaction lock manager state.

#### 3. Multi-Stage Production Docker Packaging & Health Check
- Added multi-stage [Dockerfile](Dockerfile) with glibc-aligned base images:
  - **Stage 1 (`rust:1-bookworm`)**: Compiles native Rust N-API commerce kernel (`libkernel_napi.so`).
  - **Stage 2 (`node:22-bookworm-slim`)**: Packages minimal Node.js 22 runtime, symlinks npm workspaces, runs as non-root `USER node`, and binds `HOST=0.0.0.0:4100`.
- Added [docker-compose.yml](docker-compose.yml) wiring app services to official `postgres:17-alpine` with healthcheck hooks.
- Added `GET /healthz` endpoint reporting database connectivity mode (`"postgres"`), PostgreSQL engine version (`"17.x"`), and timestamp.

#### 4. Automated CI Workflows with Live PostgreSQL 17 & Docker Container Smoke
- Integrated 5-job GitHub Actions CI matrix:
  - `Rust Kernel (ubuntu-latest)` & `Rust Kernel (macos-latest)`
  - `TypeScript Full-Stack Tests (Node 22.x)`
  - `PostgreSQL 17 Live Integration Tests` running against live `postgres:17-alpine` service container
  - `Docker Build & PostgreSQL 17 Container Smoke` verifying container build and real HTTP `/healthz` response
- Added `--test-concurrency=1` to `"test:pg-live"` script to prevent cross-suite table truncation interference.

#### 5. Test Suite & Verification
- **102/102** TypeScript tests passing across 12 packages/apps.
- **12/12** Rust kernel tests passing (114/114 total tests passing across monorepo).
- All 5 CI jobs verified green in GitHub Actions run `#44227115177`.
