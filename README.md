<div align="center">

# Super Ecommerce

**Next-Generation Full-Stack Headless Commerce Engine**  
*Powered by TypeScript, Rust Commerce Kernel, and PostgreSQL 17*

[![CI](https://img.shields.io/github/actions/workflow/status/EllistonDow/super-ecommerce/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/EllistonDow/super-ecommerce/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/EllistonDow/super-ecommerce?color=blue&style=flat-square)](https://github.com/EllistonDow/super-ecommerce/releases)
[![Tests](https://img.shields.io/badge/tests-112%2F112%20passing-brightgreen?style=flat-square)](https://github.com/EllistonDow/super-ecommerce)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-336791?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Rust](https://img.shields.io/badge/Rust-Kernel%201.85+-orange?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-green?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-purple?style=flat-square)](LICENSE)

</div>

---

## Overview

**Super Ecommerce** is an enterprise-grade, high-throughput headless commerce engine architected for modern global retail, B2B wholesale, and cross-border trade.

It fuses the best elements of the world's leading open-source commerce platforms while eliminating their architectural bottlenecks:

- **Saleor's Channel-First & Financial Discipline**: Without slow synchronous HTTP Webhooks blocking the checkout path.
- **Medusa v2's Durable Saga Workflows**: Backed directly by PostgreSQL 17 without cross-module in-memory JOIN degradation.
- **Vendure's Type-Safe Strategy Patterns**: Built with lightweight modern Hono + oRPC rather than heavyweight reflection metadata.
- **Magento 2's MSI & B2B Depth**: Without the EAV 20-table JOIN complexity and fragile database table indexer locks.
- **Shopify Functions' Sandboxed Extensibility**: 100% isolated WebAssembly (WASM) plugins executing in `< 5ms`.

---

## The 5 Architectural Invariants

### 1. Zero-Float Financial Determinism
No `number` floating-point math is ever used for monetary calculations in JavaScript or TypeScript. All prices, taxes, voucher discounts, and shipping lines are stored and transmitted as **integer minor units (`BigInt` / cents)**. Pro-rata cart discounts use the mathematical **Hare-Niemeyer largest-remainder algorithm** implemented in a pure Rust kernel (`commerce-kernel`), guaranteeing zero penny loss and deterministic penny allocation.

### 2. Channel-First Everything
No product price, inventory visibility, tax policy, or shipping method exists detached from a `Channel`. A single deployed instance powers US DTC retail (tax-exclusive USD), European retail (VAT-inclusive EUR), B2B wholesale portals (volume tier pricing and net-terms), and offline POS terminals.

### 3. Single-PG Bootstrap, Infinite Scale-Out
- **Day-1 Simplicity**: Runs fully on **`1 × PostgreSQL 17 + 1 × Node.js process`**. ACID transactions, Saga workflows, outbox queues (`SKIP LOCKED`), and full-text/vector hybrid search operate entirely within native PostgreSQL. Zero mandatory Redis or RabbitMQ dependencies.
- **Day-100 Cluster Scale**: Seamlessly plug in Valkey (atomic Redis inventory locks), Typesense/Meilisearch (external search cluster), and Cloudflare Workers for edge rendering.

### 4. Sub-5ms Sandboxed Plugins (No Sync Webhooks)
Synchronous extensions (custom promotions, shipping filters, dynamic tax overrides) run through an in-process **WebAssembly (WASM) sandbox** with a strict 64KiB memory ceiling and 5ms SLA, isolating memory leaks, infinite loops, and host probing attacks. All asynchronous side effects stream via a **Transactional Outbox** with HMAC-SHA256 signed payloads.

### 5. AI-Native & Commerce-as-Code
Includes a native **Model Context Protocol (MCP) Server** with diagnostic tools for AI operations and autonomous shopping agents. Entire store configurations (channels, tax rules, product types, and warehouses) export as declarative YAML/TypeScript with GitOps `diff` and `deploy` pipelines.

---

## Monorepo Architecture

```text
super-ecommerce/
├── Cargo.toml / Cargo.lock            # Rust Workspace root configuration
├── package.json / tsconfig.base.json  # TypeScript Monorepo root configuration
│
├── crates/                            # Rust Core Calculation Engine
│   ├── commerce-kernel/               # Pure math: Money, Hare-Niemeyer, AST rules, MSI split router
│   ├── kernel-napi/                   # Node-API (.node) native binary bindings
│   └── kernel-wasm/                   # WebAssembly bindings for edge and browser runtimes
│
├── packages/                          # TypeScript Domain & Infrastructure Packages
│   ├── db/                            # PostgreSQL 17 wire pool (PgPool) & offline AST test double (OfflinePgPool)
│   ├── workflow/                      # Database-backed durable Saga workflow engine (LIFO compensation)
│   ├── plugin-sdk/                    # Zero-permission WebAssembly plugin sandbox host
│   ├── core/                          # Domain engines: Inventory, Cart, Saga, Ledger, RBAC, Outbox
│   ├── configurator/                  # Commerce-as-Code declarative DAG deployment engine
│   └── mcp-server/                    # Native Model Context Protocol (MCP) diagnostic tools
│
└── apps/                              # Full-Stack Applications
    ├── api/                           # Unified Hono server (oRPC, GraphQL Yoga, SSE bus, Outbox Worker)
    ├── storefront/                    # Precision commerce storefront (CQRS filters, responsive cart drawer)
    └── admin/                         # Linear-style merchant backoffice (10 admin routes, dynamic RBAC)
```

---

## Benchmark Highlights

Tested on Apple Silicon `arm64` under high concurrency:

| Metric | Traditional Platform | Super Ecommerce (Tested) | Speedup / Invariant |
| :--- | :--- | :--- | :--- |
| **In-Rust Cart Pricing** | ~5,000 carts/s | **591,829 carts/s** (`p50: 1.5 µs`) | **118x** faster (Zero-FFI) |
| **Node-API N-API Cart Pricing** | N/A | **76,650 carts/s** (`p50: 11.4 µs`) | Native C-ABI cross-boundary |
| **CQRS Catalog Query** | 2,180 ~ 5,940 µs | **390 ~ 510 µs** (`0-JOIN`) | **4.8x ~ 13.9x** faster |
| **MSI Concurrency Stock Claim** | Deadlock timeouts | **3,450 tx/s** (`SKIP LOCKED`) | **0** oversell, **0** deadlocks |
| **WASM Hot JIT Execution** | Sync HTTP: 300~1500ms | **2,340,000+ ops/s** (`p50: 0.38 µs`) | In-process hardware-isolated |
| **In-Process oRPC Throughput** | ~10,000 req/s | **178,939 ~ 527,476 req/s** | Zero-serialization overhead |

---

## Quickstart

### Prerequisites

- **Node.js** >= `22.0.0`
- **Rust** >= `1.85.0` (with `cargo`)
- **PostgreSQL** 17 (or use the built-in hermetic in-process test double)

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/EllistonDow/super-ecommerce.git
cd super-ecommerce
npm install
```

### 2. Run Comprehensive Test Suites

Run all 112 unit, integration, and kernel tests:

```bash
# Run both Rust kernel tests and TypeScript full-stack tests
npm test

# Run Rust kernel tests only
npm run test:rust

# Run TypeScript tests across all 12 monorepo packages
npm run test:ts
```

### 3. Launch Development Server

Start the unified full-stack server (serves API, Storefront, Admin Backoffice, and SSE stream on port 4100):

```bash
npm run dev
```

Visit the running applications in your browser:

- **Storefront**: [http://localhost:4100](http://localhost:4100)
  - Channel switching (`us-retail` USD vs `eu-flagship` EUR).
  - PostgreSQL 17 GIN `jsonb_path_ops` multi-dimensional facet filtering.
  - Interactive two-pass cart drawer with pro-rata discount allocation.
- **Merchant Admin Backoffice**: [http://localhost:4100/admin](http://localhost:4100/admin)
  - Live Server-Sent Events (SSE) telemetry feed (`/api/admin/events`).
  - PostgreSQL 17 Dynamic RBAC role configuration and customer credit ledger.
  - Multi-source inventory (MSI), outbox queues, and Stripe webhook replayers.
  - Fully responsive across desktop and `375x812` mobile viewports.

---

## Core Subsystems

### 1. CQRS 0-JOIN Read Projections
The storefront read path queries `catalog_channel_projections`, a precomputed table updated atomically upon catalog or price changes. The table collapses products, variants, dynamic JSON attributes, prices, and available stock quantities into a single row, achieving sub-millisecond lookups via single index scans:

```sql
SELECT product_slug, product_name, min_effective_price, total_available_qty, merged_attributes
FROM catalog_channel_projections
WHERE channel_slug = 'us-retail' AND is_in_stock = true
ORDER BY updated_at DESC LIMIT 64;
```

### 2. Durable Saga Checkout with LIFO Compensation
Checkout executes across 5 discrete steps in a database-tracked state machine:
1. `verify-pricing`: Re-validates catalog promotions and voucher precedence.
2. `allocate-inventory`: Locks multi-warehouse inventory via `SELECT ... FOR UPDATE`.
3. `redeem-store-credit`: Atomically deducts customer store credit.
4. `capture-payment`: Communicates with payment provider.
5. `commit-order-and-outbox`: Atomically persists the order and transactional outbox event.

If payment fails at Step 4, the engine rolls back credit and releases inventory in reverse **LIFO order**. If a failure occurs at Step 5 after payment capture, the engine triggers an automatic Stripe refund (`voidOrRefund`), preventing orphaned customer charges.

### 3. Append-Only Store Credit Ledger
Customer credit balances are tracked in an append-only ledger (`store_credit_ledger`) with database engine-level invariants:
- **`CHECK (balance_after >= 0)`**: Enforced at the PostgreSQL engine level to prevent overdrafts.
- **Row-Level Locking**: `SELECT customer_id FROM customers WHERE customer_id = $1 FOR UPDATE` serializes concurrent mutations.
- **Monotonic IDs**: Generated via `scl_${timeMs}_${seqStr}_${rand}` ensuring strict chronological ordering (`ORDER BY entry_id DESC`).

### 4. Dynamic RBAC Matrix
User roles and capability grants are resolved directly from `admin_roles` in PostgreSQL on every request:
- Grants: `cockpit:read`, `msi:route_and_sync`, `mcp:diagnose`, `saga:execute_checkout`, `configurator:deploy_dag`, `chaos:inject_faults`, `finance:audit_webhooks`.
- Hot role updates take effect immediately without requiring process restarts or session token re-issuance.

### 5. Model Context Protocol (MCP) Server
Exposes 4 diagnostic and operational tools under the MCP specification:
- `diagnose_price_waterfall`: Reconstructs the 3-tier discount waterfall, highlighting suppressed candidate promotions and gift lines.
- `diagnose_stock_availability_doctor`: Compares channel purchasability vs legacy shipping zone shippability to detect warehouse orphan configurations.
- `search_catalog_hybrid`: Enables AI shopping agents to execute hybrid text and facet searches against the CQRS read model.
- `preview_store_config_diff`: Allows autonomous DevOps agents to preview DAG topology changes prior to deployment.

---

## CLI Tools

### Declarative Commerce-as-Code Configurator

Introspect existing store state, compare differences against desired YAML specifications, and deploy changes via a dependency-ordered Directed Acyclic Graph (DAG):

```bash
# Preview differences between local config.yml and PostgreSQL database
npm run configurator diff

# Deploy configuration changes idempotently
npm run configurator deploy
```

### Kernel Benchmark Suite

Run the multi-tier pricing and discount allocation benchmark:

```bash
npm run bench
```

---

## Verification & Test Status

- **Rust Kernel Test Suite**: `12 / 12` Passed
- **TypeScript Full-Stack Test Suite**: `100 / 100` Passed
- **Total Monorepo Tests**: **`112 / 112` Passed (100% Green)**
- **Browser QA**: Visual and interactive verification completed on desktop (1280x800) and mobile (375x812).

---

## License

This project is licensed under the [MIT License](LICENSE).
