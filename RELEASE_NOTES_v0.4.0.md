# Super Ecommerce `v0.4.0` — Modular `React 19 + TanStack` Admin Studio Release Notes

## Overview

`v0.4.0` introduces the standalone, modular **`@super-ecommerce/admin-spa`** workspace (`apps/admin-spa`) powered by **React 19**, **TanStack Router**, **TanStack Query**, **TanStack Table**, and **Vite 6**, mounted seamlessly at `/admin-spa` while preserving 100% backward compatibility with the existing `/admin` SSR backoffice:

1. **Zero-Float Frontend Financial Precision (`src/lib/money.ts` & `src/api/rpc-client.ts`)**:
   - All RPC payloads keep monetary fields as exact integer minor-unit strings (`"27400"`), parsed and formatted via `BigInt` across ISO-4217 0-, 2-, 3-, and 4-decimal currencies (`JPY`, `USD`, `KWD`, `CLF`) with zero `Number` floating-point arithmetic.
   - Strongly-typed `AdminRpcClient` normalizes hydrated PostgreSQL order payloads and speaks `/rpc/*`, `/mcp` (JSON-RPC 2.0), and `/healthz`.

2. **Five Modular Operational Route Views (`src/routes/*`)**:
   - **Overview & Subledger (`OverviewPage.tsx`)**: Live Double-Entry Subledger Trial Balance (`Debit == Credit` verification) + normalized `order_lines` SQL SKU revenue analytics.
   - **Orders & Pre-Fulfillment OMS Studio (`OrdersOmsPage.tsx`)**: Sortable `@tanstack/react-table` ledger with keyset cursor pagination, OMS order edit history, and a modal **OMS Pre-Fulfillment Order Editor & Partial RMA** drawer.
   - **C-End Carts & Stripe PaymentIntents (`CartsPaymentsPage.tsx`)**: Multi-channel persistent guest/member cart inspector + one-click **3DS2 Challenge Completion** (`requires_action` -> `succeeded`) and **Manual Authorization Capture** (`requires_capture` -> `succeeded`).
   - **MSI Slots, Saga Leases & Outbox (`InventoryOutboxPage.tsx`)**: Warehouse stock monitor, **Reap Expired TTL Holds**, **Recover Orphaned Saga Leases**, and Transactional Outbox queue viewer.
   - **MCP Copilot Inspector (`McpCopilotPage.tsx`)**: Interactive JSON-RPC 2.0 tool discovery (`tools/list`) and invocation (`diagnose_price_waterfall`, `search_catalog_hybrid`).

3. **Modern Web Platform & Accessibility Architecture**:
   - Adaptive `color-scheme: light dark` + `@media (prefers-color-scheme: dark)` fallback + `light-dark()` tokens (`dark-mode`).
   - Container-queried (`@container (width < 600px)`) responsive & accessible sortable tables (`responsive-table`, `sortable-table`).
   - Declarative `<dialog closedby="any">` top-layer modal with bounding-rect backdrop click fallback (`light-dismiss-a-dialog`).
   - Interaction-deferred `:user-invalid` validation with synchronized `aria-invalid` and dynamic `aria-describedby` error linking (`validate-input-after-interaction`).

4. **Production Static Serving, Multi-Stage Docker & CI Integration**:
   - Served directly from `apps/api/src/index.ts` under `/admin-spa` with directory-traversal confinement, `immutable` cache headers on hashed `/admin-spa/assets/*`, and SPA `index.html` deep-link fallback.
   - Multi-stage `Dockerfile` (`rust-builder` + `spa-builder` + minimal `node:22-bookworm-slim` runtime).

## Verification

- `npm test`: `build:spa` + `17/17` Rust tests + `114/114` TypeScript & React 19 SSR tests passing.
- `SUPER_PG_USE_WIRE=1 npm run test:pg-live`: `7/7` real PostgreSQL Wire Protocol integration tests passing.
