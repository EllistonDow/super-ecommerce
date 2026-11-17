/**
 * `@super-ecommerce/mcp-server`
 *
 * Built-in Model Context Protocol (MCP) Server for Merchant Copilot & Agentic Commerce
 * (Architectural Invariant #5).
 *
 * Exposes strongly-typed tools callable by Claude / MCP clients over JSON-RPC 2.0:
 * 1. `diagnose_price_waterfall`          — Explains Pass 1, Pass 2 (Precedence + Hare-Niemeyer + Gift exclusion), and Pass 3 tax waterfall.
 * 2. `diagnose_stock_availability_doctor`— Diagnoses purchasable vs shippable MSI stock across DIRECT_CHANNEL_WAREHOUSES vs LEGACY_SHIPPING_ZONE_WAREHOUSES.
 * 3. `search_catalog_hybrid`             — Queries 0-JOIN CQRS `CatalogChannelProjectionRecord` with JSONB facets.
 * 4. `preview_store_config_diff`         — Runs pre-flight validation and topological diff for Commerce-as-Code.
 */

import {
  calculateCart,
  type CartCalculationInput,
} from "@super-ecommerce/kernel";
import {
  HybridCatalogSearchEngine,
  type CatalogChannelProjectionRecord,
  type HybridSearchReport,
  type StockAvailabilityMode,
} from "@super-ecommerce/db";
import {
  diffStoreConfig,
  type StoreConfigDocument,
} from "@super-ecommerce/configurator";

export interface McpToolDescriptor {
  readonly name:
    | "diagnose_price_waterfall"
    | "diagnose_stock_availability_doctor"
    | "search_catalog_hybrid"
    | "preview_store_config_diff";
  readonly persona: "MERCHANT_COPILOT" | "AGENTIC_STOREFRONT";
  readonly inputSchemaSummary: string;
  readonly description: string;
}

export interface CatalogHybridSearchQuery {
  readonly channelSlug: string;
  readonly queryText?: string;
  readonly inStockOnly?: boolean;
  readonly maxPriceAmount?: bigint;
  readonly attributeFilters?: Readonly<Record<string, string | number | boolean>>;
  readonly rrfK?: number;
  readonly limit?: number;
  readonly minVectorSimilarity?: number;
}

export interface MsiWarehouseDiagnosticSlot {
  readonly warehouseId: string;
  readonly priorityRank: number;
  readonly linkedToChannel: boolean;
  readonly supportsShippingZone: boolean;
  readonly variantId: string;
  readonly quantityOnHand: number;
  readonly quantityReserved: number;
  readonly quantityAllocated: number;
}

export interface StockAvailabilityDoctorInput {
  readonly variantId: string;
  readonly requestedQuantity: number;
  readonly availabilityMode: StockAvailabilityMode;
  readonly slots: readonly MsiWarehouseDiagnosticSlot[];
}

export interface StockAvailabilityDoctorReport {
  readonly variantId: string;
  readonly requestedQuantity: number;
  readonly availabilityMode: StockAvailabilityMode;
  readonly purchasableUnitsDirectMode: number;
  readonly shippableUnitsLegacyZoneMode: number;
  readonly effectiveEligibleUnits: number;
  readonly isFulfillable: boolean;
  readonly modeDiscrepancyDetected: boolean;
  readonly doctorDiagnosis: string;
  readonly warehouseAudits: readonly {
    readonly warehouseId: string;
    readonly priorityRank: number;
    readonly availableUnits: number;
    readonly eligibleInDirectMode: boolean;
    readonly eligibleInLegacyZoneMode: boolean;
    readonly statusReason: string;
  }[];
}

export interface McpDiagnosticInvocationLog {
  readonly invocationId: string;
  readonly toolName: McpToolDescriptor["name"];
  readonly persona: McpToolDescriptor["persona"];
  readonly latencyUs: number;
  readonly status: "SUCCESS" | "VALIDATION_BLOCKED";
  readonly headlineFinding: string;
  readonly structuredDetails: readonly {
    readonly key: string;
    readonly stepOrTarget: string;
    readonly pass1OrInput: string;
    readonly pass2OrRule: string;
    readonly finalOutcome: string;
    readonly severity: "OK" | "WARN" | "INFO";
  }[];
  readonly executedAtIso: string;
}

export class SuperCommerceMcpServer {
  private readonly projections: CatalogChannelProjectionRecord[];
  private readonly hybridSearchEngine: HybridCatalogSearchEngine;
  private readonly invocationLogs: McpDiagnosticInvocationLog[] = [];
  private invocationSeq = 0;

  constructor(initialProjections: readonly CatalogChannelProjectionRecord[] = []) {
    this.projections = [...initialProjections];
    this.hybridSearchEngine = new HybridCatalogSearchEngine(this.projections);
  }

  setProjections(nextProjections: readonly CatalogChannelProjectionRecord[]): void {
    this.projections.length = 0;
    this.projections.push(...nextProjections);
    this.hybridSearchEngine.reindex(this.projections);
  }

  listTools(): readonly McpToolDescriptor[] {
    return [
      {
        name: "diagnose_price_waterfall",
        persona: "MERCHANT_COPILOT",
        inputSchemaSummary: "{ currencyCode, taxMode, lines[], candidateOrderDiscounts[] }",
        description:
          "Executes the deterministic two-pass pricing kernel and returns per-line discount attribution, suppressed lower-precedence candidates, Hare-Niemeyer penny remainders, and gift-line exclusion.",
      },
      {
        name: "diagnose_stock_availability_doctor",
        persona: "MERCHANT_COPILOT",
        inputSchemaSummary: "{ variantId, requestedQuantity, availabilityMode, slots[] }",
        description:
          "Audits MSI warehouse stock across DIRECT_CHANNEL_WAREHOUSES (3.23+) vs LEGACY_SHIPPING_ZONE_WAREHOUSES, pinpointing unlinked shipping zones and purchasability vs shippability gaps.",
      },
      {
        name: "search_catalog_hybrid",
        persona: "AGENTIC_STOREFRONT",
        inputSchemaSummary: "{ channelSlug, queryText?, inStockOnly?, maxPriceAmount?, attributeFilters?, rrfK?, limit? }",
        description:
          "Searches zero-JOIN CQRS catalog channel projections using Okapi BM25 lexical scoring + 64D semantic vector cosine similarity fused via Reciprocal Rank Fusion (RRF, k=60) and JSONB facets.",
      },
      {
        name: "preview_store_config_diff",
        persona: "MERCHANT_COPILOT",
        inputSchemaSummary: "{ remoteState: StoreConfigDocument, desiredConfig: StoreConfigDocument }",
        description:
          "Validates and diffs a desired Commerce-as-Code store configuration against current state in topological order (warehouses -> channels -> productTypes -> products).",
      },
    ];
  }

  listInvocationLogs(limit = 15): readonly McpDiagnosticInvocationLog[] {
    return this.invocationLogs.slice(0, limit);
  }

  /**
   * Tool 1: `diagnose_price_waterfall`
   */
  diagnosePriceWaterfall(input: CartCalculationInput) {
    const t0 = process.hrtime.bigint();
    const result = calculateCart(input);
    const elapsedUs = Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 100) / 100;

    const appliedIds = new Set(result.appliedOrderDiscounts.map((d) => d.discountId));
    const winner = result.appliedOrderDiscounts[0];
    const suppressedCandidates = (input.candidateOrderDiscounts ?? [])
      .filter((c) => !appliedIds.has(c.discountId))
      .map((c) => ({
        discountId: c.discountId,
        name: c.name,
        kind: c.kind,
        suppressedBy: winner ? `${winner.kind} (${winner.name})` : "PRECEDENCE_RULE",
      }));

    const waterfallLines = result.lines.map((line) => ({
      lineId: line.lineId,
      variantId: line.variantId,
      quantity: line.quantity,
      isGift: line.isGift,
      pass1: {
        effectiveBaseUnitPrice: line.effectiveBaseUnitPrice.toString(),
        undiscountedSubtotal: line.undiscountedLineSubtotal.toString(),
        lineLevelDiscountAmount: line.lineLevelDiscountAmount.toString(),
        subtotalAfterLineDiscount: line.subtotalAfterLineDiscount.toString(),
      },
      pass2: {
        allocatedOrderDiscountAmount: line.allocatedOrderDiscountAmount.toString(),
        attributions: line.discountAttributions.map((a) => ({
          discountId: a.discountId,
          name: a.name,
          scope: a.isOrderLevel ? "ORDER_LEVEL" : "LINE_LEVEL",
          amount: a.amount.toString(),
        })),
      },
      pass3: {
        totalNetAmount: line.totalNetAmount.toString(),
        totalTaxAmount: line.totalTaxAmount.toString(),
        totalGrossAmount: line.totalGrossAmount.toString(),
      },
    }));

    const fmt = (centsStr: string) =>
      `${result.currencyCode} ${(Number(centsStr) / 100).toFixed(2)}`;

    const details: McpDiagnosticInvocationLog["structuredDetails"] = [
      ...waterfallLines.map((l) => ({
        key: `LINE:${l.lineId}`,
        stepOrTarget: `${l.variantId} x${l.quantity}${l.isGift ? " (FREE_GIFT)" : ""}`,
        pass1OrInput: l.isGift
          ? "Base $0.00 (isGift=true excluded from Pass 2 weight)"
          : `Subtotal ${fmt(l.pass1.undiscountedSubtotal)} - LinePromo ${fmt(l.pass1.lineLevelDiscountAmount)} = ${fmt(l.pass1.subtotalAfterLineDiscount)}`,
        pass2OrRule: l.isGift
          ? "Hare-Niemeyer Share: 0 cents (Zero Weight)"
          : `Hare-Niemeyer Share: -${fmt(l.pass2.allocatedOrderDiscountAmount)}`,
        finalOutcome: `Net ${fmt(l.pass3.totalNetAmount)} + Tax ${fmt(l.pass3.totalTaxAmount)} = Gross ${fmt(l.pass3.totalGrossAmount)}`,
        severity: (l.isGift ? "INFO" : "OK") as "OK" | "WARN" | "INFO",
      })),
      ...suppressedCandidates.map((s) => ({
        key: `SUPPRESSED:${s.discountId}`,
        stepOrTarget: `${s.name} (${s.kind})`,
        pass1OrInput: "Candidate Order-Level Discount",
        pass2OrRule: `Suppressed by ${s.suppressedBy} (Precedence: MANUAL_ORDER > ORDER_VOUCHER > ORDER_PROMOTION)`,
        finalOutcome: "0 cents applied (Non-Stacking Precedence Enforced)",
        severity: "WARN" as const,
      })),
    ];

    this.recordInvocation({
      toolName: "diagnose_price_waterfall",
      persona: "MERCHANT_COPILOT",
      latencyUs: elapsedUs,
      status: "SUCCESS",
      headlineFinding: `WATERFALL DIAGNOSED (${elapsedUs} us) // Winner: ${winner ? `${winner.name} (${winner.kind}: -${fmt(winner.totalAmount.toString())})` : "None"} | Suppressed: ${suppressedCandidates.length} lower-precedence discount(s) | Total Gross: ${fmt(result.totalGrossAmount.toString())}`,
      structuredDetails: details,
    });

    return {
      currencyCode: result.currencyCode,
      totalNetAmount: result.totalNetAmount.toString(),
      totalTaxAmount: result.totalTaxAmount.toString(),
      totalGrossAmount: result.totalGrossAmount.toString(),
      appliedOrderDiscounts: result.appliedOrderDiscounts.map((d) => ({
        discountId: d.discountId,
        name: d.name,
        kind: d.kind,
        totalAmount: d.totalAmount.toString(),
      })),
      suppressedCandidateDiscounts: suppressedCandidates,
      lines: waterfallLines,
    };
  }

  /**
   * Tool 2: `diagnose_stock_availability_doctor`
   */
  diagnoseStockAvailabilityDoctor(
    input: StockAvailabilityDoctorInput
  ): StockAvailabilityDoctorReport {
    const t0 = process.hrtime.bigint();
    const matchingSlots = input.slots
      .filter((s) => s.variantId === input.variantId)
      .sort((a, b) => a.priorityRank - b.priorityRank);

    let purchasableUnitsDirectMode = 0;
    let shippableUnitsLegacyZoneMode = 0;

    const warehouseAudits = matchingSlots.map((s) => {
      const availableUnits = Math.max(
        0,
        s.quantityOnHand - s.quantityReserved - s.quantityAllocated
      );
      const eligibleInDirectMode = s.linkedToChannel && availableUnits > 0;
      const eligibleInLegacyZoneMode =
        s.linkedToChannel && s.supportsShippingZone && availableUnits > 0;

      if (s.linkedToChannel) {
        purchasableUnitsDirectMode += availableUnits;
      }
      if (s.linkedToChannel && s.supportsShippingZone) {
        shippableUnitsLegacyZoneMode += availableUnits;
      }

      let statusReason = "ELIGIBLE_BOTH_MODES";
      if (!s.linkedToChannel) {
        statusReason = "EXCLUDED: Warehouse not linked to active Channel";
      } else if (!s.supportsShippingZone) {
        statusReason =
          "DOCTOR_WARNING: Linked to Channel (counted in 3.23+ Direct Mode) but missing ShippingZone link (excluded in Legacy Zone Mode)";
      }

      return {
        warehouseId: s.warehouseId,
        priorityRank: s.priorityRank,
        availableUnits,
        eligibleInDirectMode,
        eligibleInLegacyZoneMode,
        statusReason,
      };
    });

    const effectiveEligibleUnits =
      input.availabilityMode === "DIRECT_CHANNEL_WAREHOUSES"
        ? purchasableUnitsDirectMode
        : shippableUnitsLegacyZoneMode;
    const isFulfillable = effectiveEligibleUnits >= input.requestedQuantity;
    const modeDiscrepancyDetected =
      purchasableUnitsDirectMode !== shippableUnitsLegacyZoneMode;

    const doctorDiagnosis = modeDiscrepancyDetected
      ? `MODE DISCREPANCY DETECTED for ${input.variantId}: Direct Channel Mode sees ${purchasableUnitsDirectMode} purchasable units, whereas Legacy ShippingZone Mode sees ${shippableUnitsLegacyZoneMode} shippable units (1+ warehouse missing ShippingZone link). Under ${input.availabilityMode}, request for ${input.requestedQuantity} units is ${isFulfillable ? "FULFILLABLE" : "BLOCKED_INSUFFICIENT_SHIPPABLE_STOCK"}.`
      : `ALL WAREHOUSES ALIGNED for ${input.variantId}: ${effectiveEligibleUnits} available units across ${warehouseAudits.length} warehouse(s). Request for ${input.requestedQuantity} units is ${isFulfillable ? "FULFILLABLE" : "INSUFFICIENT_STOCK"}.`;

    const elapsedUs = Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 100) / 100;

    this.recordInvocation({
      toolName: "diagnose_stock_availability_doctor",
      persona: "MERCHANT_COPILOT",
      latencyUs: elapsedUs,
      status: "SUCCESS",
      headlineFinding: `STOCK DOCTOR (${elapsedUs} us) // ${doctorDiagnosis}`,
      structuredDetails: warehouseAudits.map((w) => ({
        key: `WH:${w.warehouseId}`,
        stepOrTarget: `${w.warehouseId} (Rank #${w.priorityRank})`,
        pass1OrInput: `Available: ${w.availableUnits} units`,
        pass2OrRule: `Direct(3.23+): ${w.eligibleInDirectMode ? "YES" : "NO"} | LegacyZone: ${w.eligibleInLegacyZoneMode ? "YES" : "NO"}`,
        finalOutcome: w.statusReason,
        severity: w.statusReason.startsWith("DOCTOR_WARNING")
          ? "WARN"
          : w.eligibleInDirectMode
          ? "OK"
          : "INFO",
      })),
    });

    return {
      variantId: input.variantId,
      requestedQuantity: input.requestedQuantity,
      availabilityMode: input.availabilityMode,
      purchasableUnitsDirectMode,
      shippableUnitsLegacyZoneMode,
      effectiveEligibleUnits,
      isFulfillable,
      modeDiscrepancyDetected,
      doctorDiagnosis,
      warehouseAudits,
    };
  }

  /**
   * Tool 3: `search_catalog_hybrid` (Detailed RRF Report: Okapi BM25 + 64D Vector Cosine)
   */
  searchCatalogHybridDetailed(query: CatalogHybridSearchQuery): HybridSearchReport {
    const report = this.hybridSearchEngine.search(query);
    const filterDesc = query.attributeFilters
      ? JSON.stringify(query.attributeFilters)
      : "{}";
    const queryLabel = report.queryText ? `"${report.queryText}"` : "* (JSONB Facets Only)";

    this.recordInvocation({
      toolName: "search_catalog_hybrid",
      persona: "AGENTIC_STOREFRONT",
      latencyUs: report.latencyUs,
      status: "SUCCESS",
      headlineFinding: `AGENTIC HYBRID RRF SEARCH (${report.latencyUs} us) // Channel: ${report.channelSlug} | Query: ${queryLabel} | BM25: ${report.bm25MatchedCount} | Vector64: ${report.vectorMatchedCount} | RRF(k=${report.rrfK}) Hits: ${report.totalReturned}/${report.candidatePoolCount} | Facets: ${filterDesc}`,
      structuredDetails: report.hits.slice(0, 6).map((hit, idx) => {
        const p = hit.projection;
        return {
          key: `RRF#${idx + 1}:${p.productSlug}`,
          stepOrTarget: `${p.productName} (${hit.matchedBy})`,
          pass1OrInput:
            hit.matchedBy === "FILTER_ONLY"
              ? `Channel: ${p.channelSlug} | Available: ${p.totalAvailableQty} units`
              : `BM25=${hit.bm25Score} (#${hit.bm25Rank ?? "N/A"}) | VecCos=${hit.vectorSimilarity} (#${hit.vectorRank ?? "N/A"})`,
          pass2OrRule:
            hit.matchedBy === "FILTER_ONLY"
              ? `JSONB Facets: ${JSON.stringify(p.mergedAttributes)}`
              : `RRF=${hit.rrfScore.toFixed(6)} (k=${report.rrfK}) | Facets: ${JSON.stringify(p.mergedAttributes)}`,
          finalOutcome: `${p.currencyCode} ${(Number(p.minEffectivePrice) / 100).toFixed(2)} | Avail: ${p.totalAvailableQty}u`,
          severity: hit.matchedBy === "VECTOR_SEMANTIC" ? ("INFO" as const) : ("OK" as const),
        };
      }),
    });

    return report;
  }

  /**
   * Tool 3: `search_catalog_hybrid` (Returns matched `CatalogChannelProjectionRecord[]` ranked by RRF)
   */
  searchCatalogHybrid(query: CatalogHybridSearchQuery): readonly CatalogChannelProjectionRecord[] {
    return this.searchCatalogHybridDetailed(query).hits.map((h) => h.projection);
  }

  /**
   * Tool 4: `preview_store_config_diff`
   */
  previewStoreConfigDiff(params: {
    remoteState: StoreConfigDocument;
    desiredConfig: StoreConfigDocument;
  }) {
    const t0 = process.hrtime.bigint();
    const plan = diffStoreConfig(params.remoteState, params.desiredConfig);
    const elapsedUs = Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 100) / 100;

    this.recordInvocation({
      toolName: "preview_store_config_diff",
      persona: "MERCHANT_COPILOT",
      latencyUs: elapsedUs,
      status: "SUCCESS",
      headlineFinding: `CONFIGURATOR TOPOLOGICAL DIFF (${elapsedUs} us) // Pre-Flight Schema & Cross-Reference Check PASSED | ${plan.totalChanges} Staged Operation(s) across 4 Stages`,
      structuredDetails: plan.entries.map((e, idx) => ({
        key: `STAGE_${idx + 1}:${e.slug}`,
        stepOrTarget: `${e.stage} :: ${e.slug}`,
        pass1OrInput: `Identity Strategy: Immutable Slug (${e.slug})`,
        pass2OrRule: `Operation: ${e.operation}`,
        finalOutcome: e.summary,
        severity: e.operation === "DELETE" ? ("WARN" as const) : ("OK" as const),
      })),
    });

    return plan;
  }

  private recordInvocation(
    entry: Omit<McpDiagnosticInvocationLog, "invocationId" | "executedAtIso">
  ): void {
    const log: McpDiagnosticInvocationLog = {
      invocationId: `mcp_call_${++this.invocationSeq}`,
      executedAtIso: new Date().toISOString(),
      ...entry,
    };
    this.invocationLogs.unshift(log);
    if (this.invocationLogs.length > 25) {
      this.invocationLogs.length = 25;
    }
  }
}
