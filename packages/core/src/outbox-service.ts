/**
 * Transactional Outbox Service (`@super-ecommerce/core`).
 *
 * Ensures domain state changes (e.g. Order Creation, Stock Allocation, Payment Webhooks)
 * and outbound integration events (Webhooks, Search Indexing, ERP Sync) are recorded
 * atomically in SQL (`transactional_outbox_events`) before any external network call is attempted.
 *
 * Supports:
 * - Batch claiming of due `PENDING` events (`next_attempt_at <= now`)
 * - Exponential backoff scheduling (`baseDelayMs * 2^(attempts - 1)`)
 * - Automatic Dead-Letter Queue (`DEAD_LETTER`) transition after `maxAttempts`
 * - One-click manual DLQ replay (`requeueDeadLetters`)
 */

import { randomUUID } from "node:crypto";
import {
  deserializeWithBigInt,
  serializeWithBigInt,
  type PgPoolLike,
  type PgQueryable,
  type PgTxClient,
} from "@super-ecommerce/db";

export type OutboxEventStatus = "PENDING" | "PUBLISHED" | "DEAD_LETTER";

export interface OutboxStoreLike {
  claimDueBatch(params?: {
    nowIso?: string;
    batchSize?: number;
  }): readonly OutboxEventRecord[] | Promise<readonly OutboxEventRecord[]>;
  markPublished(eventId: string, nowIso?: string): void | Promise<void>;
  recordDeliveryFailure(params: {
    eventId: string;
    errorMessage: string;
    maxAttempts: number;
    baseDelayMs: number;
    nowMs?: number;
  }): OutboxEventStatus | Promise<OutboxEventStatus>;
}

export interface OutboxQueueStats {
  readonly totalCount: number;
  readonly pendingCount: number;
  readonly publishedCount: number;
  readonly deadLetterCount: number;
  readonly selfHealedCount: number;
}

export interface OutboxEventRecord<TPayload = unknown> {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly channelSlug?: string;
  readonly payload: TPayload;
  status: OutboxEventStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  deliveredAt?: string;
  readonly createdAt: string;
}

export class TransactionalOutboxService {
  private readonly events: OutboxEventRecord[] = [];
  private seq = 1;

  enqueue<TPayload>(params: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    channelSlug?: string;
    payload: TPayload;
    nowIso?: string;
  }): OutboxEventRecord<TPayload> {
    const nowIso = params.nowIso ?? new Date().toISOString();
    const record: OutboxEventRecord<TPayload> = {
      id: `outbox-evt-${this.seq++}`,
      eventType: params.eventType,
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      channelSlug: params.channelSlug,
      payload: params.payload,
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: nowIso,
      createdAt: nowIso,
    };

    this.events.push(record);
    return record;
  }

  listPending(): readonly OutboxEventRecord[] {
    return this.events.filter((e) => e.status === "PENDING");
  }

  listAll(limit = 50): readonly OutboxEventRecord[] {
    return [...this.events].reverse().slice(0, limit);
  }

  /**
   * Fetches up to `batchSize` `PENDING` events whose `next_attempt_at <= nowIso`.
   */
  claimDueBatch(params?: {
    nowIso?: string;
    batchSize?: number;
  }): readonly OutboxEventRecord[] {
    const nowIso = params?.nowIso ?? new Date().toISOString();
    const batchSize = params?.batchSize ?? 25;

    return this.events
      .filter((e) => e.status === "PENDING" && e.nextAttemptAt <= nowIso)
      .slice(0, batchSize);
  }

  markPublished(eventId: string, nowIso?: string): void {
    const deliveredAt = nowIso ?? new Date().toISOString();
    const evt = this.events.find((e) => e.id === eventId);
    if (evt) {
      evt.status = "PUBLISHED";
      evt.attempts += 1;
      evt.deliveredAt = deliveredAt;
      evt.lastError = undefined;
    }
  }

  /**
   * Records a failed delivery attempt with exponential backoff (`baseDelayMs * 2^(attempts - 1)`),
   * or transitions the event to `'DEAD_LETTER'` once `attempts >= maxAttempts`.
   */
  recordDeliveryFailure(params: {
    eventId: string;
    errorMessage: string;
    maxAttempts: number;
    baseDelayMs: number;
    nowMs?: number;
  }): OutboxEventStatus {
    const nowMs = params.nowMs ?? Date.now();
    const memEvt = this.events.find((e) => e.id === params.eventId);

    const currentAttempts = memEvt?.attempts ?? 0;
    const nextAttempts = currentAttempts + 1;
    const nextStatus: OutboxEventStatus =
      nextAttempts >= params.maxAttempts ? "DEAD_LETTER" : "PENDING";
    const backoffMs =
      params.baseDelayMs * Math.pow(2, Math.max(0, nextAttempts - 1));
    const nextAttemptAt = new Date(nowMs + backoffMs).toISOString();

    if (memEvt) {
      memEvt.status = nextStatus;
      memEvt.attempts = nextAttempts;
      memEvt.nextAttemptAt = nextAttemptAt;
      memEvt.lastError = params.errorMessage;
    }

    return nextStatus;
  }

  /**
   * Resets all (or a specific) `DEAD_LETTER` events back to `PENDING` with `attempts = 0`
   * for immediate re-delivery.
   */
  requeueDeadLetters(eventId?: string, nowIso?: string): number {
    const resetTime = nowIso ?? new Date().toISOString();
    let count = 0;

    for (const evt of this.events) {
      if (evt.status === "DEAD_LETTER" && (!eventId || evt.id === eventId)) {
        evt.status = "PENDING";
        evt.attempts = 0;
        evt.nextAttemptAt = resetTime;
        evt.lastError = undefined;
        count += 1;
      }
    }

    return count;
  }

  getStats(): OutboxQueueStats {
    const all = this.listAll(500);
    let pendingCount = 0;
    let publishedCount = 0;
    let deadLetterCount = 0;
    let selfHealedCount = 0;
    for (const e of all) {
      if (e.status === "PENDING") pendingCount++;
      else if (e.status === "PUBLISHED") {
        publishedCount++;
        if (e.attempts > 1) selfHealedCount++;
      } else if (e.status === "DEAD_LETTER") {
        deadLetterCount++;
      }
    }
    return {
      totalCount: all.length,
      pendingCount,
      publishedCount,
      deadLetterCount,
      selfHealedCount,
    };
  }
}

interface PgOutboxRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  channel_slug: string | null;
  payload: string;
  status: OutboxEventStatus;
  attempts: string;
  next_attempt_at: string;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

function normalizeOutboxIso(raw: string): string {
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? raw : dt.toISOString();
}

/**
 * PostgreSQL 17-backed Transactional Outbox Service (`transactional_outbox_events`).
 * Supports enclosing transaction participation (`tx?: PgTxClient`), `FOR UPDATE SKIP LOCKED`
 * concurrent worker claiming with bounded lease, exponential backoff, and DLQ replay.
 */
export class PgTransactionalOutboxService implements OutboxStoreLike {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  private runner(tx?: PgTxClient): PgQueryable {
    return tx ?? this.pool;
  }

  private hydrateRow(r: PgOutboxRow): OutboxEventRecord {
    return {
      id: r.id,
      eventType: r.event_type,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      channelSlug: r.channel_slug ?? undefined,
      payload: deserializeWithBigInt(r.payload),
      status: r.status,
      attempts: Number(r.attempts),
      nextAttemptAt: normalizeOutboxIso(r.next_attempt_at),
      lastError: r.last_error ?? undefined,
      deliveredAt: r.delivered_at ? normalizeOutboxIso(r.delivered_at) : undefined,
      createdAt: normalizeOutboxIso(r.created_at),
    };
  }

  async enqueue<TPayload>(
    params: {
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      channelSlug?: string;
      payload: TPayload;
      nowIso?: string;
    },
    tx?: PgTxClient
  ): Promise<OutboxEventRecord<TPayload>> {
    const nowIso = params.nowIso ?? new Date().toISOString();
    const id = `outbox-evt-${randomUUID()}`;
    const serialized = serializeWithBigInt(
      params.payload === undefined ? null : params.payload
    );

    await this.runner(tx).query(
      `INSERT INTO transactional_outbox_events (
         id, event_type, aggregate_type, aggregate_id, channel_slug,
         payload, status, attempts, next_attempt_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'PENDING', 0, $7::timestamptz, $7::timestamptz)`,
      [
        id,
        params.eventType,
        params.aggregateType,
        params.aggregateId,
        params.channelSlug ?? null,
        serialized,
        nowIso,
      ]
    );

    return {
      id,
      eventType: params.eventType,
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      channelSlug: params.channelSlug,
      payload: params.payload,
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: nowIso,
      createdAt: nowIso,
    };
  }

  async listPending(tx?: PgTxClient): Promise<readonly OutboxEventRecord[]> {
    const res = await this.runner(tx).query<PgOutboxRow>(
      `SELECT id, event_type, aggregate_type, aggregate_id, channel_slug,
              payload, status, attempts, next_attempt_at, last_error, delivered_at, created_at
       FROM transactional_outbox_events
       WHERE status = 'PENDING'
       ORDER BY created_at ASC`
    );
    return res.rows.map((r) => this.hydrateRow(r));
  }

  async listAll(limit = 50, tx?: PgTxClient): Promise<readonly OutboxEventRecord[]> {
    const res = await this.runner(tx).query<PgOutboxRow>(
      `SELECT id, event_type, aggregate_type, aggregate_id, channel_slug,
              payload, status, attempts, next_attempt_at, last_error, delivered_at, created_at
       FROM transactional_outbox_events
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => this.hydrateRow(r));
  }

  async claimDueBatch(
    params?: {
      nowIso?: string;
      batchSize?: number;
      claimLeaseMs?: number;
    },
    tx?: PgTxClient
  ): Promise<readonly OutboxEventRecord[]> {
    const nowIso = params?.nowIso ?? new Date().toISOString();
    const batchSize = params?.batchSize ?? 25;
    const claimLeaseMs = params?.claimLeaseMs ?? 30_000;

    const exec = async (q: PgTxClient): Promise<readonly OutboxEventRecord[]> => {
      const res = await q.query<PgOutboxRow>(
        `SELECT id, event_type, aggregate_type, aggregate_id, channel_slug,
                payload, status, attempts, next_attempt_at, last_error, delivered_at, created_at
         FROM transactional_outbox_events
         WHERE status = 'PENDING' AND next_attempt_at <= $1::timestamptz
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [nowIso, batchSize]
      );
      if (res.rows.length === 0) return [];

      let nextAttemptIso = nowIso;
      if (claimLeaseMs > 0) {
        nextAttemptIso = new Date(Date.parse(nowIso) + claimLeaseMs).toISOString();
        const placeholders = res.rows.map((_, idx) => `$${idx + 2}`).join(", ");
        await q.query(
          `UPDATE transactional_outbox_events
           SET next_attempt_at = $1::timestamptz
           WHERE id IN (${placeholders})`,
          [nextAttemptIso, ...res.rows.map((r) => r.id)]
        );
      }

      return res.rows.map((r) =>
        this.hydrateRow({
          ...r,
          next_attempt_at: claimLeaseMs > 0 ? nextAttemptIso : r.next_attempt_at,
        })
      );
    };

    return tx ? tx.withTransaction(exec) : this.pool.withTransaction(exec);
  }

  async markPublished(eventId: string, nowIso?: string, tx?: PgTxClient): Promise<void> {
    const deliveredAt = nowIso ?? new Date().toISOString();
    await this.runner(tx).query(
      `UPDATE transactional_outbox_events
       SET status = 'PUBLISHED',
           attempts = attempts + 1,
           delivered_at = $1::timestamptz,
           last_error = NULL
       WHERE id = $2`,
      [deliveredAt, eventId]
    );
  }

  async recordDeliveryFailure(
    params: {
      eventId: string;
      errorMessage: string;
      maxAttempts: number;
      baseDelayMs: number;
      nowMs?: number;
    },
    tx?: PgTxClient
  ): Promise<OutboxEventStatus> {
    const exec = async (q: PgTxClient): Promise<OutboxEventStatus> => {
      const existing = await q.query<{ attempts: string }>(
        `SELECT attempts FROM transactional_outbox_events WHERE id = $1 FOR UPDATE`,
        [params.eventId]
      );
      const currentAttempts = Number(existing.rows[0]?.attempts ?? 0);
      const nextAttempts = currentAttempts + 1;
      const nextStatus: OutboxEventStatus =
        nextAttempts >= params.maxAttempts ? "DEAD_LETTER" : "PENDING";
      const backoffMs =
        params.baseDelayMs * Math.pow(2, Math.max(0, nextAttempts - 1));
      const nextAttemptAt = new Date(
        (params.nowMs ?? Date.now()) + backoffMs
      ).toISOString();

      await q.query(
        `UPDATE transactional_outbox_events
         SET status = $1,
             attempts = $2,
             next_attempt_at = $3::timestamptz,
             last_error = $4
         WHERE id = $5`,
        [nextStatus, nextAttempts, nextAttemptAt, params.errorMessage, params.eventId]
      );
      return nextStatus;
    };

    return tx ? tx.withTransaction(exec) : this.pool.withTransaction(exec);
  }

  async requeueDeadLetters(
    eventId?: string,
    nowIso?: string,
    tx?: PgTxClient
  ): Promise<number> {
    const resetTime = nowIso ?? new Date().toISOString();
    if (eventId) {
      const res = await this.runner(tx).query<{ id: string }>(
        `UPDATE transactional_outbox_events
         SET status = 'PENDING', attempts = 0, next_attempt_at = $1::timestamptz, last_error = NULL
         WHERE id = $2 AND status = 'DEAD_LETTER'
         RETURNING id`,
        [resetTime, eventId]
      );
      return res.rows.length;
    }

    const res = await this.runner(tx).query<{ id: string }>(
      `UPDATE transactional_outbox_events
       SET status = 'PENDING', attempts = 0, next_attempt_at = $1::timestamptz, last_error = NULL
       WHERE status = 'DEAD_LETTER'
       RETURNING id`,
      [resetTime]
    );
    return res.rows.length;
  }

  async getStats(tx?: PgTxClient): Promise<OutboxQueueStats> {
    const res = await this.runner(tx).query<{
      total_count: string;
      pending_count: string;
      published_count: string;
      dead_letter_count: string;
      self_healed_count: string;
    }>(
      `SELECT
         COUNT(*) AS total_count,
         COUNT(*) FILTER (WHERE status = 'PENDING') AS pending_count,
         COUNT(*) FILTER (WHERE status = 'PUBLISHED') AS published_count,
         COUNT(*) FILTER (WHERE status = 'DEAD_LETTER') AS dead_letter_count,
         COUNT(*) FILTER (WHERE status = 'PUBLISHED' AND attempts > 1) AS self_healed_count
       FROM transactional_outbox_events`
    );
    const row = res.rows[0];
    return {
      totalCount: Number(row?.total_count ?? 0),
      pendingCount: Number(row?.pending_count ?? 0),
      publishedCount: Number(row?.published_count ?? 0),
      deadLetterCount: Number(row?.dead_letter_count ?? 0),
      selfHealedCount: Number(row?.self_healed_count ?? 0),
    };
  }
}
