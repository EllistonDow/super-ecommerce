/**
 * Deterministic MSI Reservation TTL Reaper (`packages/core/src/reservation-reaper.ts`).
 *
 * Scans expired `ACTIVE` rows in `stock_reservations` (backed by partial index
 * `idx_stock_reservations_active_expiry`), atomically decrements `stock_quants.quantity_reserved`
 * back into the `Available` pool, transitions any timed-out B2B `PENDING_APPROVAL` Purchase Orders
 * to `EXPIRED_TTL` (releasing `creditReserved` and `monthlyReserved`), and emits outbox events.
 */

import { randomUUID } from "node:crypto";
import {
  deserializeWithBigInt,
  serializeWithBigInt,
  type PgPoolLike,
} from "@super-ecommerce/db";
import type {
  B2bOrganizationService,
  B2bPurchaseOrderRecord,
  PgB2bOrganizationService,
} from "./b2b-organization.ts";
import type {
  MsiInventoryService,
  PgMsiInventoryService,
  ReapReservationsResult,
} from "./inventory-service.ts";
import type {
  OutboxStoreLike,
  TransactionalOutboxService,
} from "./outbox-service.ts";

export interface ReservationReaperAuditEntry {
  readonly sweepId: string;
  readonly executedAtIso: string;
  readonly reapedReservationsCount: number;
  readonly totalUnitsReleased: number;
  readonly expiredPoNumbers: readonly string[];
  readonly releasedCreditMinorUnits: bigint;
  readonly latencyUs: number;
  readonly pgReapSql: string;
}

export class ReservationTtlReaperService {
  private readonly inventoryService: MsiInventoryService;
  private readonly b2bService?: B2bOrganizationService;
  private readonly outboxService?: TransactionalOutboxService;
  private readonly history: ReservationReaperAuditEntry[] = [];
  private sweepSeq = 0;

  constructor(params: {
    readonly inventoryService: MsiInventoryService;
    readonly b2bService?: B2bOrganizationService;
    readonly outboxService?: TransactionalOutboxService;
  }) {
    this.inventoryService = params.inventoryService;
    this.b2bService = params.b2bService;
    this.outboxService = params.outboxService;
  }

  getPgReapSqlPreview(limit = 500): string {
    return [
      `WITH expired AS (`,
      `  SELECT reservation_id, holder_id, warehouse_id, variant_id, quantity`,
      `  FROM stock_reservations`,
      `  WHERE status = 'ACTIVE' AND expires_at <= now()`,
      `  ORDER BY expires_at ASC LIMIT ${limit}`,
      `  FOR UPDATE SKIP LOCKED`,
      `), marked AS (`,
      `  UPDATE stock_reservations sr SET status = 'EXPIRED'`,
      `  FROM expired e WHERE sr.reservation_id = e.reservation_id`,
      `  RETURNING e.warehouse_id, e.variant_id, e.quantity, e.holder_id`,
      `)`,
      `UPDATE stock_quants sq`,
      `SET quantity_reserved = GREATEST(0, sq.quantity_reserved - agg.qty)`,
      `FROM (SELECT warehouse_id, variant_id, sum(quantity) AS qty FROM marked GROUP BY 1, 2) agg`,
      `WHERE sq.warehouse_id = agg.warehouse_id AND sq.variant_id = agg.variant_id;`,
    ].join("\n");
  }

  reapExpired(
    nowMs = Date.now(),
    options?: { readonly limit?: number }
  ): {
    readonly stockReap: ReapReservationsResult;
    readonly expiredPos: readonly B2bPurchaseOrderRecord[];
    readonly audit: ReservationReaperAuditEntry;
  } {
    const stockReap = this.inventoryService.reapExpiredReservations(nowMs, options);
    const expiredPos =
      this.b2bService && stockReap.expiredHolderIds.length > 0
        ? this.b2bService.expirePurchaseOrdersByIds(stockReap.expiredHolderIds, nowMs)
        : [];

    const releasedCreditMinorUnits = expiredPos.reduce(
      (acc, po) => acc + po.pricing.totalGrossAmount,
      0n
    );

    if (this.outboxService && stockReap.totalUnitsReleased > 0) {
      this.outboxService.enqueue({
        eventType: "inventory.reservation_ttl_reaped.v1",
        aggregateType: "StockReservationSweep",
        aggregateId: `sweep_${this.sweepSeq + 1}`,
        channelSlug: "us-retail",
        payload: {
          reapedReservationCount: stockReap.reapedReservationCount,
          totalUnitsReleased: stockReap.totalUnitsReleased,
          expiredHolderIds: stockReap.expiredHolderIds,
          expiredPoNumbers: expiredPos.map((p) => p.poNumber),
          releasedCreditMinorUnits: releasedCreditMinorUnits.toString(),
          reapedAtIso: stockReap.reapedAtIso,
        },
      });
    }

    const audit: ReservationReaperAuditEntry = {
      sweepId: `reap_${String(++this.sweepSeq).padStart(3, "0")}`,
      executedAtIso: stockReap.reapedAtIso,
      reapedReservationsCount: stockReap.reapedReservationCount,
      totalUnitsReleased: stockReap.totalUnitsReleased,
      expiredPoNumbers: expiredPos.map((p) => p.poNumber),
      releasedCreditMinorUnits,
      latencyUs: stockReap.latencyUs,
      pgReapSql: this.getPgReapSqlPreview(options?.limit ?? 500),
    };

    this.history.unshift(audit);
    if (this.history.length > 15) {
      this.history.length = 15;
    }

    return { stockReap, expiredPos, audit };
  }

  listAuditHistory(limit = 10): readonly ReservationReaperAuditEntry[] {
    return this.history.slice(0, limit);
  }
}

interface PgReaperAuditDetails {
  readonly sweepId: string;
  readonly expiredPoNumbers: readonly string[];
  readonly releasedCreditMinorUnits: bigint;
  readonly latencyUs: number;
  readonly pgReapSql: string;
}

function normalizeReapIso(raw: string): string {
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? raw : dt.toISOString();
}

/**
 * PostgreSQL 17-backed MSI Reservation TTL Reaper (`msi_stock_reservations`,
 * `msi_stock_slots`, `b2b_purchase_orders`, `reservation_reaper_audit`).
 */
export class PgReservationTtlReaperService {
  private readonly pool: PgPoolLike;
  private readonly inventoryService: PgMsiInventoryService;
  private readonly b2bService?: PgB2bOrganizationService;
  private readonly outboxService?: OutboxStoreLike;

  constructor(params: {
    readonly pool: PgPoolLike;
    readonly inventoryService: PgMsiInventoryService;
    readonly b2bService?: PgB2bOrganizationService;
    readonly outboxService?: OutboxStoreLike;
  }) {
    this.pool = params.pool;
    this.inventoryService = params.inventoryService;
    this.b2bService = params.b2bService;
    this.outboxService = params.outboxService;
  }

  getPgReapSqlPreview(limit = 500): string {
    return [
      `SELECT reservation_id, holder_id, warehouse_id, variant_id, quantity, expires_at`,
      `FROM msi_stock_reservations`,
      `WHERE status = 'ACTIVE' AND expires_at <= now()`,
      `ORDER BY expires_at ASC LIMIT ${limit}`,
      `FOR UPDATE SKIP LOCKED;`,
    ].join("\n");
  }

  async reapExpired(
    nowMs = Date.now(),
    options?: { readonly limit?: number }
  ): Promise<{
    readonly stockReap: ReapReservationsResult;
    readonly expiredPos: readonly B2bPurchaseOrderRecord[];
    readonly audit: ReservationReaperAuditEntry;
  }> {
    return await this.pool.withTransaction(async (tx) => {
      const stockReap = await this.inventoryService.reapExpiredReservations(
        nowMs,
        options,
        tx
      );
      const expiredPos =
        this.b2bService && stockReap.expiredHolderIds.length > 0
          ? await this.b2bService.expirePurchaseOrdersByIds(
              stockReap.expiredHolderIds,
              nowMs,
              tx
            )
          : [];

      const releasedCreditMinorUnits = expiredPos.reduce(
        (acc, po) => acc + po.pricing.totalGrossAmount,
        0n
      );
      const sweepId = `reap_${randomUUID()}`;

      if (this.outboxService && stockReap.totalUnitsReleased > 0) {
        await this.outboxService.enqueue(
          {
            eventType: "inventory.reservation_ttl_reaped.v1",
            aggregateType: "StockReservationSweep",
            aggregateId: sweepId,
            channelSlug: "us-retail",
            payload: {
              reapedReservationCount: stockReap.reapedReservationCount,
              totalUnitsReleased: stockReap.totalUnitsReleased,
              expiredHolderIds: stockReap.expiredHolderIds,
              expiredPoNumbers: expiredPos.map((p) => p.poNumber),
              releasedCreditMinorUnits: releasedCreditMinorUnits.toString(),
              reapedAtIso: stockReap.reapedAtIso,
            },
            nowIso: stockReap.reapedAtIso,
          },
          tx
        );
      }

      const pgReapSql = this.getPgReapSqlPreview(options?.limit ?? 500);
      const audit: ReservationReaperAuditEntry = {
        sweepId,
        executedAtIso: stockReap.reapedAtIso,
        reapedReservationsCount: stockReap.reapedReservationCount,
        totalUnitsReleased: stockReap.totalUnitsReleased,
        expiredPoNumbers: expiredPos.map((p) => p.poNumber),
        releasedCreditMinorUnits,
        latencyUs: stockReap.latencyUs,
        pgReapSql,
      };

      const detailsPayload: PgReaperAuditDetails = {
        sweepId,
        expiredPoNumbers: audit.expiredPoNumbers,
        releasedCreditMinorUnits,
        latencyUs: audit.latencyUs,
        pgReapSql,
      };

      await tx.query(
        `INSERT INTO reservation_reaper_audit (
           id, reaped_at, expired_count, released_units, details_json
         ) VALUES ($1, $2::timestamptz, $3, $4, $5::jsonb)`,
        [
          sweepId,
          stockReap.reapedAtIso,
          stockReap.reapedReservationCount,
          stockReap.totalUnitsReleased,
          serializeWithBigInt(detailsPayload),
        ]
      );

      return { stockReap, expiredPos, audit };
    });
  }

  async listAuditHistory(
    limit = 10
  ): Promise<readonly ReservationReaperAuditEntry[]> {
    const res = await this.pool.query<{
      id: string;
      reaped_at: string;
      expired_count: string;
      released_units: string;
      details_json: string;
    }>(
      `SELECT id, reaped_at, expired_count, released_units, details_json
       FROM reservation_reaper_audit
       ORDER BY reaped_at DESC
       LIMIT $1`,
      [limit]
    );

    return res.rows.map((r) => {
      const details = deserializeWithBigInt<PgReaperAuditDetails>(r.details_json);
      return {
        sweepId: details.sweepId ?? r.id,
        executedAtIso: normalizeReapIso(r.reaped_at),
        reapedReservationsCount: Number(r.expired_count),
        totalUnitsReleased: Number(r.released_units),
        expiredPoNumbers: details.expiredPoNumbers ?? [],
        releasedCreditMinorUnits: BigInt(details.releasedCreditMinorUnits ?? 0n),
        latencyUs: Number(details.latencyUs ?? 0),
        pgReapSql: details.pgReapSql ?? this.getPgReapSqlPreview(500),
      };
    });
  }
}
