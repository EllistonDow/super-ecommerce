/**
 * Shared types for `@super-ecommerce/admin` Multi-Route Merchant Backoffice & Engineering Lab.
 */

import type {
  AdminPrincipal,
  AdminRbacAuditEntry,
  AdminRoleRecord,
  B2bBuyerMemberRecord,
  B2bCompanyRecord,
  B2bCostCenterRecord,
  B2bPurchaseOrderRecord,
  CustomerRecord,
  InboundWebhookAuditRecord,
  OrderRecord,
  OrderReturnRecord,
  OutboxEventRecord,
  OutboxQueueStats,
  ReservationReaperAuditEntry,
  SeededAdminAccount,
  StockReservationRecord,
  WarehouseStockState,
} from "@super-ecommerce/core";
import type { KernelBenchmarkSuiteReport } from "@super-ecommerce/kernel";
import type {
  ConfigDeploymentAuditEntry,
  ConfigDiffPlan,
} from "@super-ecommerce/configurator";
import type { PersistedWorkflowRunSummary } from "@super-ecommerce/workflow";
import type { WasmSandboxStressReport } from "@super-ecommerce/plugin-sdk";
import type {
  McpDiagnosticInvocationLog,
  McpToolDescriptor,
} from "@super-ecommerce/mcp-server";
import type {
  AppleContainerPgStatus,
  CatalogChannelProjectionRecord,
  ChannelRecord,
  DynamicAttributesMap,
  HybridSearchReport,
  PgConfiguratorMirrorSnapshot,
  PgForUpdateStressReport,
  PgOutboxMirrorSnapshot,
  PgWorkflowMirrorSnapshot,
  SaleorLiveProjectionReport,
} from "@super-ecommerce/db";

export const GUEST_ADMIN_PRINCIPAL: AdminPrincipal = {
  userId: "guest_anon",
  email: "guest@anonymous",
  displayName: "Unauthenticated Guest",
  role: "FINANCE_AUDITOR",
  permissions: [],
};

export type AdminRouteId =
  | "overview"
  | "orders"
  | "order_detail"
  | "catalog"
  | "discounts"
  | "inventory"
  | "b2b"
  | "configurator"
  | "settings"
  | "lab";

export interface AdminTelemetryEventView {
  readonly eventId: string;
  readonly channel:
    | "CHECKOUT"
    | "RMA"
    | "B2B"
    | "OUTBOX"
    | "REAPER"
    | "CONFIGURATOR"
    | "CATALOG"
    | "DISCOUNTS"
    | "INVENTORY"
    | "RBAC"
    | "SYSTEM";
  readonly summary: string;
  readonly severity: "OK" | "WARN" | "INFO";
  readonly timestampIso: string;
  readonly detail?: string;
}

export interface SagaAuditMetricsView {
  readonly customerId: string;
  readonly storeCreditBalanceFormatted: string;
  readonly storeCreditDeductCount: number;
  readonly storeCreditRestoredCount: number;
  readonly lastStoreCreditEvent: string;
  readonly paymentCapturedCount: number;
  readonly paymentDeclinedAttemptsCount: number;
  readonly paymentVoidedCount: number;
  readonly lastGatewayEvent: string;
}

export interface AdminVoucherRuleView {
  readonly code: string;
  readonly discountId: string;
  readonly name: string;
  readonly kind: "ORDER_VOUCHER" | "ORDER_PROMOTION" | "MANUAL_ORDER";
  readonly valueType: "FIXED" | "PERCENTAGE";
  readonly valueAmountCents: string;
  readonly valueBps: number;
  readonly isActive: boolean;
  readonly usageCount: number;
  readonly description: string;
}

export interface AdminCatalogVariantView {
  readonly variantId: string;
  readonly sku: string;
  readonly name: string;
  readonly productId: string;
  readonly productSlug: string;
  readonly productName: string;
  readonly priceAmountCents: string;
  readonly compareAtAmountCents?: string;
  readonly isPublished: boolean;
  readonly availableQuantity: number;
  readonly attributes: DynamicAttributesMap;
}

export interface AdminNavBadgeCounts {
  readonly ordersCount: number;
  readonly pendingB2bPosCount: number;
  readonly outboxAttentionCount: number;
  readonly catalogProductsCount: number;
  readonly activeVouchersCount: number;
  readonly configChangesCount: number;
}

export interface OrdersPaginationInfo {
  readonly limit: number;
  readonly hasMore: boolean;
  readonly hasPrev: boolean;
  readonly nextCursor: string | null;
  readonly prevCursor: string | null;
  readonly totalMatchingCount: number;
}

export interface AdminDashboardRenderInput {
  readonly activeRoute?: AdminRouteId;
  readonly activeChannelSlug?: string;
  readonly channels?: readonly ChannelRecord[];
  readonly catalogProjections?: readonly CatalogChannelProjectionRecord[];
  readonly catalogVariants?: readonly AdminCatalogVariantView[];
  readonly catalogBanner?: string;
  readonly vouchers?: readonly AdminVoucherRuleView[];
  readonly discountsBanner?: string;
  readonly inventoryBanner?: string;
  readonly selectedOrder?: OrderRecord;
  readonly selectedOrderReturns?: readonly OrderReturnRecord[];
  readonly warehousePriorityById?: Readonly<Record<string, number>>;
  readonly ordersFilterQuery?: string;
  readonly ordersFilterStatus?: string;
  readonly ordersPagination?: OrdersPaginationInfo;
  readonly activePrincipal?: AdminPrincipal;
  readonly rbacAccounts?: readonly SeededAdminAccount[];
  readonly rbacAuditLogs?: readonly AdminRbacAuditEntry[];
  readonly rbacBanner?: string;
  readonly customers?: readonly CustomerRecord[];
  readonly dynamicRoles?: readonly AdminRoleRecord[];
  readonly stockSlots: readonly WarehouseStockState[];
  readonly orders: readonly OrderRecord[];
  readonly rmaReturns?: readonly OrderReturnRecord[];
  readonly rmaSimulationSummary?: string;
  readonly b2bCompanies?: readonly B2bCompanyRecord[];
  readonly b2bCostCenters?: readonly B2bCostCenterRecord[];
  readonly b2bBuyers?: readonly B2bBuyerMemberRecord[];
  readonly b2bPurchaseOrders?: readonly B2bPurchaseOrderRecord[];
  readonly b2bSimulationSummary?: string;
  readonly hybridSearchReport?: HybridSearchReport;
  readonly stockReservations?: readonly StockReservationRecord[];
  readonly reaperAuditHistory?: readonly ReservationReaperAuditEntry[];
  readonly phase7Banner?: string;
  readonly workflowRuns?: readonly PersistedWorkflowRunSummary[];
  readonly pgWorkflowMirror?: PgWorkflowMirrorSnapshot;
  readonly sagaSimulationSummary?: string;
  readonly sagaAuditMetrics?: SagaAuditMetricsView;
  readonly pendingOutboxEvents: readonly OutboxEventRecord[];
  readonly allOutboxEvents?: readonly OutboxEventRecord[];
  readonly outboxStats?: OutboxQueueStats;
  readonly pgOutboxMirror?: PgOutboxMirrorSnapshot;
  readonly outboxFaultSummary?: string;
  readonly configDiffPlan: ConfigDiffPlan;
  readonly configuratorRevision?: number;
  readonly configuratorBanner?: string;
  readonly configuratorAuditHistory?: readonly ConfigDeploymentAuditEntry[];
  readonly desiredConfigYaml?: string;
  readonly desiredConfigJson?: string;
  readonly telemetryEvents?: readonly AdminTelemetryEventView[];
  readonly pgConfiguratorMirror?: PgConfiguratorMirrorSnapshot;
  readonly mcpToolsCount: number;
  readonly mcpTools?: readonly McpToolDescriptor[];
  readonly mcpInvocationLogs?: readonly McpDiagnosticInvocationLog[];
  readonly webhookEvents?: readonly InboundWebhookAuditRecord[];
  readonly benchmarkReport?: KernelBenchmarkSuiteReport;
  readonly pgContainerStatus?: AppleContainerPgStatus;
  readonly saleorLiveReport?: SaleorLiveProjectionReport;
  readonly pgStressReport?: PgForUpdateStressReport;
  readonly wasmSandboxReport?: WasmSandboxStressReport;
  readonly gatewayStressReport?: {
    readonly totalRequests: number;
    readonly totalWallTimeMs: number;
    readonly inProcessOrpcReqPerSec: number;
    readonly httpRpcReqPerSec: number;
    readonly httpGraphqlReqPerSec: number;
    readonly orpcVsGraphqlSpeedup: number;
    readonly httpRpcVsGraphqlSpeedup: number;
    readonly dosAttacksBlockedCount: number;
    readonly latestBanner: string;
    readonly tiers: readonly {
      readonly tierId: string;
      readonly protocol: string;
      readonly endpoint: string;
      readonly requestsCount: number;
      readonly wallTimeMs: number;
      readonly reqPerSec: number;
      readonly p50LatencyUs: number;
      readonly p99LatencyUs: number;
      readonly payloadBytesAvg: number;
      readonly verificationSummary: string;
    }[];
  };
}
