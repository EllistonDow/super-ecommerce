/**
 * Strongly-Typed Headless Commerce RPC & MCP Client (`@super-ecommerce/admin-spa`).
 *
 * Talks to `/rpc/*`, `/mcp`, and `/healthz` with zero floating-point money conversions:
 * all monetary wire fields remain stringified `MinorUnits` (`"28000"`) and are parsed
 * via `BigInt` in `src/lib/money.ts`.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HealthProbeDto {
  readonly status: string;
  readonly version: string;
  readonly engine: string;
  readonly database: string;
  readonly pgVersion: string | null;
  readonly protocols: readonly string[];
  readonly timestamp: string;
}

export interface LedgerAccountBalanceDto {
  readonly accountCode: string;
  readonly normalBalance: "DEBIT" | "CREDIT";
  readonly debitTotal: string;
  readonly creditTotal: string;
  readonly netBalance: string;
}

export interface TrialBalanceDto {
  readonly currencyCode: string;
  readonly accounts: readonly LedgerAccountBalanceDto[];
  readonly grandTotalDebits: string;
  readonly grandTotalCredits: string;
  readonly isBalanced: boolean;
}

export interface SkuRevenueAnalyticsDto {
  readonly variantId: string;
  readonly channelSlug: string;
  readonly currencyCode: string;
  readonly orderCount: number;
  readonly unitsSold: number;
  readonly totalNetAmount: string;
  readonly totalTaxAmount: string;
  readonly totalDiscountAmount: string;
  readonly totalGrossAmount: string;
}

export interface OrderLineDto {
  readonly lineId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly isGift?: boolean;
  readonly effectiveBaseUnitPrice: string;
  readonly totalNetAmount: string;
  readonly totalTaxAmount: string;
  readonly totalGrossAmount: string;
}

export interface OrderSummaryDto {
  readonly orderId: string;
  readonly checkoutId: string;
  readonly channelSlug: string;
  readonly customerId?: string;
  readonly currencyCode: string;
  readonly paymentStatus: string;
  readonly fulfillmentStatus: string;
  readonly totalGrossAmount: string;
  readonly createdAt: string;
  readonly pricing?: {
    readonly currencyCode: string;
    readonly shippingNetAmount: string;
    readonly shippingGrossAmount: string;
    readonly totalNetAmount: string;
    readonly totalTaxAmount: string;
    readonly totalGrossAmount: string;
    readonly lines: readonly OrderLineDto[];
  };
}

export interface OrdersKeysetPageDto {
  readonly items: readonly OrderSummaryDto[];
  readonly nextCursor: string | null;
  readonly prevCursor: string | null;
  readonly hasMore: boolean;
}

interface RawHydratedOrderWire {
  readonly order?: {
    readonly orderId: string;
    readonly checkoutId: string;
    readonly channelSlug: string;
    readonly customerId?: string;
    readonly currencyCode: string;
    readonly paymentStatus?: string;
    readonly fulfillmentStatus?: string;
    readonly pricing: NonNullable<OrderSummaryDto["pricing"]>;
    readonly createdAt: string;
  };
  readonly orderId?: string;
  readonly checkoutId?: string;
  readonly channelSlug?: string;
  readonly customerId?: string;
  readonly currencyCode?: string;
  readonly paymentStatus?: string;
  readonly fulfillmentStatus?: string;
  readonly totalGrossAmount?: string;
  readonly pricing?: OrderSummaryDto["pricing"];
  readonly createdAt?: string;
}

function mapWireOrderToSummary(raw: RawHydratedOrderWire): OrderSummaryDto {
  if (raw.order) {
    return {
      orderId: raw.order.orderId,
      checkoutId: raw.order.checkoutId,
      channelSlug: raw.order.channelSlug,
      customerId: raw.order.customerId,
      currencyCode: raw.order.currencyCode,
      paymentStatus: raw.order.paymentStatus ?? "CAPTURED",
      fulfillmentStatus: raw.fulfillmentStatus ?? raw.order.fulfillmentStatus ?? "UNFULFILLED",
      totalGrossAmount: raw.order.pricing.totalGrossAmount,
      createdAt: raw.order.createdAt,
      pricing: raw.order.pricing,
    };
  }
  return {
    orderId: raw.orderId ?? "",
    checkoutId: raw.checkoutId ?? "",
    channelSlug: raw.channelSlug ?? "us-retail",
    customerId: raw.customerId,
    currencyCode: raw.currencyCode ?? "USD",
    paymentStatus: raw.paymentStatus ?? "CAPTURED",
    fulfillmentStatus: raw.fulfillmentStatus ?? "UNFULFILLED",
    totalGrossAmount: raw.totalGrossAmount ?? raw.pricing?.totalGrossAmount ?? "0",
    createdAt: raw.createdAt ?? "",
    pricing: raw.pricing,
  };
}

export interface OrderEditDto {
  readonly editId: string;
  readonly orderId: string;
  readonly editedBy: string;
  readonly reason: string;
  readonly previousGrossAmount: string;
  readonly revisedGrossAmount: string;
  readonly deltaGrossAmount: string;
  readonly settlementKind: "NO_FINANCIAL_DELTA" | "INCREMENTAL_CAPTURE" | "PARTIAL_REFUND";
  readonly createdAt: string;
}

export interface HydratedCartDto {
  readonly cartId: string;
  readonly channelSlug: string;
  readonly currencyCode: string;
  readonly customerId?: string;
  readonly guestToken?: string;
  readonly status: string;
  readonly voucherCode?: string;
  readonly lines: readonly {
    readonly lineId: string;
    readonly variantId: string;
    readonly sku: string;
    readonly title: string;
    readonly quantity: number;
    readonly baseUnitPrice: string;
  }[];
  readonly pricing: {
    readonly totalGrossAmount: string;
    readonly totalTaxAmount: string;
  };
  readonly updatedAt: string;
}

export interface PaymentIntentDto {
  readonly paymentIntentId: string;
  readonly checkoutId: string;
  readonly orderId?: string;
  readonly customerId?: string;
  readonly channelSlug: string;
  readonly currencyCode: string;
  readonly amount: string;
  readonly amountCapturable: string;
  readonly amountReceived: string;
  readonly amountRefunded: string;
  readonly captureMethod: "automatic" | "manual";
  readonly status: string;
  readonly providerMode: "STRIPE_LIVE_API" | "LOCAL_SIMULATOR";
  readonly nextActionRedirectUrl?: string;
  readonly updatedAt: string;
}

export interface InventorySlotDto {
  readonly warehouseId: string;
  readonly variantId: string;
  readonly priorityRank: number;
  readonly quantityOnHand: number;
  readonly quantityReserved: number;
  readonly quantityAllocated: number;
}

export interface OutboxEventDto {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly status: string;
  readonly attempts: number;
  readonly createdAt: string;
}

export interface McpToolDescriptorDto {
  readonly name: string;
  readonly description: string;
}

export interface McpDiagnosticInvocationLogDto {
  readonly invocationId: string;
  readonly toolName: string;
  readonly persona: string;
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

export interface PimMaterializedCatalogProjectionDto {
  readonly productSlug: string;
  readonly productName: string;
  readonly channelSlug: string;
  readonly sku: string;
  readonly minEffectivePrice: string;
  readonly isInStock: boolean;
  readonly totalAvailableQty: number;
  readonly mediaUrl: string;
  readonly mergedAttributes: Record<string, unknown>;
}

export interface PimIngestionAuditEntryDto {
  readonly syncId: string;
  readonly systemSource: string;
  readonly exportId: string;
  readonly status: "APPLIED" | "PREFLIGHT_BLOCKED" | "ZERO_DIFF_NOOP";
  readonly durationUs: number;
  readonly familiesCount: number;
  readonly productsCount: number;
  readonly diffPlan?: {
    readonly totalChanges: number;
    readonly entries: readonly {
      readonly stage: string;
      readonly operation: string;
      readonly slug: string;
      readonly summary: string;
    }[];
  };
  readonly issues: readonly string[];
  readonly summary: string;
  readonly materializedProjectionsCount: number;
  readonly executedAtIso: string;
}

export interface PimSyncStatusDto {
  readonly systemSource: string;
  readonly lastSyncIso: string | null;
  readonly materializedProjectionsCount: number;
  readonly auditHistory: readonly PimIngestionAuditEntryDto[];
  readonly materializedProjections: readonly PimMaterializedCatalogProjectionDto[];
}

export function createAdminRpcClient(options?: {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
}) {
  const baseUrl = (options?.baseUrl ?? "").replace(/\/$/, "");
  const fetchFn: FetchLike = options?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  async function callRpc<TData>(procedure: string, payload: Record<string, unknown> = {}): Promise<TData> {
    const res = await fetchFn(`${baseUrl}/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { ok: boolean; data?: TData; error?: string };
    if (!res.ok || !body.ok) {
      throw new Error(body.error ?? `RPC ${procedure} failed with HTTP ${res.status}`);
    }
    return body.data as TData;
  }

  return {
    getHealth: async (): Promise<HealthProbeDto> => {
      const res = await fetchFn(`${baseUrl}/healthz`);
      if (!res.ok) throw new Error(`Health check failed: HTTP ${res.status}`);
      return (await res.json()) as HealthProbeDto;
    },
    ledger: {
      getTrialBalance: (currencyCode = "USD") =>
        callRpc<TrialBalanceDto>("ledger.getTrialBalance", { currencyCode }),
    },
    orders: {
      list: async (params: {
        limit?: number;
        cursor?: string;
        direction?: "next" | "prev";
        q?: string;
        paymentStatus?: string;
      } = {}): Promise<OrdersKeysetPageDto> => {
        const rawPage = await callRpc<{
          items: readonly RawHydratedOrderWire[];
          nextCursor: string | null;
          prevCursor: string | null;
          hasMore: boolean;
        }>("orders.list", params);
        return {
          ...rawPage,
          items: rawPage.items.map(mapWireOrderToSummary),
        };
      },
      get: async (orderId: string): Promise<OrderSummaryDto> => {
        const raw = await callRpc<RawHydratedOrderWire>("orders.get", { orderId });
        return mapWireOrderToSummary(raw);
      },
      analyticsBySku: (channelSlug?: string) =>
        callRpc<readonly SkuRevenueAnalyticsDto[]>(
          "orders.analyticsBySku",
          channelSlug ? { channelSlug } : {}
        ),
      listEdits: (orderId?: string) =>
        callRpc<readonly OrderEditDto[]>("orders.listEdits", orderId ? { orderId } : {}),
      edit: (params: {
        idempotencyKey: string;
        input: {
          editId: string;
          orderId: string;
          editedBy: string;
          reason: string;
          paymentTokenForIncrementalCapture?: string;
          revisedShippingBaseAmount?: string;
          lineMutations: readonly {
            lineId: string;
            variantId?: string;
            quantity: number;
            baseUnitPrice?: string;
            taxRateBps?: number;
          }[];
        };
      }) =>
        callRpc<{ status: string; output?: OrderEditDto; error?: string }>("orders.edit", params),
    },
    rma: {
      processReturn: (params: {
        idempotencyKey: string;
        input: {
          rmaId: string;
          orderId: string;
          reason?: string;
          linesToReturn: readonly {
            lineId: string;
            quantity: number;
            condition?: "RESELLABLE" | "DAMAGED_QUARANTINE";
          }[];
        };
      }) => callRpc<{ status: string; output?: unknown }>("rma.processReturn", params),
    },
    carts: {
      listRecent: (limit = 25) => callRpc<readonly HydratedCartDto[]>("carts.listRecent", { limit }),
    },
    payments: {
      listRecent: (limit = 25) =>
        callRpc<readonly PaymentIntentDto[]>("payments.listRecent", { limit }),
      complete3ds: (paymentIntentId: string) =>
        callRpc<PaymentIntentDto>("payments.complete3ds", { paymentIntentId }),
      captureIntent: (paymentIntentId: string) =>
        callRpc<PaymentIntentDto>("payments.captureIntent", { paymentIntentId }),
    },
    inventory: {
      listSlots: (limit = 50) =>
        callRpc<readonly InventorySlotDto[]>("inventory.listSlots", { limit }),
      reapExpired: () =>
        callRpc<{
          stockReap: { reapedReservationCount: number; totalUnitsReleased: number };
        }>("inventory.reapExpiredReservations", {}),
    },
    outbox: {
      listPending: (limit = 30) =>
        callRpc<readonly OutboxEventDto[]>("outbox.listPending", { limit }),
    },
    workflow: {
      recoverOrphans: () =>
        callRpc<{ scannedCount: number; recoveredCount: number }>("workflow.recoverOrphans", {}),
    },
    mcp: {
      listToolsJsonRpc: async () => {
        const res = await fetchFn(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        const body = (await res.json()) as { result?: { tools: McpToolDescriptorDto[] } };
        return body.result?.tools ?? [];
      },
      callToolJsonRpc: async (name: string, args: Record<string, unknown>) => {
        const res = await fetchFn(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });
        return (await res.json()) as Record<string, unknown>;
      },
      listLogs: (limit = 25) =>
        callRpc<readonly McpDiagnosticInvocationLogDto[]>("mcp.listLogs", { limit }),
    },
    pim: {
      getSyncStatus: () => callRpc<PimSyncStatusDto>("pim.getSyncStatus"),
      syncSample: (simulateFault = false) =>
        callRpc<{
          ok: boolean;
          audit: PimIngestionAuditEntryDto;
          materializedProjections: readonly PimMaterializedCatalogProjectionDto[];
        }>("pim.sync", { simulateFault }),
      preview: () =>
        callRpc<{
          ok: boolean;
          issues: readonly string[];
          plan?: { totalChanges: number };
          durationUs: number;
        }>("pim.preview"),
      listLogs: (limit = 10) =>
        callRpc<readonly PimIngestionAuditEntryDto[]>("pim.listLogs", { limit }),
      listProjections: () =>
        callRpc<readonly PimMaterializedCatalogProjectionDto[]>("pim.listProjections"),
    },
  };
}

export type AdminRpcClient = ReturnType<typeof createAdminRpcClient>;
