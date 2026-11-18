# Super Ecommerce `v0.3.0` — Commercial Transaction & OMS Loop Release Notes

## Overview

`v0.3.0` closes the C-end commercial checkout and pre-fulfillment Order Management System (OMS) loop on top of the zero-float Rust `commerce-kernel`, PostgreSQL 17 Durable Sagas, and Double-Entry Subledger:

1. **Migration `0005_v030_commercial_checkout_oms.sql`**:
   - `customer_credentials` & `customer_addresses` (C-end authentication and multi-country shipping/billing address book).
   - `carts` & `cart_lines` (persistent multi-channel carts with guest tokens, member ownership, and merge tracking).
   - `payment_intents` (idempotent Stripe `PaymentIntent` state machine with `requires_payment_method`, `requires_confirmation`, `requires_action`, `requires_capture`, `succeeded`, `canceled`).
   - `order_edits` (immutable OMS pre-fulfillment order revision audit trail) + `ORDER_EDIT_DELTA` journal entry reference support in `ledger_journal_entries`.

2. **C-End Customer Auth, Address Book & Atomic Guest-to-Member Cart Merge (`PgCustomerAuthAndCartService`)**:
   - Salted `scrypt` (`N=4096, r=8, p=1`) password hashing with constant-time dummy verification against user enumeration and HMAC-SHA256 signed session tokens.
   - Multi-channel persistent carts hydrated on-the-fly through the Rust `calculateCart` engine.
   - Transactional `mergeGuestCartIntoCustomerCart` combining guest SKU quantities and vouchers into the authenticated customer's active channel cart within a single ACID transaction.

3. **Dual-Mode Real Stripe `PaymentIntent` Engine (`PgStripePaymentIntentService`)**:
   - Supports live Stripe REST API (`STRIPE_SECRET_KEY`) and zero-network deterministic `LOCAL_SIMULATOR` mode (`pm_card_3ds_required` / `3ds` 3DS2 challenge flow, `capture_method: "manual"` authorization + capture, partial/full refunds, and `asPaymentGatewayStrategy()` Saga adapter).

4. **OMS Pre-Fulfillment Order Editing Saga (`buildEditOrderWorkflow`)**:
   - Re-prices modified `UNFULFILLED` orders (add/increase/decrease/remove lines, adjust shipping or order discounts) through Rust `calculateCart`.
   - Reconciles MSI warehouse inventory deltas (`allocate` additional units or `release` surplus slices) with strict LIFO compensation.
   - Settles financial deltas (`INCREMENTAL_CAPTURE`, `PARTIAL_REFUND`, or `NO_FINANCIAL_DELTA`), updates normalized `order_lines`, appends balanced `ORDER_EDIT_DELTA` postings to `PgDoubleEntryLedgerService`, and emits `order.edited.v1` outbox events.

5. **API Gateway & OpenAPI 3.1 Expansion (`@super-ecommerce/api`)**:
   - Exposed `/rpc/customers.*`, `/rpc/carts.*`, `/rpc/payments.*`, `/rpc/orders.edit`, `/rpc/orders.listEdits`, `/rpc/inventory.listSlots`, `/rpc/outbox.listPending`, CORS preflight (`OPTIONS`), and lossless HTTP JSON `BigInt` minor-unit normalization.

## Verification

- `npm test`: `17/17` Rust tests + `111/111` TypeScript tests passing.
- `SUPER_PG_USE_WIRE=1 npm run test:pg-live`: `7/7` real PostgreSQL Wire Protocol integration tests passing.
