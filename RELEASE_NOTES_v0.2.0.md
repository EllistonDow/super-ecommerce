## Super Ecommerce v0.2.0

Enterprise Architecture Hardening, True Rust-to-WASM Dual Compilation, Extended Query & TLS PostgreSQL Driver, Double-Entry Subledger, 16-Shard Flash-Sale Inventory, Preemptive WASM Worker Isolation, and Decoupled Production Runtimes.

### What's Changed

#### 1. Rust Commerce Kernel Evolution & True Dual-Target Compilation (`crates/commerce-kernel`, `crates/kernel-napi`, `crates/kernel-wasm`)
- **Single-Source Rust + WASM (`crates/kernel-wasm`)**: Added a genuine `wasm32-unknown-unknown` Cargo crate compiling `commerce-kernel` directly into `packages/kernel/native/commerce_kernel.wasm` (`133 KiB`), running full Two-Pass Hare-Niemeyer cart pricing, Margin Floor Guard, RMA ceiling reconciliation, and B2B policy evaluation identically across Node, Edge, and Browser runtimes.
- **Memory-Hardened N-API & Injection-Proof Wire Codec (`wire_codec.rs`)**: Added strict `argc` and `NapiStatus` validation, `std::panic::catch_unwind` across every C-ABI entrypoint (preventing null-pointer Segfaults and C-ABI UB), and lossless `\t`/`\n`/`\\` field escaping.
- **ISO-4217 Multi-Currency Precision & Gross Margin Floor Guard**: Added official ISO-4217 minor-unit exponents (`0` for `JPY`/`KRW`, `2` for `USD`/`EUR`, `3` for `KWD`/`BHD`) and line-level Gross Margin Floor Guard (`unitCostAmount` + `minMarginBps`), plus cross-line BOGO (`BuyXGetYCheapestDiscount`) promotion Action AST solver.

#### 2. PostgreSQL v3 Extended Query Protocol, TLS 1.3 Upgrade & `scrypt` Auth Hardening
- **Extended Query Protocol (`Parse`/`Bind`/`Describe`/`Execute`/`Sync`)**: Parameterized SQL queries now transmit `$1..$N` values out-of-band in length-prefixed wire frames rather than interpolating SQL text.
- **Cloud-Ready SSL/TLS Handshake (`SSLRequest` `0x04d2162f`)**: Added `node:tls` socket upgrade (`ssl: "prefer" | "require" | ConnectionOptions`) for encrypted cloud PostgreSQL connections (RDS, Neon, Supabase).
- **Salted Memory-Hard `scrypt` Password Digests**: Upgraded admin password storage from single-pass HMAC to salted `scrypt` digests with transparent constant-time legacy verification & automatic rehash-on-login, plus production login credential redaction.

#### 3. Schema Evolution (`0004`), 16-Shard Flash-Sale Stock, Hot/Cold CQRS & Double-Entry Subledger
- **Normalized `order_lines` & SKU Analytics**: Persists normalized line items alongside `orders`, powering native SQL SKU revenue, discount, and tax analytics (`orders.analyticsBySku`).
- **16-Shard Slotted Inventory (`msi_stock_shards`) & Hot/Cold CQRS (`catalog_availability_hot`)**: Eliminates single-row hot-SKU lock bottlenecks via randomized shard probing + `FOR UPDATE SKIP LOCKED`, and isolates frequent stock updates from cold `JSONB` catalog projections.
- **Immutable SOX Double-Entry Subledger (`ledger_journal_entries` + `ledger_postings`)**: Enforces `SUM(DEBIT) === SUM(CREDIT)` at both domain and PostgreSQL `CHECK` constraint levels across checkouts, store-credit redemptions, and restocking-fee RMA refunds (`ledger.getTrialBalance`).

#### 4. Durable Saga Mutual-Exclusion Leases & Autonomous `SagaRecoveryWorker`
- Added `locked_by`, `lease_expires_at`, and `attempt_count` to `workflow_runs`, rejecting concurrent duplicate `idempotencyKey` races with `409 Conflict` (`WorkflowConcurrentExecutionError`).
- Added `SagaRecoveryWorker` to claim orphaned `RUNNING`/`COMPENSATING` runs after lease expiry and drive them to completion or LIFO rollback without double-charging payment gateways.

#### 5. Preemptive Worker-Isolated WASM Sandbox (`@super-ecommerce/plugin-sdk`)
- Added `executePreemptiveShippingSurchargeWasm` backed by `node:worker_threads` with hard `worker.terminate()` preemption, physically killing `loop; br 0` infinite WASM loops within budget without blocking the Node.js event loop, with configurable `FAIL_OPEN` / `FAIL_CLOSED` policies.

#### 6. Runtime Decoupling, OpenAPI 3.1 & Standard MCP JSON-RPC 2.0 (`stdio` + `POST /mcp`)
- Added stateless production entrypoint `apps/api/src/prod-server.ts` (`npm run start:api`) and autonomous background daemon `apps/api/src/worker.ts` (`npm run start:worker`, wired into `docker-compose.yml`).
- Added `GET /openapi.json` (OpenAPI 3.1.0) and standard MCP JSON-RPC 2.0 (`2025-03-26`) over both `POST /mcp` and standalone `stdio` CLI (`npm run mcp`).

#### 7. Verification Status
- **Rust Workspace Tests**: `17 / 17` Passing (`0` warnings)
- **TypeScript Full-Stack Tests**: `109 / 109` Passing
- **Live PostgreSQL Wire Integration Tests (`test:pg-live`)**: `6 / 6` Passing
- **Total Verified Automated Tests**: **`132 / 132` Passing (100% Green)**
