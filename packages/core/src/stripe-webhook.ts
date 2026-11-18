/**
 * Cryptographic Stripe Webhook Verifier & Transactional Reconciliation Service
 * (`packages/core/src/stripe-webhook.ts`).
 *
 * Security & Reliability Guarantees (aligned with `security-audit` & Stripe Webhook v1 spec):
 * 1. Raw-Body HMAC-SHA256 Verification (`t=<unix_ts>,v1=<hex_sig>`):
 *    Computes `HMAC-SHA256(secret, "${t}.${rawBody}")` over the exact unparsed UTF-8 HTTP body.
 * 2. Constant-Time Digest Comparison (`crypto.timingSafeEqual`):
 *    Converts candidate `v1` hex signatures into 32-byte buffers and compares against
 *    each configured active/rollover endpoint secret (`whsec_...`) in constant time to
 *    eliminate byte-by-byte timing side-channels.
 * 3. Replay Attack Protection:
 *    Rejects webhook deliveries whose signed `t` timestamp differs from current server time
 *    by more than `toleranceSeconds` (default `300` seconds / 5 minutes).
 * 4. ACID PostgreSQL Idempotency & State Reconciliation (`PgStripeWebhookService`):
 *    Inside a single `pool.withTransaction(...)` block:
 *    - Deduplicates by `event_id` in `inbound_webhook_events` (`PRIMARY KEY (event_id)`)
 *    - Updates `orders.payment_status` (`CAPTURED`, `REFUNDED`, `DISPUTED`, `FAILED`)
 *    - On `payment_intent.payment_failed`, automatically compensates allocated MSI warehouse
 *      stock (`inventoryService.releaseAllocations`) so inventory is never stranded
 *    - Appends a corresponding domain event into `transactional_outbox_events`
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  deserializeWithBigInt,
  serializeWithBigInt,
  type PgPoolLike,
} from "@super-ecommerce/db";
import type { MinorUnits } from "@super-ecommerce/kernel";
import type { OrderRecord } from "./complete-checkout-workflow.ts";
import {
  MsiInventoryService,
  type MsiInventoryServiceLike,
} from "./inventory-service.ts";
import {
  TransactionalOutboxService,
  type OutboxStoreLike,
} from "./outbox-service.ts";

export type OrderPaymentStatus =
  | "AUTHORIZED"
  | "CAPTURED"
  | "REFUNDED"
  | "DISPUTED"
  | "FAILED";

export type StripeWebhookEventType =
  | "payment_intent.succeeded"
  | "payment_intent.payment_failed"
  | "charge.refunded"
  | "charge.dispute.created";

export interface StripeWebhookEventPayload {
  readonly id: string;
  readonly type: StripeWebhookEventType;
  readonly created: number;
  readonly data: {
    readonly object: {
      readonly id: string;
      readonly amount: number;
      readonly currency: string;
      readonly metadata: {
        readonly orderId?: string;
        readonly checkoutId?: string;
        readonly channelSlug?: string;
      };
      readonly failure_message?: string;
    };
  };
}

export interface ParsedStripeSignatureHeader {
  readonly timestamp: number;
  readonly v1Signatures: readonly string[];
}

export class StripeWebhookVerificationError extends Error {
  readonly code:
    | "MISSING_SIGNATURE_HEADER"
    | "MALFORMED_SIGNATURE_HEADER"
    | "TIMESTAMP_OUTSIDE_TOLERANCE"
    | "SIGNATURE_MISMATCH"
    | "INVALID_JSON_PAYLOAD";

  constructor(
    code:
      | "MISSING_SIGNATURE_HEADER"
      | "MALFORMED_SIGNATURE_HEADER"
      | "TIMESTAMP_OUTSIDE_TOLERANCE"
      | "SIGNATURE_MISMATCH"
      | "INVALID_JSON_PAYLOAD",
    message: string
  ) {
    super(message);
    this.name = "StripeWebhookVerificationError";
    this.code = code;
  }
}

/**
 * Parses a `Stripe-Signature` header (`t=1731500000,v1=abcdef...,v1=123456...,v0=...`).
 */
export function parseStripeSignatureHeader(
  headerValue: string | null | undefined
): ParsedStripeSignatureHeader {
  if (!headerValue || !headerValue.trim()) {
    throw new StripeWebhookVerificationError(
      "MISSING_SIGNATURE_HEADER",
      "Missing Stripe-Signature HTTP header"
    );
  }

  let timestamp = -1;
  const v1Signatures: string[] = [];

  for (const part of headerValue.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === "t") {
      const parsed = Number(val);
      if (Number.isInteger(parsed) && parsed > 0) {
        timestamp = parsed;
      }
    } else if (key === "v1" && /^[0-9a-fA-F]{64}$/.test(val)) {
      v1Signatures.push(val.toLowerCase());
    }
  }

  if (timestamp <= 0 || v1Signatures.length === 0) {
    throw new StripeWebhookVerificationError(
      "MALFORMED_SIGNATURE_HEADER",
      "Malformed Stripe-Signature header: expected t=<unix_ts> and at least one 64-hex v1=<hmac>"
    );
  }

  return { timestamp, v1Signatures };
}

/**
 * Computes a valid `Stripe-Signature` header (`t=...,v1=...`) for testing or signing outbound fixtures.
 */
export function signStripeWebhookPayload(params: {
  rawBody: string;
  secret: string;
  timestampSeconds?: number;
}): string {
  const ts = params.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${params.rawBody}`;
  const mac = createHmac("sha256", params.secret)
    .update(signedPayload, "utf8")
    .digest("hex");
  return `t=${ts},v1=${mac}`;
}

/**
 * Verifies the raw HTTP body against `Stripe-Signature` using constant-time `timingSafeEqual`
 * and enforces the replay tolerance window (`toleranceSeconds`, default 300s).
 * Supports an array of endpoint secrets (`string | readonly string[]`) for zero-downtime secret rotation.
 */
export function verifyStripeWebhookSignature(params: {
  rawBody: string;
  signatureHeader: string | null | undefined;
  endpointSecrets: string | readonly string[];
  toleranceSeconds?: number;
  nowSeconds?: number;
}): StripeWebhookEventPayload {
  const { timestamp, v1Signatures } = parseStripeSignatureHeader(
    params.signatureHeader
  );

  const tolerance = params.toleranceSeconds ?? 300;
  const nowSec = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ageSeconds = Math.abs(nowSec - timestamp);

  if (tolerance > 0 && ageSeconds > tolerance) {
    throw new StripeWebhookVerificationError(
      "TIMESTAMP_OUTSIDE_TOLERANCE",
      `Stripe webhook timestamp ${timestamp} outside tolerance window (${ageSeconds}s > ${tolerance}s)`
    );
  }

  const secrets =
    typeof params.endpointSecrets === "string"
      ? [params.endpointSecrets]
      : params.endpointSecrets;

  const signedPayload = `${timestamp}.${params.rawBody}`;
  let matched = false;

  for (const secret of secrets) {
    if (!secret) continue;
    const expectedDigest = createHmac("sha256", secret)
      .update(signedPayload, "utf8")
      .digest();

    for (const candidateHex of v1Signatures) {
      const candidateBuf = Buffer.from(candidateHex, "hex");
      if (
        candidateBuf.length === expectedDigest.length &&
        timingSafeEqual(candidateBuf, expectedDigest)
      ) {
        matched = true;
      }
    }
  }

  if (!matched) {
    throw new StripeWebhookVerificationError(
      "SIGNATURE_MISMATCH",
      "Stripe v1 HMAC-SHA256 signature verification failed"
    );
  }

  try {
    return JSON.parse(params.rawBody) as StripeWebhookEventPayload;
  } catch {
    throw new StripeWebhookVerificationError(
      "INVALID_JSON_PAYLOAD",
      "Verified Stripe webhook body is not valid JSON"
    );
  }
}

export interface InboundWebhookAuditRecord {
  readonly eventId: string;
  readonly provider: string;
  readonly eventType: StripeWebhookEventType;
  readonly signatureTimestamp: number;
  readonly orderId?: string;
  readonly checkoutId?: string;
  readonly amountMinorUnits: MinorUnits;
  readonly processedAt: string;
}

export interface StripeWebhookProcessResult {
  readonly eventId: string;
  readonly eventType: StripeWebhookEventType;
  readonly duplicate: boolean;
  readonly orderId?: string;
  readonly updatedPaymentStatus?: OrderPaymentStatus;
  readonly releasedWarehouseSlices: number;
}

export class StripeWebhookService {
  private readonly endpointSecrets: readonly string[];
  private readonly toleranceSeconds: number;
  private readonly inventoryService: MsiInventoryService;
  private readonly outboxService: TransactionalOutboxService;
  private readonly orderStore: Map<string, OrderRecord>;
  private readonly processedInMemory = new Map<string, InboundWebhookAuditRecord>();

  constructor(params: {
    endpointSecrets: string | readonly string[];
    toleranceSeconds?: number;
    inventoryService: MsiInventoryService;
    outboxService: TransactionalOutboxService;
    orderStore: Map<string, OrderRecord>;
  }) {
    this.endpointSecrets =
      typeof params.endpointSecrets === "string"
        ? [params.endpointSecrets]
        : params.endpointSecrets;
    this.toleranceSeconds = params.toleranceSeconds ?? 300;
    this.inventoryService = params.inventoryService;
    this.outboxService = params.outboxService;
    this.orderStore = params.orderStore;
  }

  /**
   * Verifies `Stripe-Signature` over `rawBody` and applies the event idempotently in memory.
   */
  handleRawWebhook(params: {
    rawBody: string;
    signatureHeader: string | null | undefined;
    nowSeconds?: number;
  }): StripeWebhookProcessResult {
    const event = verifyStripeWebhookSignature({
      rawBody: params.rawBody,
      signatureHeader: params.signatureHeader,
      endpointSecrets: this.endpointSecrets,
      toleranceSeconds: this.toleranceSeconds,
      nowSeconds: params.nowSeconds,
    });

    const metadata = event.data.object.metadata ?? {};
    const orderId =
      metadata.orderId ??
      (metadata.checkoutId ? `ord_${metadata.checkoutId}` : undefined);
    const checkoutId = metadata.checkoutId;
    const amountMinor = BigInt(Math.max(0, Math.trunc(event.data.object.amount)));

    if (this.processedInMemory.has(event.id)) {
      return {
        eventId: event.id,
        eventType: event.type,
        duplicate: true,
        orderId,
        releasedWarehouseSlices: 0,
      };
    }

    let targetStatus: OrderPaymentStatus = "CAPTURED";
    let outboxEventType = "payment.webhook.received";

    switch (event.type) {
      case "payment_intent.succeeded":
        targetStatus = "CAPTURED";
        outboxEventType = "payment.captured";
        break;
      case "payment_intent.payment_failed":
        targetStatus = "FAILED";
        outboxEventType = "payment.failed";
        break;
      case "charge.refunded":
        targetStatus = "REFUNDED";
        outboxEventType = "payment.refunded";
        break;
      case "charge.dispute.created":
        targetStatus = "DISPUTED";
        outboxEventType = "payment.disputed";
        break;
    }

    let releasedWarehouseSlices = 0;
    const targetOrder: OrderRecord | undefined = orderId
      ? this.orderStore.get(orderId)
      : undefined;

    if (targetOrder && orderId) {
      const updatedOrder: OrderRecord = {
        ...targetOrder,
        paymentStatus: targetStatus,
        paymentTransactionId: event.data.object.id,
      };
      this.orderStore.set(orderId, updatedOrder);

      if (
        event.type === "payment_intent.payment_failed" &&
        targetOrder.shipments.length > 0
      ) {
        this.inventoryService.releaseAllocations(targetOrder.shipments);
        releasedWarehouseSlices = targetOrder.shipments.length;
      }
    }

    const nowIso = new Date().toISOString();
    const auditRecord: InboundWebhookAuditRecord = {
      eventId: event.id,
      provider: "stripe",
      eventType: event.type,
      signatureTimestamp: event.created,
      orderId,
      checkoutId,
      amountMinorUnits: amountMinor,
      processedAt: nowIso,
    };
    this.processedInMemory.set(event.id, auditRecord);

    this.outboxService.enqueue({
      eventType: outboxEventType,
      aggregateType: "Order",
      aggregateId: orderId ?? event.data.object.id,
      channelSlug: metadata.channelSlug ?? targetOrder?.channelSlug,
      payload: {
        stripeEventId: event.id,
        stripeObjectId: event.data.object.id,
        orderId: orderId ?? null,
        paymentStatus: targetStatus,
        amountMinorUnits: amountMinor.toString(),
        releasedWarehouseSlices,
      },
    });

    return {
      eventId: event.id,
      eventType: event.type,
      duplicate: false,
      orderId,
      updatedPaymentStatus: targetStatus,
      releasedWarehouseSlices,
    };
  }

  listProcessedEvents(): readonly InboundWebhookAuditRecord[] {
    return Array.from(this.processedInMemory.values());
  }
}

function normalizeWebhookIso(raw: string): string {
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? raw : dt.toISOString();
}

/**
 * PostgreSQL 17-backed Stripe Webhook Verifier & ACID Reconciliation Service.
 * Deduplicates atomically via `inbound_webhook_events` (`ON CONFLICT DO NOTHING`),
 * updates `orders`, releases MSI stock inside the enclosing `tx` on payment failure,
 * and emits transactional outbox events.
 */
export class PgStripeWebhookService {
  private readonly pool: PgPoolLike;
  private readonly endpointSecrets: readonly string[];
  private readonly toleranceSeconds: number;
  private readonly inventoryService: MsiInventoryServiceLike;
  private readonly outboxService: OutboxStoreLike;

  constructor(params: {
    pool: PgPoolLike;
    endpointSecrets: string | readonly string[];
    toleranceSeconds?: number;
    inventoryService: MsiInventoryServiceLike;
    outboxService: OutboxStoreLike;
  }) {
    this.pool = params.pool;
    this.endpointSecrets =
      typeof params.endpointSecrets === "string"
        ? [params.endpointSecrets]
        : params.endpointSecrets;
    this.toleranceSeconds = params.toleranceSeconds ?? 300;
    this.inventoryService = params.inventoryService;
    this.outboxService = params.outboxService;
  }

  async handleRawWebhook(params: {
    rawBody: string;
    signatureHeader: string | null | undefined;
    nowSeconds?: number;
    nowIso?: string;
  }): Promise<StripeWebhookProcessResult> {
    const event = verifyStripeWebhookSignature({
      rawBody: params.rawBody,
      signatureHeader: params.signatureHeader,
      endpointSecrets: this.endpointSecrets,
      toleranceSeconds: this.toleranceSeconds,
      nowSeconds: params.nowSeconds,
    });

    const metadata = event.data.object.metadata ?? {};
    const orderId =
      metadata.orderId ??
      (metadata.checkoutId ? `ord_${metadata.checkoutId}` : undefined);
    const checkoutId = metadata.checkoutId;
    const amountMinor = BigInt(Math.max(0, Math.trunc(event.data.object.amount)));
    const processedAt = params.nowIso ?? new Date().toISOString();

    return await this.pool.withTransaction(async (tx) => {
      const dedup = await tx.query<{ event_id: string }>(
        `INSERT INTO inbound_webhook_events (
           event_id, provider, event_type, signature_timestamp,
           order_id, checkout_id, amount_minor_units, payload, processed_at
         ) VALUES ($1, 'stripe', $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [
          event.id,
          event.type,
          event.created,
          orderId ?? null,
          checkoutId ?? null,
          amountMinor.toString(),
          params.rawBody,
          processedAt,
        ]
      );

      if (dedup.rows.length === 0) {
        return {
          eventId: event.id,
          eventType: event.type,
          duplicate: true,
          orderId,
          releasedWarehouseSlices: 0,
        };
      }

      let targetStatus: OrderPaymentStatus = "CAPTURED";
      let outboxEventType = "payment.webhook.received";
      switch (event.type) {
        case "payment_intent.succeeded":
          targetStatus = "CAPTURED";
          outboxEventType = "payment.captured";
          break;
        case "payment_intent.payment_failed":
          targetStatus = "FAILED";
          outboxEventType = "payment.failed";
          break;
        case "charge.refunded":
          targetStatus = "REFUNDED";
          outboxEventType = "payment.refunded";
          break;
        case "charge.dispute.created":
          targetStatus = "DISPUTED";
          outboxEventType = "payment.disputed";
          break;
      }

      let releasedWarehouseSlices = 0;
      let targetOrder: OrderRecord | undefined;

      if (orderId) {
        const orderRes = await tx.query<{
          id: string;
          payload_json: string | null;
          channel_slug: string;
        }>(
          `SELECT id, payload_json, channel_slug
           FROM orders
           WHERE id = $1
           FOR UPDATE`,
          [orderId]
        );
        const orderRow = orderRes.rows[0];
        if (orderRow?.payload_json) {
          targetOrder = deserializeWithBigInt<OrderRecord>(orderRow.payload_json);
          const updatedOrder: OrderRecord = {
            ...targetOrder,
            paymentStatus: targetStatus,
            paymentTransactionId: event.data.object.id,
          };

          await tx.query(
            `UPDATE orders
             SET payment_status = $1,
                 payment_transaction_id = $2,
                 payload_json = $3::jsonb,
                 updated_at = $4::timestamptz
             WHERE id = $5`,
            [
              targetStatus,
              event.data.object.id,
              serializeWithBigInt(updatedOrder),
              processedAt,
              orderId,
            ]
          );

          if (
            event.type === "payment_intent.payment_failed" &&
            targetOrder.shipments.length > 0
          ) {
            await this.inventoryService.releaseAllocations(
              targetOrder.shipments,
              tx
            );
            releasedWarehouseSlices = targetOrder.shipments.length;
          }
        }
      }

      await this.outboxService.enqueue(
        {
          eventType: outboxEventType,
          aggregateType: "Order",
          aggregateId: orderId ?? event.data.object.id,
          channelSlug: metadata.channelSlug ?? targetOrder?.channelSlug,
          payload: {
            stripeEventId: event.id,
            stripeObjectId: event.data.object.id,
            orderId: orderId ?? null,
            paymentStatus: targetStatus,
            amountMinorUnits: amountMinor.toString(),
            releasedWarehouseSlices,
          },
          nowIso: processedAt,
        },
        tx
      );

      return {
        eventId: event.id,
        eventType: event.type,
        duplicate: false,
        orderId,
        updatedPaymentStatus: targetStatus,
        releasedWarehouseSlices,
      };
    });
  }

  async listProcessedEvents(limit = 50): Promise<readonly InboundWebhookAuditRecord[]> {
    const res = await this.pool.query<{
      event_id: string;
      provider: string;
      event_type: StripeWebhookEventType;
      signature_timestamp: string;
      order_id: string | null;
      checkout_id: string | null;
      amount_minor_units: string;
      processed_at: string;
    }>(
      `SELECT event_id, provider, event_type, signature_timestamp,
              order_id, checkout_id, amount_minor_units, processed_at
       FROM inbound_webhook_events
       ORDER BY processed_at DESC
       LIMIT $1`,
      [limit]
    );

    return res.rows.map((r) => ({
      eventId: r.event_id,
      provider: r.provider,
      eventType: r.event_type,
      signatureTimestamp: Number(r.signature_timestamp),
      orderId: r.order_id ?? undefined,
      checkoutId: r.checkout_id ?? undefined,
      amountMinorUnits: BigInt(r.amount_minor_units),
      processedAt: normalizeWebhookIso(r.processed_at),
    }));
  }
}
