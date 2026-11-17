## Super Ecommerce v0.1.0

Next-generation full-stack headless commerce engine powered by TypeScript, Rust `commerce-kernel`, and PostgreSQL 17.

### What's Changed

#### 1. Unified PostgreSQL 17 Primary Datastore
- Established PostgreSQL 17 as the sole primary datastore across the entire monorepo ecosystem.
- Connects via native wire protocol with SCRAM-SHA-256 on port 5438 in production (`PgPool`), and uses the in-process AST-level PostgreSQL 17 test double (`OfflinePgPool`) in hermetic test suites.
- Eliminated all dual-write SQLite engines and volatile in-memory Map stores.

#### 2. Append-Only Customer Store Credit Ledger
- Implemented `customers` and `store_credit_ledger` with monotonic chronological entry IDs (`generateLedgerEntryId`).
- Enforced non-negative balance constraints (`CHECK (balance_after >= 0)`) at the database engine level.
- Atomic customer row locking (`SELECT customer_id FROM customers WHERE customer_id = $1 FOR UPDATE`) prevents concurrent overdrafts and race conditions.

#### 3. Dynamic RBAC & Real-Time Audit
- Querying PostgreSQL `admin_roles` on every authorization request, enabling immediate permission propagation and custom role creation without restarting the server or invalidating cookies.
- Granular capability-based grants (`cockpit:read`, `msi:route_and_sync`, `mcp:diagnose`, `saga:execute_checkout`, `configurator:deploy_dag`, `chaos:inject_faults`, `finance:audit_webhooks`).

#### 4. Rust Commerce Kernel & Sub-Microsecond Math
- Two-pass Hare-Niemeyer pro-rata discount attribution with deterministic penny allocation.
- Order-level voucher vs promotional precedence hierarchy.
- MSI inventory multi-warehouse priority routing and reserve/commit/release workflows.

#### 5. Multi-Route Merchant Backoffice & Precision Storefront
- Linear-grade operations console supporting 10 admin routes with Server-Sent Events (SSE) telemetry bus (`/api/admin/events`).
- Interactive cart drawer and dual-channel (US-RETAIL / EU-FLAGSHIP) storefront with GIN `jsonb_path_ops` multi-dimensional facet filtering.
- Fully responsive across desktop and 375x812 mobile viewports with tactile feedback.

#### 6. Test Suite & Verification
- 100/100 TypeScript tests passing across 12 packages.
- 12/12 Rust kernel tests passing (112/112 total passing).
