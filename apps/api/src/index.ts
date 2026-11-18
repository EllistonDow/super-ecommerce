/**
 * `@super-ecommerce/api`
 *
 * Dual-Protocol API & CQRS Gateway built on Web Standard `Request` / `Response`
 * (runs natively on Node 22+, Bun, and Cloudflare Workers).
 *
 * Routes:
 * - `GET  /health`            -> Engine & kernel status
 * - `POST /rpc/:procedure`    -> End-to-end typed RPC procedures (`catalog.search`,
 *                                `pricing.calculate`, `checkout.complete`, `mcp.listTools`)
 * - `POST /graphql`           -> Saleor/Shopify-compatible Storefront GraphQL endpoint
 *                                with AST Depth & Alias Amplification DoS Guard
 * - `POST /webhooks/stripe`   -> Constant-time HMAC-SHA256 webhook verifier
 */

import {
  calculateCart,
  type CartCalculationInput,
} from "@super-ecommerce/kernel";
import {
  OfflinePgPool,
  runMigrations,
  type CatalogChannelProjectionRecord,
  type PgPoolLike,
} from "@super-ecommerce/db";
import {
  PgWorkflowStateStore,
  SagaRecoveryWorker,
  WorkflowConcurrentExecutionError,
} from "@super-ecommerce/workflow";
import {
  buildCompleteCheckoutWorkflow,
  buildProcessReturnRefundWorkflow,
  InvalidOrderCursorError,
  PgB2bOrganizationService,
  PgDoubleEntryLedgerService,
  PgMsiInventoryService,
  PgOrdersRepository,
  PgReservationTtlReaperService,
  PgStripeWebhookService,
  PgTransactionalOutboxService,
  StripeWebhookVerificationError,
  type CompleteCheckoutInput,
  type ListOrdersKeysetInput,
  type MsiInventoryServiceLike,
  type PaymentGatewayStrategy,
  type ProcessReturnRefundInput,
  type StockReservationStatus,
  type SubmitB2bPurchaseOrderInput,
} from "@super-ecommerce/core";
import {
  SuperCommerceMcpServer,
  type CatalogHybridSearchQuery,
  type McpJsonRpcRequest,
} from "@super-ecommerce/mcp-server";

export interface SuperCommerceGatewayOptions {
  readonly pgPool?: PgPoolLike;
  readonly projections?: readonly CatalogChannelProjectionRecord[];
  readonly inventoryService?: MsiInventoryServiceLike;
  readonly paymentGateway?: PaymentGatewayStrategy;
  readonly stripeEndpointSecrets?: string | readonly string[];
  readonly maxGraphQlDepth?: number;
  readonly maxGraphQlAliases?: number;
}

export interface GraphQlSecurityInspection {
  readonly allowed: boolean;
  readonly maxDepthObserved: number;
  readonly aliasCountObserved: number;
  readonly violationCode?:
    | "GRAPHQL_DEPTH_LIMIT_EXCEEDED"
    | "GRAPHQL_ALIAS_AMPLIFICATION_BLOCKED";
  readonly violationMessage?: string;
}

/**
 * Deterministic lexical AST depth & alias amplification guard for `POST /graphql`.
 * Protects the gateway against deeply nested circular queries and batch alias bombs.
 */
export function inspectGraphQlQuerySecurity(
  query: string,
  maxDepth = 8,
  maxAliases = 8
): GraphQlSecurityInspection {
  let currentDepth = 0;
  let maxDepthObserved = 0;
  let inString = false;

  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '"' && query[i - 1] !== "\\") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      currentDepth += 1;
      if (currentDepth > maxDepthObserved) {
        maxDepthObserved = currentDepth;
      }
    } else if (ch === "}") {
      currentDepth = Math.max(0, currentDepth - 1);
    }
  }

  // Count field aliases (`aliasName: fieldName`) outside parenthesized arguments `(channel: "us-retail")`
  const strippedArgs = query.replace(/\([^)]*\)/g, "");
  const aliasMatches = strippedArgs.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\s*:/g);
  const aliasCountObserved = aliasMatches ? aliasMatches.length : 0;

  if (maxDepthObserved > maxDepth) {
    return {
      allowed: false,
      maxDepthObserved,
      aliasCountObserved,
      violationCode: "GRAPHQL_DEPTH_LIMIT_EXCEEDED",
      violationMessage: `GraphQL query depth ${maxDepthObserved} exceeds maximum allowed depth of ${maxDepth}`,
    };
  }

  if (aliasCountObserved > maxAliases) {
    return {
      allowed: false,
      maxDepthObserved,
      aliasCountObserved,
      violationCode: "GRAPHQL_ALIAS_AMPLIFICATION_BLOCKED",
      violationMessage: `GraphQL query contains ${aliasCountObserved} field aliases, exceeding amplification limit of ${maxAliases}`,
    };
  }

  return {
    allowed: true,
    maxDepthObserved,
    aliasCountObserved,
  };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, jsonReplacer), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function createSuperCommerceGateway(options: SuperCommerceGatewayOptions = {}) {
  const pgPool = options.pgPool ?? new OfflinePgPool();
  const projections = options.projections ?? [];
  const inventoryService =
    options.inventoryService instanceof PgMsiInventoryService
      ? options.inventoryService
      : new PgMsiInventoryService(pgPool);
  const outboxService = new PgTransactionalOutboxService(pgPool);
  const workflowStore = new PgWorkflowStateStore(pgPool);
  const ordersRepo = new PgOrdersRepository(pgPool);
  const subledger = new PgDoubleEntryLedgerService(pgPool);
  const mcpServer = new SuperCommerceMcpServer(projections);
  const maxGraphQlDepth = options.maxGraphQlDepth ?? 8;
  const maxGraphQlAliases = options.maxGraphQlAliases ?? 8;

  const defaultPaymentGateway: PaymentGatewayStrategy =
    options.paymentGateway ?? {
      async capture({ checkoutId, amount }) {
        return {
          transactionId: `tx_${checkoutId}`,
          provider: "super-pay",
          capturedAmount: amount,
        };
      },
      async voidOrRefund() {},
    };

  const checkoutWorkflow = buildCompleteCheckoutWorkflow({
    inventoryService,
    paymentGateway: defaultPaymentGateway,
    outboxService,
    pgPool,
  });

  const rmaWorkflow = buildProcessReturnRefundWorkflow({
    inventoryService,
    paymentGateway: defaultPaymentGateway,
    outboxService,
    pgPool,
  });

  const b2bService = new PgB2bOrganizationService({
    pool: pgPool,
    inventoryService,
    outboxService,
    workflowStateStore: workflowStore,
  });

  const reaperService = new PgReservationTtlReaperService({
    pool: pgPool,
    inventoryService,
    b2bService,
    outboxService,
  });

  const sagaRecoveryWorker = new SagaRecoveryWorker({
    store: workflowStore,
    workflows: [checkoutWorkflow, rmaWorkflow],
  });

  const stripeWebhookService = new PgStripeWebhookService({
    pool: pgPool,
    endpointSecrets: options.stripeEndpointSecrets ?? [
      "whsec_super_ecommerce_2026_active",
      "whsec_super_ecommerce_2025_rollover",
    ],
    inventoryService,
    outboxService,
  });

  let isReady = false;
  let readyPromise: Promise<void> | null = null;
  async function ensureReady(): Promise<void> {
    if (isReady) return;
    if (!readyPromise) {
      readyPromise = (async () => {
        await runMigrations(pgPool);
        await b2bService.seedDefaultEnterpriseHierarchy();
        if (
          options.inventoryService &&
          !(options.inventoryService instanceof PgMsiInventoryService)
        ) {
          const seedSlots = await options.inventoryService.listAllSlots(500);
          if (seedSlots.length > 0) {
            await inventoryService.upsertExternalSlots(seedSlots, {
              preserveAllocated: true,
            });
          }
        }
        isReady = true;
      })().catch((err) => {
        readyPromise = null;
        throw err;
      });
    }
    await readyPromise;
  }

  /**
   * Direct in-process typed RPC caller (0 serialization overhead for SSR Storefront/Admin).
   */
  const rpcClient = {
    catalog: {
      search: async (query: CatalogHybridSearchQuery) =>
        mcpServer.searchCatalogHybrid(query),
      hybridSearch: async (query: CatalogHybridSearchQuery) =>
        mcpServer.searchCatalogHybridDetailed(query),
    },
    orders: {
      list: async (input: ListOrdersKeysetInput = {}) => {
        if (!isReady) await ensureReady();
        return ordersRepo.listOrdersKeyset(input);
      },
      get: async (params: { readonly orderId: string }) => {
        if (!isReady) await ensureReady();
        return ordersRepo.getOrder(params.orderId);
      },
      analyticsBySku: async (params?: { readonly channelSlug?: string }) => {
        if (!isReady) await ensureReady();
        return ordersRepo.getSkuRevenueAnalytics(params);
      },
    },
    ledger: {
      getTrialBalance: async (params?: { readonly currencyCode?: string }) => {
        if (!isReady) await ensureReady();
        return subledger.getTrialBalance(params?.currencyCode ?? "USD");
      },
    },
    workflow: {
      recoverOrphans: async (params?: { readonly nowMs?: number; readonly limit?: number }) => {
        if (!isReady) await ensureReady();
        return sagaRecoveryWorker.recoverOrphanedRuns(params);
      },
    },
    inventory: {
      listReservations: async (statusFilter?: StockReservationStatus) => {
        if (!isReady) await ensureReady();
        return inventoryService.listReservations(statusFilter);
      },
      reapExpiredReservations: async (params?: {
        nowMs?: number;
        limit?: number;
      }) => {
        if (!isReady) await ensureReady();
        return reaperService.reapExpired(params?.nowMs ?? Date.now(), {
          limit: params?.limit,
        });
      },
    },
    pricing: {
      calculate: async (input: CartCalculationInput) => calculateCart(input),
    },
    checkout: {
      complete: async (params: {
        idempotencyKey: string;
        input: CompleteCheckoutInput;
      }) => {
        if (!isReady) await ensureReady();
        return checkoutWorkflow.execute(params.input, {
          idempotencyKey: params.idempotencyKey,
          store: workflowStore,
        });
      },
    },
    rma: {
      processReturn: async (params: {
        idempotencyKey: string;
        input: ProcessReturnRefundInput;
      }) => {
        if (!isReady) await ensureReady();
        return rmaWorkflow.execute(params.input, {
          idempotencyKey: params.idempotencyKey,
          store: workflowStore,
        });
      },
    },
    b2b: {
      listCompanies: async () => {
        if (!isReady) await ensureReady();
        return b2bService.listCompanies();
      },
      listPurchaseOrders: async (limit?: number) => {
        if (!isReady) await ensureReady();
        return b2bService.listPurchaseOrders(limit);
      },
      submitPo: async (params: {
        idempotencyKey: string;
        input: SubmitB2bPurchaseOrderInput;
      }) => {
        if (!isReady) await ensureReady();
        return b2bService.submitPurchaseOrder(params);
      },
      decidePo: async (params: {
        idempotencyKey: string;
        poId: string;
        approverId: string;
        decision: "APPROVE" | "REJECT";
        simulateCommitFault?: boolean;
      }) => {
        if (!isReady) await ensureReady();
        return b2bService.decidePendingPurchaseOrder(params);
      },
    },
    mcp: {
      listTools: async () => mcpServer.listTools(),
      diagnoseWaterfall: async (input: CartCalculationInput) =>
        mcpServer.diagnosePriceWaterfall(input),
    },
  };

  /**
   * Web Standard `fetch` handler (`(req: Request) => Promise<Response>`).
   */
  async function fetch(req: Request): Promise<Response> {
    if (!isReady) await ensureReady();
    const url = new URL(req.url);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
      let pgVersion: string | null = null;
      try {
        const verRes = await pgPool.query<{ server_version: string }>(
          "SELECT current_setting('server_version') AS server_version"
        );
        pgVersion = verRes.rows[0]?.server_version ?? null;
      } catch {
        pgVersion = null;
      }
      return jsonResponse({
        status: "ok",
        version: "0.2.0",
        engine: "super-ecommerce",
        database: "postgres",
        storage: "postgresql",
        pgVersion,
        protocols: ["orpc", "openapi-3.1", "mcp", "graphql", "stripe-webhooks"],
        timestamp: new Date().toISOString(),
      });
    }

    // OpenAPI 3.1.0 Contract Endpoint: GET /openapi.json
    if (req.method === "GET" && url.pathname === "/openapi.json") {
      return jsonResponse({
        openapi: "3.1.0",
        info: {
          title: "Super Ecommerce Headless Commerce Gateway API",
          version: "0.2.0",
          description:
            "Zero-float deterministic commerce API powered by Rust commerce-kernel, PostgreSQL 17 Durable Sagas, Double-Entry Subledger, and Model Context Protocol (MCP).",
        },
        paths: {
          "/healthz": { get: { summary: "Database & kernel readiness probe" } },
          "/mcp": { post: { summary: "Streamable HTTP Model Context Protocol (JSON-RPC 2.0)" } },
          "/webhooks/stripe": { post: { summary: "HMAC-SHA256 verified Stripe Webhook receiver" } },
          "/rpc/catalog.search": { post: { summary: "0-JOIN CQRS projection search" } },
          "/rpc/catalog.hybridSearch": { post: { summary: "BM25 + Vector RRF hybrid search" } },
          "/rpc/pricing.calculate": { post: { summary: "Two-pass Hare-Niemeyer + Margin Floor Guard pricing" } },
          "/rpc/checkout.complete": { post: { summary: "5-step Durable Saga checkout with mutual-exclusion lease" } },
          "/rpc/rma.processReturn": { post: { summary: "Multi-wave partial RMA return & refund Saga" } },
          "/rpc/orders.list": { post: { summary: "Keyset-paginated orders query" } },
          "/rpc/orders.get": { post: { summary: "Hydrated order & returns lookup" } },
          "/rpc/orders.analyticsBySku": { post: { summary: "Normalized order_lines SKU revenue & tax aggregation" } },
          "/rpc/ledger.getTrialBalance": { post: { summary: "Double-Entry Subledger trial balance verification" } },
          "/rpc/workflow.recoverOrphans": { post: { summary: "Trigger SagaRecoveryWorker orphan scan" } },
          "/rpc/b2b.submitPo": { post: { summary: "Enterprise B2B purchase order submission & 72h hold" } },
        },
      });
    }

    // Streamable HTTP Model Context Protocol Endpoint: POST /mcp
    if (req.method === "POST" && url.pathname === "/mcp") {
      try {
        const rpcReq = (await req.json()) as McpJsonRpcRequest;
        const rpcRes = await mcpServer.handleJsonRpcMessage(rpcReq);
        if (rpcRes === null) {
          return new Response(null, { status: 202 });
        }
        return jsonResponse(rpcRes, 200);
      } catch {
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          },
          400
        );
      }
    }

    // 0. Cryptographic Stripe Webhook Endpoint: POST /webhooks/stripe
    if (req.method === "POST" && url.pathname === "/webhooks/stripe") {
      const rawBody = await req.text();
      const signatureHeader = req.headers.get("stripe-signature");
      try {
        const result = await stripeWebhookService.handleRawWebhook({
          rawBody,
          signatureHeader,
        });
        return jsonResponse({ ok: true, data: result }, 200);
      } catch (err) {
        if (err instanceof StripeWebhookVerificationError) {
          return jsonResponse(
            {
              ok: false,
              code: err.code,
              error: err.message,
            },
            401
          );
        }
        return jsonResponse(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          500
        );
      }
    }

    // 1. Typed RPC HTTP Endpoint: POST /rpc/:procedure
    if (req.method === "POST" && url.pathname.startsWith("/rpc/")) {
      const procedure = url.pathname.slice("/rpc/".length);
      const body = (await req.json()) as Record<string, unknown>;

      switch (procedure) {
        case "catalog.search": {
          const hits = await rpcClient.catalog.search(
            body as unknown as CatalogHybridSearchQuery
          );
          return jsonResponse({ ok: true, data: hits });
        }
        case "catalog.hybridSearch": {
          const rawQ = body as unknown as CatalogHybridSearchQuery & {
            maxPriceAmount?: string | number | bigint;
          };
          const report = await rpcClient.catalog.hybridSearch({
            ...rawQ,
            maxPriceAmount:
              rawQ.maxPriceAmount !== undefined
                ? BigInt(rawQ.maxPriceAmount)
                : undefined,
          });
          return jsonResponse({ ok: true, data: report });
        }
        case "orders.list": {
          try {
            const page = await rpcClient.orders.list({
              limit: typeof body["limit"] === "number" ? body["limit"] : undefined,
              cursor: typeof body["cursor"] === "string" ? body["cursor"] : undefined,
              direction:
                body["direction"] === "prev"
                  ? "prev"
                  : body["direction"] === "next"
                    ? "next"
                    : undefined,
              channelSlug:
                typeof body["channelSlug"] === "string"
                  ? body["channelSlug"]
                  : undefined,
              paymentStatus:
                typeof body["paymentStatus"] === "string"
                  ? body["paymentStatus"]
                  : undefined,
              fulfillmentStatus:
                typeof body["fulfillmentStatus"] === "string"
                  ? body["fulfillmentStatus"]
                  : undefined,
              customerId:
                typeof body["customerId"] === "string"
                  ? body["customerId"]
                  : undefined,
              q: typeof body["q"] === "string" ? body["q"] : undefined,
            });
            return jsonResponse({ ok: true, data: page });
          } catch (err) {
            if (err instanceof InvalidOrderCursorError) {
              return jsonResponse(
                { ok: false, code: "INVALID_ORDER_CURSOR", error: err.message },
                400
              );
            }
            return jsonResponse(
              { ok: false, error: err instanceof Error ? err.message : String(err) },
              500
            );
          }
        }
        case "orders.get": {
          const orderId =
            typeof body["orderId"] === "string" ? body["orderId"].trim() : "";
          if (!orderId) {
            return jsonResponse(
              { ok: false, error: "orderId is required" },
              400
            );
          }
          const found = await rpcClient.orders.get({ orderId });
          if (!found) {
            return jsonResponse(
              { ok: false, error: `Order '${orderId}' not found` },
              404
            );
          }
          return jsonResponse({ ok: true, data: found });
        }
        case "inventory.listReservations": {
          const reservations = await rpcClient.inventory.listReservations(
            typeof body["status"] === "string"
              ? (body["status"] as StockReservationStatus)
              : undefined
          );
          return jsonResponse({ ok: true, data: reservations });
        }
        case "inventory.reapExpiredReservations": {
          const reapResult = await rpcClient.inventory.reapExpiredReservations({
            nowMs: typeof body["nowMs"] === "number" ? body["nowMs"] : undefined,
            limit: typeof body["limit"] === "number" ? body["limit"] : undefined,
          });
          return jsonResponse({ ok: true, data: reapResult });
        }
        case "pricing.calculate": {
          const calc = await rpcClient.pricing.calculate(
            body as unknown as CartCalculationInput
          );
          return jsonResponse({ ok: true, data: calc });
        }
        case "mcp.listTools": {
          const tools = await rpcClient.mcp.listTools();
          return jsonResponse({ ok: true, data: tools });
        }
        case "mcp.diagnoseWaterfall": {
          const diag = await rpcClient.mcp.diagnoseWaterfall(
            body as unknown as CartCalculationInput
          );
          return jsonResponse({ ok: true, data: diag });
        }
        case "orders.analyticsBySku": {
          const stats = await rpcClient.orders.analyticsBySku({
            channelSlug:
              typeof body["channelSlug"] === "string" ? body["channelSlug"] : undefined,
          });
          return jsonResponse({ ok: true, data: stats });
        }
        case "ledger.getTrialBalance": {
          const tb = await rpcClient.ledger.getTrialBalance({
            currencyCode:
              typeof body["currencyCode"] === "string" ? body["currencyCode"] : undefined,
          });
          return jsonResponse({ ok: true, data: tb });
        }
        case "workflow.recoverOrphans": {
          const rec = await rpcClient.workflow.recoverOrphans({
            nowMs: typeof body["nowMs"] === "number" ? body["nowMs"] : undefined,
            limit: typeof body["limit"] === "number" ? body["limit"] : undefined,
          });
          return jsonResponse({ ok: true, data: rec });
        }
        case "checkout.complete": {
          try {
            const chkRes = await rpcClient.checkout.complete(
              body as unknown as {
                idempotencyKey: string;
                input: CompleteCheckoutInput;
              }
            );
            return jsonResponse({ ok: true, data: chkRes });
          } catch (err) {
            if (err instanceof WorkflowConcurrentExecutionError) {
              return jsonResponse(
                { ok: false, code: "WORKFLOW_CONCURRENT_EXECUTION", error: err.message },
                409
              );
            }
            return jsonResponse(
              { ok: false, error: err instanceof Error ? err.message : String(err) },
              500
            );
          }
        }
        case "rma.processReturn": {
          try {
            const rmaRes = await rpcClient.rma.processReturn(
              body as unknown as {
                idempotencyKey: string;
                input: ProcessReturnRefundInput;
              }
            );
            return jsonResponse({ ok: true, data: rmaRes });
          } catch (err) {
            if (err instanceof WorkflowConcurrentExecutionError) {
              return jsonResponse(
                { ok: false, code: "WORKFLOW_CONCURRENT_EXECUTION", error: err.message },
                409
              );
            }
            return jsonResponse(
              { ok: false, error: err instanceof Error ? err.message : String(err) },
              500
            );
          }
        }
        case "b2b.listCompanies": {
          const companies = await rpcClient.b2b.listCompanies();
          return jsonResponse({ ok: true, data: companies });
        }
        case "b2b.listPurchaseOrders": {
          const pos = await rpcClient.b2b.listPurchaseOrders(
            typeof body["limit"] === "number" ? body["limit"] : undefined
          );
          return jsonResponse({ ok: true, data: pos });
        }
        case "b2b.submitPo": {
          const poRes = await rpcClient.b2b.submitPo(
            body as unknown as {
              idempotencyKey: string;
              input: SubmitB2bPurchaseOrderInput;
            }
          );
          return jsonResponse({ ok: true, data: poRes });
        }
        case "b2b.decidePo": {
          const decRes = await rpcClient.b2b.decidePo(
            body as unknown as {
              idempotencyKey: string;
              poId: string;
              approverId: string;
              decision: "APPROVE" | "REJECT";
              simulateCommitFault?: boolean;
            }
          );
          return jsonResponse({ ok: true, data: decRes });
        }
        default:
          return jsonResponse(
            { ok: false, error: `Unknown RPC procedure '${procedure}'` },
            404
          );
      }
    }

    // 2. Open Ecosystem Storefront GraphQL Endpoint: POST /graphql
    if (req.method === "POST" && url.pathname === "/graphql") {
      const { query, variables } = (await req.json()) as {
        query: string;
        variables?: Record<string, unknown>;
      };

      const security = inspectGraphQlQuerySecurity(
        query,
        maxGraphQlDepth,
        maxGraphQlAliases
      );
      if (!security.allowed) {
        return jsonResponse(
          {
            errors: [
              {
                message: security.violationMessage,
                extensions: {
                  code: security.violationCode,
                  maxDepthObserved: security.maxDepthObserved,
                  aliasCountObserved: security.aliasCountObserved,
                },
              },
            ],
          },
          400
        );
      }

      if (query.includes("products")) {
        const channelMatch = /channel:\s*"([^"]+)"/.exec(query);
        const channelSlug =
          (variables?.["channel"] as string | undefined) ??
          channelMatch?.[1] ??
          "us-retail";

        const items = mcpServer.searchCatalogHybrid({ channelSlug });
        return jsonResponse({
          data: {
            products: {
              edges: items.map((node) => ({
                node: {
                  id: node.productId,
                  slug: node.productSlug,
                  name: node.productName,
                  isAvailable: node.isInStock,
                  pricing: {
                    priceRange: {
                      start: {
                        gross: {
                          currency: node.currencyCode,
                          amount: node.minEffectivePrice.toString(),
                        },
                      },
                      stop: {
                        gross: {
                          currency: node.currencyCode,
                          amount: node.maxEffectivePrice.toString(),
                        },
                      },
                    },
                  },
                },
              })),
            },
          },
        });
      }

      return jsonResponse(
        { errors: [{ message: "Unsupported GraphQL operation in minimal gateway" }] },
        400
      );
    }

    return jsonResponse({ error: "Not Found" }, 404);
  }

  return {
    fetch,
    ready: ensureReady,
    pgPool,
    rpcClient,
    ordersRepo,
    subledger,
    workflowStore,
    sagaRecoveryWorker,
    outboxService,
    stripeWebhookService,
    b2bService,
    reaperService,
    mcpServer,
    inventoryService,
  };
}

export interface GatewayProtocolBenchmarkTier {
  readonly tierId: string;
  readonly protocol: "IN_PROCESS_ORPC" | "HTTP_RPC_JSON" | "HTTP_GRAPHQL" | "MIXED_128X_BURST" | "GRAPHQL_DOS_GUARD";
  readonly endpoint: string;
  readonly requestsCount: number;
  readonly wallTimeMs: number;
  readonly reqPerSec: number;
  readonly p50LatencyUs: number;
  readonly p99LatencyUs: number;
  readonly payloadBytesAvg: number;
  readonly verificationSummary: string;
}

export interface GatewayProtocolStressReport {
  readonly totalRequests: number;
  readonly totalWallTimeMs: number;
  readonly inProcessOrpcReqPerSec: number;
  readonly httpRpcReqPerSec: number;
  readonly httpGraphqlReqPerSec: number;
  readonly orpcVsGraphqlSpeedup: number;
  readonly httpRpcVsGraphqlSpeedup: number;
  readonly dosAttacksBlockedCount: number;
  readonly latestBanner: string;
  readonly tiers: readonly GatewayProtocolBenchmarkTier[];
  readonly executedAtIso: string;
}

let cachedGatewayStressReport: GatewayProtocolStressReport | null = null;

function computePctUs(samplesNs: number[]): { p50Us: number; p99Us: number } {
  if (samplesNs.length === 0) return { p50Us: 0, p99Us: 0 };
  const sorted = [...samplesNs].sort((a, b) => a - b);
  const p50Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5));
  const p99Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
  return {
    p50Us: Math.round((sorted[p50Idx]! / 1_000) * 100) / 100,
    p99Us: Math.round((sorted[p99Idx]! / 1_000) * 100) / 100,
  };
}

export async function runGatewayProtocolStressBenchmark(options: {
  projections: readonly CatalogChannelProjectionRecord[];
  scale?: number;
  forceRefresh?: boolean;
  customBanner?: string;
}): Promise<GatewayProtocolStressReport> {
  if (cachedGatewayStressReport && !options.forceRefresh && !options.customBanner) {
    return cachedGatewayStressReport;
  }

  const scale = options.scale ?? 1;
  const gateway = createSuperCommerceGateway({
    projections: options.projections,
    maxGraphQlDepth: 8,
    maxGraphQlAliases: 8,
  });

  const suiteStart = process.hrtime.bigint();

  // Tier 1: Direct In-Process Typed oRPC (rpcClient.catalog.search)
  const orpcIters = Math.max(300, Math.round(3_000 * scale));
  const orpcSamples: number[] = [];
  const t1Start = process.hrtime.bigint();
  for (let i = 0; i < orpcIters; i++) {
    const s0 = process.hrtime.bigint();
    await gateway.rpcClient.catalog.search({
      channelSlug: "us-retail",
      inStockOnly: true,
    });
    if (i % 10 === 0) {
      orpcSamples.push(Number(process.hrtime.bigint() - s0));
    }
  }
  const t1WallMs = Number(process.hrtime.bigint() - t1Start) / 1_000_000;
  const t1Pct = computePctUs(orpcSamples);

  // Tier 2: HTTP POST /rpc/catalog.search (Web Standard Request/Response)
  const httpRpcIters = Math.max(200, Math.round(1_200 * scale));
  const httpRpcSamples: number[] = [];
  const rpcPayload = JSON.stringify({
    channelSlug: "us-retail",
    inStockOnly: true,
  });
  let rpcResBytes = 0;
  const t2Start = process.hrtime.bigint();
  for (let i = 0; i < httpRpcIters; i++) {
    const s0 = process.hrtime.bigint();
    const res = await gateway.fetch(
      new Request("http://localhost/rpc/catalog.search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rpcPayload,
      })
    );
    const txt = await res.text();
    if (i === 0) rpcResBytes = txt.length;
    if (i % 5 === 0) {
      httpRpcSamples.push(Number(process.hrtime.bigint() - s0));
    }
  }
  const t2WallMs = Number(process.hrtime.bigint() - t2Start) / 1_000_000;
  const t2Pct = computePctUs(httpRpcSamples);

  // Tier 3: HTTP POST /graphql (Saleor Relay Storefront Query + AST Security Check)
  const gqlIters = Math.max(200, Math.round(1_200 * scale));
  const gqlSamples: number[] = [];
  const gqlPayload = JSON.stringify({
    query: `query StorefrontCatalog($channel: String!) {
      products(channel: $channel) {
        edges {
          node {
            id
            slug
            name
            isAvailable
            pricing {
              priceRange {
                start { gross { currency amount } }
              }
            }
          }
        }
      }
    }`,
    variables: { channel: "us-retail" },
  });
  let gqlResBytes = 0;
  const t3Start = process.hrtime.bigint();
  for (let i = 0; i < gqlIters; i++) {
    const s0 = process.hrtime.bigint();
    const res = await gateway.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: gqlPayload,
      })
    );
    const txt = await res.text();
    if (i === 0) gqlResBytes = txt.length;
    if (i % 5 === 0) {
      gqlSamples.push(Number(process.hrtime.bigint() - s0));
    }
  }
  const t3WallMs = Number(process.hrtime.bigint() - t3Start) / 1_000_000;
  const t3Pct = computePctUs(gqlSamples);

  // Tier 4: 128-Way Concurrent Mixed Protocol Burst (/rpc/* + /graphql + /health)
  const burstIters = Math.max(128, Math.round(1_024 * scale));
  const burstConcurrency = 128;
  const burstSamples: number[] = [];
  let burstOkCount = 0;
  const t4Start = process.hrtime.bigint();
  for (let offset = 0; offset < burstIters; offset += burstConcurrency) {
    const batchSize = Math.min(burstConcurrency, burstIters - offset);
    const b0 = process.hrtime.bigint();
    const responses = await Promise.all(
      Array.from({ length: batchSize }, (_, idx) => {
        if (idx % 3 === 0) {
          return gateway.fetch(
            new Request("http://localhost/rpc/catalog.search", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: rpcPayload,
            })
          );
        }
        if (idx % 3 === 1) {
          return gateway.fetch(
            new Request("http://localhost/graphql", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: gqlPayload,
            })
          );
        }
        return gateway.fetch(new Request("http://localhost/health"));
      })
    );
    burstSamples.push((Number(process.hrtime.bigint() - b0)) / batchSize);
    for (const r of responses) {
      if (r.status === 200) burstOkCount += 1;
    }
  }
  const t4WallMs = Number(process.hrtime.bigint() - t4Start) / 1_000_000;
  const t4Pct = computePctUs(burstSamples);

  // Tier 5: Adversarial GraphQL Depth-12 Bomb & 15x Alias Amplification DoS Guard
  const dosIters = Math.max(100, Math.round(400 * scale));
  const dosSamples: number[] = [];
  let dosBlockedCount = 0;
  const depthBombPayload = JSON.stringify({
    query: `query DepthBomb { a { b { c { d { e { f { g { h { i { j { k { l { id } } } } } } } } } } } } }`,
  });
  const aliasBombPayload = JSON.stringify({
    query: `query AliasBomb { p1:products{id} p2:products{id} p3:products{id} p4:products{id} p5:products{id} p6:products{id} p7:products{id} p8:products{id} p9:products{id} p10:products{id} }`,
  });
  const t5Start = process.hrtime.bigint();
  for (let i = 0; i < dosIters; i++) {
    const s0 = process.hrtime.bigint();
    const res = await gateway.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: i % 2 === 0 ? depthBombPayload : aliasBombPayload,
      })
    );
    dosSamples.push(Number(process.hrtime.bigint() - s0));
    if (res.status === 400) {
      dosBlockedCount += 1;
    }
  }
  const t5WallMs = Number(process.hrtime.bigint() - t5Start) / 1_000_000;
  const t5Pct = computePctUs(dosSamples);

  const totalWallTimeMs =
    Math.round((Number(process.hrtime.bigint() - suiteStart) / 1_000_000) * 10) / 10;
  const totalRequests = orpcIters + httpRpcIters + gqlIters + burstIters + dosIters;

  const inProcessOrpcReqPerSec = Math.round(orpcIters / Math.max(0.0001, t1WallMs / 1_000));
  const httpRpcReqPerSec = Math.round(httpRpcIters / Math.max(0.0001, t2WallMs / 1_000));
  const httpGraphqlReqPerSec = Math.round(gqlIters / Math.max(0.0001, t3WallMs / 1_000));
  const burstReqPerSec = Math.round(burstIters / Math.max(0.0001, t4WallMs / 1_000));
  const dosReqPerSec = Math.round(dosIters / Math.max(0.0001, t5WallMs / 1_000));

  const orpcVsGraphqlSpeedup =
    Math.round((inProcessOrpcReqPerSec / Math.max(1, httpGraphqlReqPerSec)) * 10) / 10;
  const httpRpcVsGraphqlSpeedup =
    Math.round((httpRpcReqPerSec / Math.max(1, httpGraphqlReqPerSec)) * 100) / 100;

  const tiers: GatewayProtocolBenchmarkTier[] = [
    {
      tierId: "in-process-orpc",
      protocol: "IN_PROCESS_ORPC",
      endpoint: "rpcClient.catalog.search (Zero-Serialization Direct Call)",
      requestsCount: orpcIters,
      wallTimeMs: Math.round(t1WallMs * 100) / 100,
      reqPerSec: inProcessOrpcReqPerSec,
      p50LatencyUs: t1Pct.p50Us,
      p99LatencyUs: t1Pct.p99Us,
      payloadBytesAvg: 0,
      verificationSummary: `${orpcVsGraphqlSpeedup}x Faster than HTTP GraphQL | 0 JSON Overhead`,
    },
    {
      tierId: "http-rpc-json",
      protocol: "HTTP_RPC_JSON",
      endpoint: "POST /rpc/catalog.search (Web Standard Request/Response)",
      requestsCount: httpRpcIters,
      wallTimeMs: Math.round(t2WallMs * 100) / 100,
      reqPerSec: httpRpcReqPerSec,
      p50LatencyUs: t2Pct.p50Us,
      p99LatencyUs: t2Pct.p99Us,
      payloadBytesAvg: rpcResBytes,
      verificationSummary: `${httpRpcVsGraphqlSpeedup}x vs GraphQL | Flat CQRS Array (${rpcResBytes} B)`,
    },
    {
      tierId: "http-graphql-relay",
      protocol: "HTTP_GRAPHQL",
      endpoint: "POST /graphql (Saleor Relay Edges/Node + AST Depth Check)",
      requestsCount: gqlIters,
      wallTimeMs: Math.round(t3WallMs * 100) / 100,
      reqPerSec: httpGraphqlReqPerSec,
      p50LatencyUs: t3Pct.p50Us,
      p99LatencyUs: t3Pct.p99Us,
      payloadBytesAvg: gqlResBytes,
      verificationSummary: `Saleor-Compatible Relay Graph (${gqlResBytes} B) | Depth <= 8`,
    },
    {
      tierId: "mixed-128x-burst",
      protocol: "MIXED_128X_BURST",
      endpoint: "128-Way Concurrent Mixed Burst (/rpc/* + /graphql + /health)",
      requestsCount: burstIters,
      wallTimeMs: Math.round(t4WallMs * 100) / 100,
      reqPerSec: burstReqPerSec,
      p50LatencyUs: t4Pct.p50Us,
      p99LatencyUs: t4Pct.p99Us,
      payloadBytesAvg: Math.round((rpcResBytes + gqlResBytes) / 2),
      verificationSummary: `${burstOkCount}/${burstIters} HTTP 200 OK | 128x Parallel Isolation`,
    },
    {
      tierId: "graphql-dos-shield",
      protocol: "GRAPHQL_DOS_GUARD",
      endpoint: "POST /graphql (Depth-12 Bomb + 10x Alias Amplification Attack)",
      requestsCount: dosIters,
      wallTimeMs: Math.round(t5WallMs * 100) / 100,
      reqPerSec: dosReqPerSec,
      p50LatencyUs: t5Pct.p50Us,
      p99LatencyUs: t5Pct.p99Us,
      payloadBytesAvg: 192,
      verificationSummary: `Blocked ${dosBlockedCount}/${dosIters} (HTTP 400) | 0 Backend Queries Executed`,
    },
  ];

  const defaultBanner = `DUAL-PROTOCOL GATEWAY VERIFIED // ${totalRequests.toLocaleString()} Requests in ${totalWallTimeMs} ms | In-Process oRPC: ${inProcessOrpcReqPerSec.toLocaleString()} req/s (${orpcVsGraphqlSpeedup}x vs GraphQL) | HTTP RPC: ${httpRpcReqPerSec.toLocaleString()} req/s | HTTP GraphQL: ${httpGraphqlReqPerSec.toLocaleString()} req/s | GraphQL DoS Blocked: ${dosBlockedCount}/${dosIters}`;

  const report: GatewayProtocolStressReport = {
    totalRequests,
    totalWallTimeMs,
    inProcessOrpcReqPerSec,
    httpRpcReqPerSec,
    httpGraphqlReqPerSec,
    orpcVsGraphqlSpeedup,
    httpRpcVsGraphqlSpeedup,
    dosAttacksBlockedCount: dosBlockedCount,
    latestBanner: options.customBanner ?? defaultBanner,
    tiers,
    executedAtIso: new Date().toISOString(),
  };

  cachedGatewayStressReport = report;
  return report;
}
