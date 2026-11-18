/**
 * Multi-Source Inventory (MSI) Service with 3-tier stock (`onHand`, `reserved`, `allocated`),
 * minimum-split warehouse routing via the compiled Rust `commerce-kernel`, and atomic SQL
 * persistence (`stock_quants` table).
 */

import {
  type AllocationStrategy,
  type PgPoolLike,
  type PgQueryable,
  type PgTxClient,
  type StockAvailabilityMode,
} from "@super-ecommerce/db";
import {
  isNativeRustKernelLoaded,
  planInventoryAllocation,
} from "@super-ecommerce/kernel";

export interface WarehouseStockState {
  readonly warehouseId: string;
  readonly priorityRank: number;
  readonly linkedToChannel: boolean;
  readonly supportsShippingZone: boolean;
  readonly variantId: string;
  quantityOnHand: number;
  quantityReserved: number;
  quantityAllocated: number;
}

export interface LineDemand {
  readonly lineId: string;
  readonly variantId: string;
  readonly quantity: number;
}

export interface ShipmentSlice {
  readonly warehouseId: string;
  readonly lineId: string;
  readonly variantId: string;
  readonly quantityAllocated: number;
}

export type ReturnItemCondition = "RESELLABLE" | "DAMAGED_QUARANTINE";

export interface RestockedShipmentSlice {
  readonly warehouseId: string;
  readonly lineId: string;
  readonly variantId: string;
  readonly quantityReturned: number;
  readonly condition: ReturnItemCondition;
}

export type StockReservationStatus =
  | "ACTIVE"
  | "CONVERTED_TO_ALLOCATION"
  | "RELEASED"
  | "EXPIRED";

export interface StockReservationRecord {
  readonly reservationId: string;
  readonly holderId: string;
  readonly warehouseId: string;
  readonly variantId: string;
  readonly lineId: string;
  readonly quantity: number;
  status: StockReservationStatus;
  readonly ttlSeconds: number;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface ReapedReservationEntry {
  readonly reservationId: string;
  readonly holderId: string;
  readonly warehouseId: string;
  readonly variantId: string;
  readonly quantityReleased: number;
  readonly expiredAt: string;
}

export interface ReapReservationsResult {
  readonly reapedAtIso: string;
  readonly reapedReservationCount: number;
  readonly totalUnitsReleased: number;
  readonly expiredHolderIds: readonly string[];
  readonly entries: readonly ReapedReservationEntry[];
  readonly latencyUs: number;
}

export class InsufficientStockError extends Error {
  readonly lineId: string;
  readonly variantId: string;
  readonly requested: number;
  readonly available: number;

  constructor(params: {
    lineId: string;
    variantId: string;
    requested: number;
    available: number;
  }) {
    super(
      `Insufficient stock for variant '${params.variantId}' on line '${params.lineId}': requested ${params.requested}, available ${params.available}`
    );
    this.name = "InsufficientStockError";
    this.lineId = params.lineId;
    this.variantId = params.variantId;
    this.requested = params.requested;
    this.available = params.available;
  }
}

export class MsiInventoryService {
  private readonly slots: WarehouseStockState[];
  private readonly activeReservations = new Map<string, StockReservationRecord>();

  constructor(initialSlots: readonly WarehouseStockState[] = []) {
    this.slots = initialSlots.map((s) => ({ ...s }));
  }

  getAvailableQuantity(slot: WarehouseStockState): number {
    return Math.max(
      0,
      slot.quantityOnHand - slot.quantityReserved - slot.quantityAllocated
    );
  }

  getSlot(warehouseId: string, variantId: string): WarehouseStockState | undefined {
    return this.slots.find(
      (s) => s.warehouseId === warehouseId && s.variantId === variantId
    );
  }

  listAllSlots(limit = 50): WarehouseStockState[] {
    return [...this.slots]
      .sort(
        (a, b) =>
          a.priorityRank - b.priorityRank ||
          a.warehouseId.localeCompare(b.warehouseId) ||
          a.variantId.localeCompare(b.variantId)
      )
      .slice(0, limit);
  }

  upsertExternalSlots(
    externalSlots: readonly WarehouseStockState[],
    options?: { preserveAllocated?: boolean }
  ): number {
    const preserve = options?.preserveAllocated ?? true;
    let count = 0;

    for (const s of externalSlots) {
      const existing = this.getSlot(s.warehouseId, s.variantId);
      const nextAllocated =
        preserve && existing
          ? Math.max(existing.quantityAllocated, s.quantityAllocated)
          : s.quantityAllocated;

      const memIdx = this.slots.findIndex(
        (m) => m.warehouseId === s.warehouseId && m.variantId === s.variantId
      );
      const updatedSlot: WarehouseStockState = {
        ...s,
        quantityAllocated: nextAllocated,
      };
      if (memIdx >= 0) {
        this.slots[memIdx] = updatedSlot;
      } else {
        this.slots.push(updatedSlot);
      }
      count++;
    }

    return count;
  }

  /**
   * Plans and commits stock allocations across warehouses using the compiled
   * Rust `commerce-kernel` MSI engine.
   * Throws `InsufficientStockError` (without mutating state) if any line cannot be fulfilled.
   */
  allocateForCheckout(params: {
    demands: readonly LineDemand[];
    availabilityMode: StockAvailabilityMode;
    strategy: AllocationStrategy;
  }): {
    shipmentCount: number;
    allocations: readonly ShipmentSlice[];
  } {
    if (!isNativeRustKernelLoaded()) {
      throw new Error("Native Rust kernel is required for MSI allocation");
    }

    const rustPlan = planInventoryAllocation({
      availabilityMode: params.availabilityMode,
      strategy: params.strategy,
      slots: this.slots.map((s) => ({
        warehouseId: s.warehouseId,
        priorityRank: s.priorityRank,
        linkedToChannel: s.linkedToChannel,
        supportsShippingZone: s.supportsShippingZone,
        variantId: s.variantId,
        onHand: s.quantityOnHand,
        reserved: s.quantityReserved,
        allocated: s.quantityAllocated,
      })),
      demands: params.demands,
    });

    if (!rustPlan.isFullyAllocated && rustPlan.unallocatedLines.length > 0) {
      const firstUnalloc = rustPlan.unallocatedLines[0]!;
      const demand = params.demands.find((d) => d.lineId === firstUnalloc.lineId);
      const requested = demand?.quantity ?? firstUnalloc.missingQuantity;
      throw new InsufficientStockError({
        lineId: firstUnalloc.lineId,
        variantId: firstUnalloc.variantId,
        requested,
        available: requested - firstUnalloc.missingQuantity,
      });
    }

    for (const slice of rustPlan.allocations) {
      const memSlot = this.slots.find(
        (s) => s.warehouseId === slice.warehouseId && s.variantId === slice.variantId
      );
      if (memSlot) {
        memSlot.quantityAllocated += slice.quantityAllocated;
      }
    }

    return {
      shipmentCount: rustPlan.shipmentCount,
      allocations: rustPlan.allocations,
    };
  }

  /**
   * Reverse compensation: releases previously allocated quantities back to available pool.
   */
  releaseAllocations(allocations: readonly ShipmentSlice[]): void {
    for (const slice of allocations) {
      const slot = this.slots.find(
        (s) => s.warehouseId === slice.warehouseId && s.variantId === slice.variantId
      );
      if (slot) {
        slot.quantityAllocated = Math.max(
          0,
          slot.quantityAllocated - slice.quantityAllocated
        );
      }
    }
  }

  /**
   * RMA Inventory Restock:
   * - `RESELLABLE`: Decrements `quantityAllocated` while keeping `quantityOnHand` intact,
   *   immediately returning the units back to the `Available` pool.
   * - `DAMAGED_QUARANTINE`: Decrements both `quantityAllocated` and `quantityOnHand` so
   *   defective returned units are written off to quarantine without inflating sellable stock.
   */
  restockReturnedItems(slices: readonly RestockedShipmentSlice[]): RestockedShipmentSlice[] {
    const applied: RestockedShipmentSlice[] = [];
    for (const slice of slices) {
      if (slice.quantityReturned <= 0) continue;
      const onHandDelta = slice.condition === "DAMAGED_QUARANTINE" ? slice.quantityReturned : 0;
      const slot = this.slots.find(
        (s) => s.warehouseId === slice.warehouseId && s.variantId === slice.variantId
      );
      if (slot) {
        slot.quantityAllocated = Math.max(0, slot.quantityAllocated - slice.quantityReturned);
        if (onHandDelta > 0) {
          slot.quantityOnHand = Math.max(0, slot.quantityOnHand - onHandDelta);
        }
      }
      applied.push({ ...slice });
    }
    return applied;
  }

  /**
   * LIFO compensation for `restockReturnedItems`: restores `quantityAllocated` (and `quantityOnHand`
   * for quarantined items) if a downstream RMA refund step fails.
   */
  revertRmaRestock(slices: readonly RestockedShipmentSlice[]): void {
    for (const slice of slices) {
      if (slice.quantityReturned <= 0) continue;
      const onHandDelta = slice.condition === "DAMAGED_QUARANTINE" ? slice.quantityReturned : 0;
      const slot = this.slots.find(
        (s) => s.warehouseId === slice.warehouseId && s.variantId === slice.variantId
      );
      if (slot) {
        slot.quantityAllocated += slice.quantityReturned;
        slot.quantityOnHand += onHandDelta;
      }
    }
  }

  /**
   * Deducts allocated and on-hand stock when an order is dispatched for fulfillment.
   */
  deductAllocatedStock(slices: readonly ShipmentSlice[]): void {
    for (const slice of slices) {
      if (slice.quantityAllocated <= 0) continue;
      const slot = this.slots.find(
        (s) => s.warehouseId === slice.warehouseId && s.variantId === slice.variantId
      );
      if (slot) {
        slot.quantityAllocated = Math.max(0, slot.quantityAllocated - slice.quantityAllocated);
        slot.quantityOnHand = Math.max(0, slot.quantityOnHand - slice.quantityAllocated);
      }
    }
  }

  /**
   * LIFO compensation for `deductAllocatedStock`: restores `quantityAllocated` and `quantityOnHand`
   * if downstream fulfillment steps fail.
   */
  revertDeductAllocatedStock(slices: readonly ShipmentSlice[]): void {
    for (const slice of slices) {
      if (slice.quantityAllocated <= 0) continue;
      const slot = this.slots.find(
        (s) => s.warehouseId === slice.warehouseId && s.variantId === slice.variantId
      );
      if (slot) {
        slot.quantityAllocated += slice.quantityAllocated;
        slot.quantityOnHand += slice.quantityAllocated;
      }
    }
  }

  /**
   * Reserves MSI stock for a B2B Purchase Order awaiting supervisor approval (e.g. 72h TTL)
   * or an active checkout hold. Increments `quantity_reserved` (not `quantity_allocated`).
   */
  reserveForPurchaseOrder(params: {
    holderId: string;
    demands: readonly LineDemand[];
    availabilityMode: StockAvailabilityMode;
    strategy: AllocationStrategy;
    ttlSeconds: number;
    nowMs?: number;
  }): {
    shipmentCount: number;
    reservationSlices: readonly ShipmentSlice[];
    expiresAt: string;
  } {
    const now = params.nowMs ?? Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + params.ttlSeconds * 1000).toISOString();

    const rustPlan = planInventoryAllocation({
      availabilityMode: params.availabilityMode,
      strategy: params.strategy,
      slots: this.slots.map((s) => ({
        warehouseId: s.warehouseId,
        priorityRank: s.priorityRank,
        linkedToChannel: s.linkedToChannel,
        supportsShippingZone: s.supportsShippingZone,
        variantId: s.variantId,
        onHand: s.quantityOnHand,
        reserved: s.quantityReserved,
        allocated: s.quantityAllocated,
      })),
      demands: params.demands,
    });

    if (!rustPlan.isFullyAllocated && rustPlan.unallocatedLines.length > 0) {
      const firstUnalloc = rustPlan.unallocatedLines[0]!;
      const demand = params.demands.find((d) => d.lineId === firstUnalloc.lineId);
      const requested = demand?.quantity ?? firstUnalloc.missingQuantity;
      throw new InsufficientStockError({
        lineId: firstUnalloc.lineId,
        variantId: firstUnalloc.variantId,
        requested,
        available: requested - firstUnalloc.missingQuantity,
      });
    }

    for (let i = 0; i < rustPlan.allocations.length; i++) {
      const slice = rustPlan.allocations[i]!;
      const reservationId = `res_${params.holderId}_${i + 1}`;
      const resRecord: StockReservationRecord = {
        reservationId,
        holderId: params.holderId,
        warehouseId: slice.warehouseId,
        variantId: slice.variantId,
        lineId: slice.lineId,
        quantity: slice.quantityAllocated,
        status: "ACTIVE",
        ttlSeconds: params.ttlSeconds,
        expiresAt,
        createdAt,
      };
      this.activeReservations.set(reservationId, resRecord);

      const memSlot = this.slots.find(
        (s) => s.warehouseId === slice.warehouseId && s.variantId === slice.variantId
      );
      if (memSlot) {
        memSlot.quantityReserved += slice.quantityAllocated;
      }
    }

    return {
      shipmentCount: rustPlan.shipmentCount,
      reservationSlices: rustPlan.allocations,
      expiresAt,
    };
  }

  /**
   * Atomically converts an active B2B Purchase Order reservation into a permanent order
   * allocation (`quantity_reserved -= qty`, `quantity_allocated += qty`).
   */
  convertReservationToAllocation(
    holderId: string,
    slices: readonly ShipmentSlice[]
  ): void {
    for (const slice of slices) {
      const memSlot = this.slots.find(
        (s) => s.warehouseId === slice.warehouseId && s.variantId === slice.variantId
      );
      if (memSlot) {
        memSlot.quantityReserved = Math.max(
          0,
          memSlot.quantityReserved - slice.quantityAllocated
        );
        memSlot.quantityAllocated += slice.quantityAllocated;
      }
    }
    for (const r of this.activeReservations.values()) {
      if (r.holderId === holderId && r.status === "ACTIVE") {
        r.status = "CONVERTED_TO_ALLOCATION";
      }
    }
  }

  /**
   * LIFO reverse compensation for `convertReservationToAllocation`: restores `quantity_reserved`
   * and decrements `quantity_allocated` if a downstream PO approval commit step fails.
   */
  revertReservationConversion(
    holderId: string,
    slices: readonly ShipmentSlice[]
  ): void {
    for (const slice of slices) {
      const memSlot = this.slots.find(
        (s) => s.warehouseId === slice.warehouseId && s.variantId === slice.variantId
      );
      if (memSlot) {
        memSlot.quantityAllocated = Math.max(
          0,
          memSlot.quantityAllocated - slice.quantityAllocated
        );
        memSlot.quantityReserved += slice.quantityAllocated;
      }
    }
    for (const r of this.activeReservations.values()) {
      if (r.holderId === holderId && r.status === "CONVERTED_TO_ALLOCATION") {
        r.status = "ACTIVE";
      }
    }
  }

  /**
   * Releases an active B2B Purchase Order reservation back to the available pool
   * (e.g. when a supervisor rejects the PO or the reservation expires).
   */
  releaseReservation(holderId: string, slices: readonly ShipmentSlice[]): void {
    for (const slice of slices) {
      const memSlot = this.slots.find(
        (s) => s.warehouseId === slice.warehouseId && s.variantId === slice.variantId
      );
      if (memSlot) {
        memSlot.quantityReserved = Math.max(
          0,
          memSlot.quantityReserved - slice.quantityAllocated
        );
      }
    }
    for (const r of this.activeReservations.values()) {
      if (r.holderId === holderId && r.status === "ACTIVE") {
        r.status = "RELEASED";
      }
    }
  }

  listReservations(statusFilter?: StockReservationStatus): StockReservationRecord[] {
    return Array.from(this.activeReservations.values())
      .filter((r) => !statusFilter || r.status === statusFilter)
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
      .map((r) => ({ ...r }));
  }

  /**
   * Deterministically reaps expired `ACTIVE` MSI stock reservations (`expires_at <= nowMs`),
   * releasing `quantity_reserved` back into the `Available` pool.
   */
  reapExpiredReservations(
    nowMs = Date.now(),
    options?: { readonly limit?: number }
  ): ReapReservationsResult {
    const t0 = process.hrtime.bigint();
    const reapedAtIso = new Date(nowMs).toISOString();
    const limit = options?.limit ?? 500;

    const entries: ReapedReservationEntry[] = [];
    const expiredHolders = new Set<string>();
    let totalUnitsReleased = 0;

    const candidates = Array.from(this.activeReservations.values())
      .filter((r) => r.status === "ACTIVE" && Date.parse(r.expiresAt) <= nowMs)
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
      .slice(0, limit);

    for (const res of candidates) {
      if (res.status !== "ACTIVE") continue;
      res.status = "EXPIRED";
      const memSlot = this.slots.find(
        (s) => s.warehouseId === res.warehouseId && s.variantId === res.variantId
      );
      if (memSlot) {
        memSlot.quantityReserved = Math.max(0, memSlot.quantityReserved - res.quantity);
      }
      totalUnitsReleased += res.quantity;
      expiredHolders.add(res.holderId);
      entries.push({
        reservationId: res.reservationId,
        holderId: res.holderId,
        warehouseId: res.warehouseId,
        variantId: res.variantId,
        quantityReleased: res.quantity,
        expiredAt: res.expiresAt,
      });
    }

    const latencyUs =
      Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 100) / 100;
    return {
      reapedAtIso,
      reapedReservationCount: entries.length,
      totalUnitsReleased,
      expiredHolderIds: Array.from(expiredHolders),
      entries,
      latencyUs,
    };
  }
}

export interface MsiInventoryServiceLike {
  getAvailableQuantity(slot: WarehouseStockState): number;
  getSlot(
    warehouseId: string,
    variantId: string
  ): WarehouseStockState | undefined | Promise<WarehouseStockState | undefined>;
  listAllSlots(
    limit?: number
  ): WarehouseStockState[] | Promise<WarehouseStockState[]>;
  allocateForCheckout(params: {
    demands: readonly LineDemand[];
    availabilityMode: StockAvailabilityMode;
    strategy: AllocationStrategy;
  }):
    | { shipmentCount: number; allocations: readonly ShipmentSlice[] }
    | Promise<{ shipmentCount: number; allocations: readonly ShipmentSlice[] }>;
  releaseAllocations(
    allocations: readonly ShipmentSlice[],
    tx?: PgTxClient
  ): void | Promise<void>;
  restockReturnedItems(
    slices: readonly RestockedShipmentSlice[],
    tx?: PgTxClient
  ): RestockedShipmentSlice[] | Promise<RestockedShipmentSlice[]>;
  revertRmaRestock(
    slices: readonly RestockedShipmentSlice[],
    tx?: PgTxClient
  ): void | Promise<void>;
  deductAllocatedStock(
    slices: readonly ShipmentSlice[],
    tx?: PgTxClient
  ): void | Promise<void>;
  revertDeductAllocatedStock(
    slices: readonly ShipmentSlice[],
    tx?: PgTxClient
  ): void | Promise<void>;
  reserveForPurchaseOrder(
    params: {
      holderId: string;
      demands: readonly LineDemand[];
      availabilityMode: StockAvailabilityMode;
      strategy: AllocationStrategy;
      ttlSeconds: number;
      nowMs?: number;
    },
    tx?: PgTxClient
  ):
    | {
        shipmentCount: number;
        reservationSlices: readonly ShipmentSlice[];
        expiresAt: string;
      }
    | Promise<{
        shipmentCount: number;
        reservationSlices: readonly ShipmentSlice[];
        expiresAt: string;
      }>;
  convertReservationToAllocation(
    holderId: string,
    slices: readonly ShipmentSlice[],
    tx?: PgTxClient
  ): void | Promise<void>;
  revertReservationConversion(
    holderId: string,
    slices: readonly ShipmentSlice[],
    tx?: PgTxClient
  ): void | Promise<void>;
  releaseReservation(
    holderId: string,
    slices: readonly ShipmentSlice[],
    tx?: PgTxClient
  ): void | Promise<void>;
  listReservations(
    statusFilter?: StockReservationStatus
  ): StockReservationRecord[] | Promise<StockReservationRecord[]>;
  reapExpiredReservations(
    nowMs?: number,
    options?: { readonly limit?: number },
    tx?: PgTxClient
  ): ReapReservationsResult | Promise<ReapReservationsResult>;
}

interface PgMsiSlotRow {
  warehouse_id: string;
  priority_rank: string;
  linked_to_channel: string | boolean;
  supports_shipping_zone: string | boolean;
  variant_id: string;
  quantity_on_hand: string;
  quantity_reserved: string;
  quantity_allocated: string;
}

interface PgMsiReservationRow {
  reservation_id: string;
  holder_id: string;
  warehouse_id: string;
  variant_id: string;
  line_id: string;
  quantity: string;
  status: StockReservationStatus;
  ttl_seconds: string;
  expires_at: string;
  created_at: string;
}

function parsePgBool(val: string | boolean | null | undefined): boolean {
  return val === true || val === "t" || val === "true" || val === "1";
}

function normalizeIsoTimestamp(raw: string): string {
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? raw : dt.toISOString();
}

function sortByWarehouseVariant<T extends { readonly warehouseId: string; readonly variantId: string }>(
  items: readonly T[]
): T[] {
  return [...items].sort(
    (a, b) =>
      a.warehouseId.localeCompare(b.warehouseId) ||
      a.variantId.localeCompare(b.variantId)
  );
}

/**
 * PostgreSQL 17-backed Multi-Source Inventory (MSI) Service (`msi_stock_slots`,
 * `msi_stock_reservations`).
 *
 * Enforces canonical `(warehouse_id ASC, variant_id ASC)` `FOR UPDATE` row locking to prevent
 * deadlocks, atomic `(quantity_on_hand - quantity_reserved - quantity_allocated) >= qty` guards,
 * Rust `commerce-kernel` minimum-split allocation planning, and `SKIP LOCKED` reservation reaping.
 */
export class PgMsiInventoryService implements MsiInventoryServiceLike {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  private runner(tx?: PgTxClient): PgQueryable {
    return tx ?? this.pool;
  }

  private async runInTx<T>(
    tx: PgTxClient | undefined,
    fn: (q: PgTxClient) => Promise<T>
  ): Promise<T> {
    return tx ? tx.withTransaction(fn) : this.pool.withTransaction(fn);
  }

  private hydrateSlot(row: PgMsiSlotRow): WarehouseStockState {
    return {
      warehouseId: row.warehouse_id,
      priorityRank: Number(row.priority_rank),
      linkedToChannel: parsePgBool(row.linked_to_channel),
      supportsShippingZone: parsePgBool(row.supports_shipping_zone),
      variantId: row.variant_id,
      quantityOnHand: Number(row.quantity_on_hand),
      quantityReserved: Number(row.quantity_reserved),
      quantityAllocated: Number(row.quantity_allocated),
    };
  }

  private hydrateReservation(row: PgMsiReservationRow): StockReservationRecord {
    return {
      reservationId: row.reservation_id,
      holderId: row.holder_id,
      warehouseId: row.warehouse_id,
      variantId: row.variant_id,
      lineId: row.line_id,
      quantity: Number(row.quantity),
      status: row.status,
      ttlSeconds: Number(row.ttl_seconds),
      expiresAt: normalizeIsoTimestamp(row.expires_at),
      createdAt: normalizeIsoTimestamp(row.created_at),
    };
  }

  getAvailableQuantity(slot: WarehouseStockState): number {
    return Math.max(
      0,
      slot.quantityOnHand - slot.quantityReserved - slot.quantityAllocated
    );
  }

  async getSlot(
    warehouseId: string,
    variantId: string,
    tx?: PgTxClient
  ): Promise<WarehouseStockState | undefined> {
    const res = await this.runner(tx).query<PgMsiSlotRow>(
      `SELECT warehouse_id, priority_rank, linked_to_channel, supports_shipping_zone,
              variant_id, quantity_on_hand, quantity_reserved, quantity_allocated
       FROM msi_stock_slots
       WHERE warehouse_id = $1 AND variant_id = $2`,
      [warehouseId, variantId]
    );
    const row = res.rows[0];
    return row ? this.hydrateSlot(row) : undefined;
  }

  async listAllSlots(limit = 50, tx?: PgTxClient): Promise<WarehouseStockState[]> {
    const res = await this.runner(tx).query<PgMsiSlotRow>(
      `SELECT warehouse_id, priority_rank, linked_to_channel, supports_shipping_zone,
              variant_id, quantity_on_hand, quantity_reserved, quantity_allocated
       FROM msi_stock_slots
       ORDER BY priority_rank ASC, warehouse_id ASC, variant_id ASC
       LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => this.hydrateSlot(r));
  }

  async upsertExternalSlots(
    externalSlots: readonly WarehouseStockState[],
    options?: { preserveAllocated?: boolean },
    tx?: PgTxClient
  ): Promise<number> {
    if (externalSlots.length === 0) return 0;
    const preserve = options?.preserveAllocated ?? true;
    const sorted = sortByWarehouseVariant(externalSlots);
    const nowIso = new Date().toISOString();

    return await this.runInTx(tx, async (q) => {
      for (const s of sorted) {
        const allocExpr = preserve
          ? `CASE WHEN msi_stock_slots.quantity_allocated > excluded.quantity_allocated THEN msi_stock_slots.quantity_allocated ELSE excluded.quantity_allocated END`
          : `excluded.quantity_allocated`;

        await q.query(
          `INSERT INTO msi_stock_slots (
             warehouse_id, variant_id, priority_rank, linked_to_channel,
             supports_shipping_zone, quantity_on_hand, quantity_reserved,
             quantity_allocated, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
           ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET
             priority_rank = excluded.priority_rank,
             linked_to_channel = excluded.linked_to_channel,
             supports_shipping_zone = excluded.supports_shipping_zone,
             quantity_on_hand = excluded.quantity_on_hand,
             quantity_reserved = excluded.quantity_reserved,
             quantity_allocated = ${allocExpr},
             updated_at = excluded.updated_at`,
          [
            s.warehouseId,
            s.variantId,
            s.priorityRank,
            s.linkedToChannel,
            s.supportsShippingZone,
            s.quantityOnHand,
            s.quantityReserved,
            s.quantityAllocated,
            nowIso,
          ]
        );
      }
      return sorted.length;
    });
  }

  private async lockSlotsForVariants(
    q: PgTxClient,
    variantIds: readonly string[]
  ): Promise<WarehouseStockState[]> {
    const uniqueVariants = [...new Set(variantIds)].sort();
    if (uniqueVariants.length === 0) return [];
    const placeholders = uniqueVariants.map((_, i) => `$${i + 1}`).join(", ");
    const res = await q.query<PgMsiSlotRow>(
      `SELECT warehouse_id, priority_rank, linked_to_channel, supports_shipping_zone,
              variant_id, quantity_on_hand, quantity_reserved, quantity_allocated
       FROM msi_stock_slots
       WHERE variant_id IN (${placeholders})
       ORDER BY warehouse_id ASC, variant_id ASC
       FOR UPDATE`,
      uniqueVariants
    );
    return res.rows.map((r) => this.hydrateSlot(r));
  }

  async allocateForCheckout(
    params: {
      demands: readonly LineDemand[];
      availabilityMode: StockAvailabilityMode;
      strategy: AllocationStrategy;
    },
    tx?: PgTxClient
  ): Promise<{
    shipmentCount: number;
    allocations: readonly ShipmentSlice[];
  }> {
    if (!isNativeRustKernelLoaded()) {
      throw new Error("Native Rust kernel is required for MSI allocation");
    }
    if (params.demands.length === 0) {
      return { shipmentCount: 0, allocations: [] };
    }

    return await this.runInTx(tx, async (q) => {
      const currentSlots = await this.lockSlotsForVariants(
        q,
        params.demands.map((d) => d.variantId)
      );

      const rustPlan = planInventoryAllocation({
        availabilityMode: params.availabilityMode,
        strategy: params.strategy,
        slots: currentSlots.map((s) => ({
          warehouseId: s.warehouseId,
          priorityRank: s.priorityRank,
          linkedToChannel: s.linkedToChannel,
          supportsShippingZone: s.supportsShippingZone,
          variantId: s.variantId,
          onHand: s.quantityOnHand,
          reserved: s.quantityReserved,
          allocated: s.quantityAllocated,
        })),
        demands: params.demands,
      });

      if (!rustPlan.isFullyAllocated && rustPlan.unallocatedLines.length > 0) {
        const firstUnalloc = rustPlan.unallocatedLines[0]!;
        const demand = params.demands.find((d) => d.lineId === firstUnalloc.lineId);
        const requested = demand?.quantity ?? firstUnalloc.missingQuantity;
        throw new InsufficientStockError({
          lineId: firstUnalloc.lineId,
          variantId: firstUnalloc.variantId,
          requested,
          available: requested - firstUnalloc.missingQuantity,
        });
      }

      const nowIso = new Date().toISOString();
      const sortedSlices = sortByWarehouseVariant(rustPlan.allocations);
      for (const slice of sortedSlices) {
        const upd = await q.query<{ warehouse_id: string }>(
          `UPDATE msi_stock_slots
           SET quantity_allocated = quantity_allocated + $1,
               updated_at = $2::timestamptz
           WHERE warehouse_id = $3
             AND variant_id = $4
             AND (quantity_on_hand - quantity_reserved - quantity_allocated) >= $1
           RETURNING warehouse_id`,
          [slice.quantityAllocated, nowIso, slice.warehouseId, slice.variantId]
        );
        if (upd.rows.length !== 1) {
          throw new InsufficientStockError({
            lineId: slice.lineId,
            variantId: slice.variantId,
            requested: slice.quantityAllocated,
            available: 0,
          });
        }
      }

      return {
        shipmentCount: rustPlan.shipmentCount,
        allocations: rustPlan.allocations,
      };
    });
  }

  async releaseAllocations(
    allocations: readonly ShipmentSlice[],
    tx?: PgTxClient
  ): Promise<void> {
    if (allocations.length === 0) return;
    const nowIso = new Date().toISOString();
    const sorted = sortByWarehouseVariant(allocations);
    await this.runInTx(tx, async (q) => {
      for (const slice of sorted) {
        await q.query(
          `UPDATE msi_stock_slots
           SET quantity_allocated = CASE
                 WHEN quantity_allocated - $1 < 0 THEN 0
                 ELSE quantity_allocated - $1
               END,
               updated_at = $2::timestamptz
           WHERE warehouse_id = $3 AND variant_id = $4`,
          [slice.quantityAllocated, nowIso, slice.warehouseId, slice.variantId]
        );
      }
    });
  }

  async restockReturnedItems(
    slices: readonly RestockedShipmentSlice[],
    tx?: PgTxClient
  ): Promise<RestockedShipmentSlice[]> {
    const valid = sortByWarehouseVariant(slices.filter((s) => s.quantityReturned > 0));
    if (valid.length === 0) return [];
    const nowIso = new Date().toISOString();

    await this.runInTx(tx, async (q) => {
      for (const slice of valid) {
        const onHandDelta =
          slice.condition === "DAMAGED_QUARANTINE" ? slice.quantityReturned : 0;
        await q.query(
          `UPDATE msi_stock_slots
           SET quantity_allocated = CASE
                 WHEN quantity_allocated - $1 < 0 THEN 0
                 ELSE quantity_allocated - $1
               END,
               quantity_on_hand = CASE
                 WHEN quantity_on_hand - $2 < 0 THEN 0
                 ELSE quantity_on_hand - $2
               END,
               updated_at = $3::timestamptz
           WHERE warehouse_id = $4 AND variant_id = $5`,
          [
            slice.quantityReturned,
            onHandDelta,
            nowIso,
            slice.warehouseId,
            slice.variantId,
          ]
        );
      }
    });
    return valid.map((s) => ({ ...s }));
  }

  async revertRmaRestock(
    slices: readonly RestockedShipmentSlice[],
    tx?: PgTxClient
  ): Promise<void> {
    const valid = sortByWarehouseVariant(slices.filter((s) => s.quantityReturned > 0));
    if (valid.length === 0) return;
    const nowIso = new Date().toISOString();

    await this.runInTx(tx, async (q) => {
      for (const slice of valid) {
        const onHandDelta =
          slice.condition === "DAMAGED_QUARANTINE" ? slice.quantityReturned : 0;
        await q.query(
          `UPDATE msi_stock_slots
           SET quantity_allocated = quantity_allocated + $1,
               quantity_on_hand = quantity_on_hand + $2,
               updated_at = $3::timestamptz
           WHERE warehouse_id = $4 AND variant_id = $5`,
          [
            slice.quantityReturned,
            onHandDelta,
            nowIso,
            slice.warehouseId,
            slice.variantId,
          ]
        );
      }
    });
  }

  async deductAllocatedStock(
    slices: readonly ShipmentSlice[],
    tx?: PgTxClient
  ): Promise<void> {
    const valid = sortByWarehouseVariant(slices.filter((s) => s.quantityAllocated > 0));
    if (valid.length === 0) return;
    const nowIso = new Date().toISOString();

    await this.runInTx(tx, async (q) => {
      for (const slice of valid) {
        await q.query(
          `UPDATE msi_stock_slots
           SET quantity_allocated = CASE
                 WHEN quantity_allocated - $1 < 0 THEN 0
                 ELSE quantity_allocated - $1
               END,
               quantity_on_hand = CASE
                 WHEN quantity_on_hand - $1 < 0 THEN 0
                 ELSE quantity_on_hand - $1
               END,
               updated_at = $2::timestamptz
           WHERE warehouse_id = $3 AND variant_id = $4`,
          [
            slice.quantityAllocated,
            nowIso,
            slice.warehouseId,
            slice.variantId,
          ]
        );
      }
    });
  }

  async revertDeductAllocatedStock(
    slices: readonly ShipmentSlice[],
    tx?: PgTxClient
  ): Promise<void> {
    const valid = sortByWarehouseVariant(slices.filter((s) => s.quantityAllocated > 0));
    if (valid.length === 0) return;
    const nowIso = new Date().toISOString();

    await this.runInTx(tx, async (q) => {
      for (const slice of valid) {
        await q.query(
          `UPDATE msi_stock_slots
           SET quantity_allocated = quantity_allocated + $1,
               quantity_on_hand = quantity_on_hand + $1,
               updated_at = $2::timestamptz
           WHERE warehouse_id = $3 AND variant_id = $4`,
          [
            slice.quantityAllocated,
            nowIso,
            slice.warehouseId,
            slice.variantId,
          ]
        );
      }
    });
  }

  async reserveForPurchaseOrder(
    params: {
      holderId: string;
      demands: readonly LineDemand[];
      availabilityMode: StockAvailabilityMode;
      strategy: AllocationStrategy;
      ttlSeconds: number;
      nowMs?: number;
    },
    tx?: PgTxClient
  ): Promise<{
    shipmentCount: number;
    reservationSlices: readonly ShipmentSlice[];
    expiresAt: string;
  }> {
    const now = params.nowMs ?? Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + params.ttlSeconds * 1000).toISOString();

    if (params.demands.length === 0) {
      return { shipmentCount: 0, reservationSlices: [], expiresAt };
    }

    return await this.runInTx(tx, async (q) => {
      const currentSlots = await this.lockSlotsForVariants(
        q,
        params.demands.map((d) => d.variantId)
      );

      const rustPlan = planInventoryAllocation({
        availabilityMode: params.availabilityMode,
        strategy: params.strategy,
        slots: currentSlots.map((s) => ({
          warehouseId: s.warehouseId,
          priorityRank: s.priorityRank,
          linkedToChannel: s.linkedToChannel,
          supportsShippingZone: s.supportsShippingZone,
          variantId: s.variantId,
          onHand: s.quantityOnHand,
          reserved: s.quantityReserved,
          allocated: s.quantityAllocated,
        })),
        demands: params.demands,
      });

      if (!rustPlan.isFullyAllocated && rustPlan.unallocatedLines.length > 0) {
        const firstUnalloc = rustPlan.unallocatedLines[0]!;
        const demand = params.demands.find((d) => d.lineId === firstUnalloc.lineId);
        const requested = demand?.quantity ?? firstUnalloc.missingQuantity;
        throw new InsufficientStockError({
          lineId: firstUnalloc.lineId,
          variantId: firstUnalloc.variantId,
          requested,
          available: requested - firstUnalloc.missingQuantity,
        });
      }

      const indexedSlices = rustPlan.allocations.map((slice, idx) => ({
        slice,
        reservationId: `res_${params.holderId}_${idx + 1}`,
      }));
      const sortedSlices = [...indexedSlices].sort(
        (a, b) =>
          a.slice.warehouseId.localeCompare(b.slice.warehouseId) ||
          a.slice.variantId.localeCompare(b.slice.variantId)
      );

      for (const { slice, reservationId } of sortedSlices) {
        const upd = await q.query<{ warehouse_id: string }>(
          `UPDATE msi_stock_slots
           SET quantity_reserved = quantity_reserved + $1,
               updated_at = $2::timestamptz
           WHERE warehouse_id = $3
             AND variant_id = $4
             AND (quantity_on_hand - quantity_reserved - quantity_allocated) >= $1
           RETURNING warehouse_id`,
          [slice.quantityAllocated, createdAt, slice.warehouseId, slice.variantId]
        );
        if (upd.rows.length !== 1) {
          throw new InsufficientStockError({
            lineId: slice.lineId,
            variantId: slice.variantId,
            requested: slice.quantityAllocated,
            available: 0,
          });
        }

        await q.query(
          `INSERT INTO msi_stock_reservations (
             reservation_id, holder_id, warehouse_id, variant_id, line_id,
             quantity, status, ttl_seconds, expires_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8::timestamptz, $9::timestamptz)`,
          [
            reservationId,
            params.holderId,
            slice.warehouseId,
            slice.variantId,
            slice.lineId,
            slice.quantityAllocated,
            params.ttlSeconds,
            expiresAt,
            createdAt,
          ]
        );
      }

      return {
        shipmentCount: rustPlan.shipmentCount,
        reservationSlices: rustPlan.allocations,
        expiresAt,
      };
    });
  }

  async convertReservationToAllocation(
    holderId: string,
    slices: readonly ShipmentSlice[],
    tx?: PgTxClient
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const sorted = sortByWarehouseVariant(slices);
    await this.runInTx(tx, async (q) => {
      for (const slice of sorted) {
        await q.query(
          `UPDATE msi_stock_slots
           SET quantity_reserved = CASE
                 WHEN quantity_reserved - $1 < 0 THEN 0
                 ELSE quantity_reserved - $1
               END,
               quantity_allocated = quantity_allocated + $1,
               updated_at = $2::timestamptz
           WHERE warehouse_id = $3 AND variant_id = $4`,
          [slice.quantityAllocated, nowIso, slice.warehouseId, slice.variantId]
        );
      }
      await q.query(
        `UPDATE msi_stock_reservations
         SET status = 'CONVERTED_TO_ALLOCATION'
         WHERE holder_id = $1 AND status = 'ACTIVE'`,
        [holderId]
      );
    });
  }

  async revertReservationConversion(
    holderId: string,
    slices: readonly ShipmentSlice[],
    tx?: PgTxClient
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const sorted = sortByWarehouseVariant(slices);
    await this.runInTx(tx, async (q) => {
      for (const slice of sorted) {
        await q.query(
          `UPDATE msi_stock_slots
           SET quantity_allocated = CASE
                 WHEN quantity_allocated - $1 < 0 THEN 0
                 ELSE quantity_allocated - $1
               END,
               quantity_reserved = quantity_reserved + $1,
               updated_at = $2::timestamptz
           WHERE warehouse_id = $3 AND variant_id = $4`,
          [slice.quantityAllocated, nowIso, slice.warehouseId, slice.variantId]
        );
      }
      await q.query(
        `UPDATE msi_stock_reservations
         SET status = 'ACTIVE'
         WHERE holder_id = $1 AND status = 'CONVERTED_TO_ALLOCATION'`,
        [holderId]
      );
    });
  }

  async releaseReservation(
    holderId: string,
    slices: readonly ShipmentSlice[],
    tx?: PgTxClient
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const sorted = sortByWarehouseVariant(slices);
    await this.runInTx(tx, async (q) => {
      for (const slice of sorted) {
        await q.query(
          `UPDATE msi_stock_slots
           SET quantity_reserved = CASE
                 WHEN quantity_reserved - $1 < 0 THEN 0
                 ELSE quantity_reserved - $1
               END,
               updated_at = $2::timestamptz
           WHERE warehouse_id = $3 AND variant_id = $4`,
          [slice.quantityAllocated, nowIso, slice.warehouseId, slice.variantId]
        );
      }
      await q.query(
        `UPDATE msi_stock_reservations
         SET status = 'RELEASED'
         WHERE holder_id = $1 AND status = 'ACTIVE'`,
        [holderId]
      );
    });
  }

  async listReservations(
    statusFilter?: StockReservationStatus,
    tx?: PgTxClient
  ): Promise<StockReservationRecord[]> {
    const res = statusFilter
      ? await this.runner(tx).query<PgMsiReservationRow>(
          `SELECT reservation_id, holder_id, warehouse_id, variant_id, line_id,
                  quantity, status, ttl_seconds, expires_at, created_at
           FROM msi_stock_reservations
           WHERE status = $1
           ORDER BY expires_at ASC`,
          [statusFilter]
        )
      : await this.runner(tx).query<PgMsiReservationRow>(
          `SELECT reservation_id, holder_id, warehouse_id, variant_id, line_id,
                  quantity, status, ttl_seconds, expires_at, created_at
           FROM msi_stock_reservations
           ORDER BY expires_at ASC`
        );
    return res.rows.map((r) => this.hydrateReservation(r));
  }

  async reapExpiredReservations(
    nowMs = Date.now(),
    options?: { readonly limit?: number },
    tx?: PgTxClient
  ): Promise<ReapReservationsResult> {
    const t0 = process.hrtime.bigint();
    const reapedAtIso = new Date(nowMs).toISOString();
    const limit = options?.limit ?? 500;

    const result = await this.runInTx(tx, async (q) => {
      const candidates = await q.query<{
        reservation_id: string;
        holder_id: string;
        warehouse_id: string;
        variant_id: string;
        quantity: string;
        expires_at: string;
      }>(
        `SELECT reservation_id, holder_id, warehouse_id, variant_id, quantity, expires_at
         FROM msi_stock_reservations
         WHERE status = 'ACTIVE' AND expires_at <= $1::timestamptz
         ORDER BY expires_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [reapedAtIso, limit]
      );

      if (candidates.rows.length === 0) {
        return {
          reapedAtIso,
          reapedReservationCount: 0,
          totalUnitsReleased: 0,
          expiredHolderIds: [] as string[],
          entries: [] as ReapedReservationEntry[],
        };
      }

      const entries: ReapedReservationEntry[] = [];
      const expiredHolders = new Set<string>();
      const releaseBySlot = new Map<
        string,
        { warehouseId: string; variantId: string; qty: number }
      >();
      let totalUnitsReleased = 0;

      for (const row of candidates.rows) {
        const mark = await q.query<{ reservation_id: string }>(
          `UPDATE msi_stock_reservations
           SET status = 'EXPIRED'
           WHERE reservation_id = $1 AND status = 'ACTIVE'
           RETURNING reservation_id`,
          [row.reservation_id]
        );
        if (mark.rows.length !== 1) continue;

        const qty = Number(row.quantity);
        const slotKey = `${row.warehouse_id}\u0000${row.variant_id}`;
        const existingAgg = releaseBySlot.get(slotKey);
        if (existingAgg) {
          existingAgg.qty += qty;
        } else {
          releaseBySlot.set(slotKey, {
            warehouseId: row.warehouse_id,
            variantId: row.variant_id,
            qty,
          });
        }

        totalUnitsReleased += qty;
        expiredHolders.add(row.holder_id);
        entries.push({
          reservationId: row.reservation_id,
          holderId: row.holder_id,
          warehouseId: row.warehouse_id,
          variantId: row.variant_id,
          quantityReleased: qty,
          expiredAt: normalizeIsoTimestamp(row.expires_at),
        });
      }

      const sortedSlots = sortByWarehouseVariant([...releaseBySlot.values()]);
      for (const agg of sortedSlots) {
        await q.query(
          `SELECT warehouse_id, variant_id
           FROM msi_stock_slots
           WHERE warehouse_id = $1 AND variant_id = $2
           FOR UPDATE`,
          [agg.warehouseId, agg.variantId]
        );
        await q.query(
          `UPDATE msi_stock_slots
           SET quantity_reserved = CASE
                 WHEN quantity_reserved - $1 < 0 THEN 0
                 ELSE quantity_reserved - $1
               END,
               updated_at = $2::timestamptz
           WHERE warehouse_id = $3 AND variant_id = $4`,
          [agg.qty, reapedAtIso, agg.warehouseId, agg.variantId]
        );
      }

      return {
        reapedAtIso,
        reapedReservationCount: entries.length,
        totalUnitsReleased,
        expiredHolderIds: Array.from(expiredHolders),
        entries,
      };
    });

    const latencyUs =
      Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 100) / 100;
    return {
      ...result,
      latencyUs,
    };
  }
}
