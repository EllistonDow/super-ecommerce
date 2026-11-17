/**
 * Asynchronous Transactional Outbox Relay Worker (`packages/core/src/outbox-worker.ts`).
 *
 * Guarantees at-least-once event delivery from SQL `transactional_outbox_events` to
 * downstream subscribers (ERP, 3PL, Search Indexers, Outbound Webhooks):
 * 1. Polls due `PENDING` events (`next_attempt_at <= now`) in bounded batches.
 * 2. Signs every outbound delivery with `Super-Commerce-Signature: t=<ts>,v1=<hmac_sha256>`
 *    over `${ts}.${event.id}.${rawPayloadJson}` and attaches `Idempotency-Key: ${event.id}`.
 * 3. On subscriber failure, schedules exponential backoff (`baseDelayMs * 2^(attempts - 1)`)
 *    and transitions poison-pill events to `DEAD_LETTER` after `maxAttempts` so they never
 *    block healthy traffic.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { serializeWithBigInt } from "@super-ecommerce/db";
import {
  type OutboxEventRecord,
  type OutboxStoreLike,
} from "./outbox-service.ts";

export interface OutboundDeliveryEnvelope {
  readonly event: OutboxEventRecord;
  readonly rawPayloadJson: string;
  readonly headers: {
    readonly "content-type": "application/json; charset=utf-8";
    readonly "idempotency-key": string;
    readonly "super-commerce-event": string;
    readonly "super-commerce-signature": string;
  };
}

export interface OutboxSubscriber {
  readonly name: string;
  /**
   * Event pattern: `"*"` (all events), `"order.*"` (prefix wildcard), or `"order.created"` (exact).
   */
  readonly eventPattern: string;
  readonly handle: (envelope: OutboundDeliveryEnvelope) => Promise<void> | void;
}

export interface OutboxDrainSummary {
  readonly claimedCount: number;
  readonly publishedCount: number;
  readonly retriedCount: number;
  readonly deadLetteredCount: number;
  readonly deliveries: readonly {
    readonly eventId: string;
    readonly eventType: string;
    readonly outcome: "PUBLISHED" | "RETRY_SCHEDULED" | "DEAD_LETTER";
    readonly attempts: number;
    readonly error?: string;
  }[];
}

export function signOutboundOutboxPayload(params: {
  eventId: string;
  rawPayloadJson: string;
  signingSecret: string;
  timestampSeconds?: number;
}): string {
  const ts = params.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const canonical = `${ts}.${params.eventId}.${params.rawPayloadJson}`;
  const digestHex = createHmac("sha256", params.signingSecret)
    .update(canonical, "utf8")
    .digest("hex");
  return `t=${ts},v1=${digestHex}`;
}

export function verifyOutboundOutboxSignature(params: {
  eventId: string;
  rawPayloadJson: string;
  signatureHeader: string;
  signingSecret: string;
}): boolean {
  const parts = params.signatureHeader.split(",");
  let tsStr = "";
  let sigHex = "";
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (k === "t" && v) tsStr = v;
    if (k === "v1" && v) sigHex = v;
  }
  if (!tsStr || !/^[0-9a-fA-F]{64}$/.test(sigHex)) {
    return false;
  }
  const canonical = `${tsStr}.${params.eventId}.${params.rawPayloadJson}`;
  const expected = createHmac("sha256", params.signingSecret)
    .update(canonical, "utf8")
    .digest();
  const actual = Buffer.from(sigHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function matchesEventPattern(eventType: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // keeps trailing dot, e.g. "order."
    return eventType.startsWith(prefix);
  }
  return eventType === pattern;
}

export class OutboxRelayWorker {
  private readonly outboxService: OutboxStoreLike;
  private readonly signingSecret: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly subscribers: OutboxSubscriber[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(params: {
    outboxService: OutboxStoreLike;
    signingSecret?: string;
    maxAttempts?: number;
    baseDelayMs?: number;
    subscribers?: readonly OutboxSubscriber[];
  }) {
    this.outboxService = params.outboxService;
    this.signingSecret =
      params.signingSecret ?? "outbox_whsec_super_ecommerce_2026";
    this.maxAttempts = params.maxAttempts ?? 3;
    this.baseDelayMs = params.baseDelayMs ?? 1_000;
    if (params.subscribers) {
      this.subscribers.push(...params.subscribers);
    }
  }

  registerSubscriber(subscriber: OutboxSubscriber): void {
    this.subscribers.push(subscriber);
  }

  /**
   * Claims a batch of due `PENDING` events (`next_attempt_at <= now`) and dispatches
   * each event to all matching subscribers with signed HMAC headers.
   */
  async drainBatch(options?: {
    nowMs?: number;
    batchSize?: number;
  }): Promise<OutboxDrainSummary> {
    const nowMs = options?.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const dueEvents = await this.outboxService.claimDueBatch({
      nowIso,
      batchSize: options?.batchSize ?? 25,
    });

    let publishedCount = 0;
    let retriedCount = 0;
    let deadLetteredCount = 0;
    const deliveries: {
      eventId: string;
      eventType: string;
      outcome: "PUBLISHED" | "RETRY_SCHEDULED" | "DEAD_LETTER";
      attempts: number;
      error?: string;
    }[] = [];

    for (const evt of dueEvents) {
      const rawPayloadJson = serializeWithBigInt(
        evt.payload === undefined ? null : evt.payload
      );
      const signature = signOutboundOutboxPayload({
        eventId: evt.id,
        rawPayloadJson,
        signingSecret: this.signingSecret,
        timestampSeconds: Math.floor(nowMs / 1000),
      });

      const envelope: OutboundDeliveryEnvelope = {
        event: evt,
        rawPayloadJson,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "idempotency-key": evt.id,
          "super-commerce-event": evt.eventType,
          "super-commerce-signature": signature,
        },
      };

      const matchingSubscribers = this.subscribers.filter((s) =>
        matchesEventPattern(evt.eventType, s.eventPattern)
      );

      try {
        for (const sub of matchingSubscribers) {
          await sub.handle(envelope);
        }
        await this.outboxService.markPublished(evt.id, nowIso);
        publishedCount += 1;
        deliveries.push({
          eventId: evt.id,
          eventType: evt.eventType,
          outcome: "PUBLISHED",
          attempts: evt.attempts + 1,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const nextStatus = await this.outboxService.recordDeliveryFailure({
          eventId: evt.id,
          errorMessage,
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs,
          nowMs,
        });
        if (nextStatus === "DEAD_LETTER") {
          deadLetteredCount += 1;
          deliveries.push({
            eventId: evt.id,
            eventType: evt.eventType,
            outcome: "DEAD_LETTER",
            attempts: evt.attempts + 1,
            error: errorMessage,
          });
        } else {
          retriedCount += 1;
          deliveries.push({
            eventId: evt.id,
            eventType: evt.eventType,
            outcome: "RETRY_SCHEDULED",
            attempts: evt.attempts + 1,
            error: errorMessage,
          });
        }
      }
    }

    return {
      claimedCount: dueEvents.length,
      publishedCount,
      retriedCount,
      deadLetteredCount,
      deliveries,
    };
  }

  startPolling(intervalMs = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drainBatch();
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
