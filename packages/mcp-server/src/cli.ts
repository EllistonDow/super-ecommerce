/**
 * Standalone Model Context Protocol (`MCP`) `stdio` Transport CLI (`packages/mcp-server/src/cli.ts`).
 *
 * Usage (Claude Desktop / Cursor / Windsurf MCP Server config):
 *   `node --experimental-strip-types packages/mcp-server/src/cli.ts`
 *   or `npm run mcp`
 */

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PgPool, runMigrations, type CatalogChannelProjectionRecord } from "@super-ecommerce/db";
import { SuperCommerceMcpServer, type McpJsonRpcRequest } from "./index.ts";

async function loadInitialProjectionsFromPg(): Promise<CatalogChannelProjectionRecord[]> {
  if (process.env["SUPER_PG_USE_WIRE"] !== "1") {
    return [];
  }
  const pool = PgPool.fromEnv({ maxConnections: 2, statementTimeoutMs: 5_000 });
  try {
    await runMigrations(pool);
    const res = await pool.query<{
      channel_slug: string;
      product_id: string;
      product_slug: string;
      product_name: string;
      currency_code: string;
      min_effective_price: string;
      max_effective_price: string;
      is_in_stock: string | boolean;
      total_available_qty: string;
      merged_attributes: string;
      variants_snapshot: string;
    }>(`SELECT * FROM catalog_channel_projections LIMIT 500`);

    return res.rows.map((r) => ({
      channelSlug: r.channel_slug,
      productId: r.product_id,
      productSlug: r.product_slug,
      productName: r.product_name,
      currencyCode: r.currency_code,
      minEffectivePrice: BigInt(r.min_effective_price),
      maxEffectivePrice: BigInt(r.max_effective_price),
      isInStock: r.is_in_stock === true || r.is_in_stock === "true" || r.is_in_stock === "t",
      totalAvailableQty: Number(r.total_available_qty),
      mergedAttributes:
        typeof r.merged_attributes === "string"
          ? JSON.parse(r.merged_attributes)
          : r.merged_attributes,
      variantsSnapshot:
        typeof r.variants_snapshot === "string"
          ? JSON.parse(r.variants_snapshot)
          : r.variants_snapshot,
    }));
  } finally {
    await pool.close();
  }
}

export async function startMcpStdioServer(): Promise<void> {
  const projections = await loadInitialProjectionsFromPg().catch(() => []);
  const mcpServer = new SuperCommerceMcpServer(projections);

  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  let queue = Promise.resolve();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    queue = queue.then(async () => {
      try {
        const parsed = JSON.parse(trimmed) as McpJsonRpcRequest;
        const response = await mcpServer.handleJsonRpcMessage(parsed);
        if (response !== null) {
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      } catch {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          })}\n`
        );
      }
    });
  });

  rl.on("close", () => {
    void queue;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void startMcpStdioServer();
}
