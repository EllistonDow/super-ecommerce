import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AdminRpcClient } from "../api/rpc-client.ts";

export function McpCopilotPage({ rpc }: { readonly rpc: AdminRpcClient }) {
  const [channelSlug, setChannelSlug] = useState("us-retail");
  const [searchQuery, setSearchQuery] = useState("titanium keyboard");
  const [mcpOutput, setMcpOutput] = useState<string>("");

  const toolsQuery = useQuery({
    queryKey: ["mcp", "tools"],
    queryFn: () => rpc.mcp.listToolsJsonRpc(),
  });

  const searchToolMutation = useMutation({
    mutationFn: () =>
      rpc.mcp.callToolJsonRpc("search_catalog_hybrid", {
        channelSlug,
        query: searchQuery,
      }),
    onSuccess: (res) => {
      setMcpOutput(JSON.stringify(res, null, 2));
    },
  });

  const waterfallToolMutation = useMutation({
    mutationFn: () =>
      rpc.mcp.callToolJsonRpc("diagnose_price_waterfall", {
        currencyCode: "USD",
        taxMode: "TAX_EXCLUSIVE",
        shippingBaseAmount: "1500",
        shippingTaxRateBps: 825,
        lines: [
          {
            lineId: "L-1",
            variantId: "KR-KB75-TI",
            quantity: 2,
            baseUnitPrice: "39000",
            taxRateBps: 825,
            unitCostAmount: "26000",
            minMarginBps: 1500,
          },
        ],
        candidateOrderDiscounts: [
          {
            discountId: "promo-40",
            name: "Aggressive 40% Promo (Clamped by Margin Floor)",
            kind: "ORDER_PROMOTION",
            value: { type: "PERCENTAGE", bps: 4000 },
          },
        ],
      }),
    onSuccess: (res) => {
      setMcpOutput(JSON.stringify(res, null, 2));
    },
  });

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Model Context Protocol (MCP) Copilot Inspector</h1>
          <p>
            Streamable HTTP JSON-RPC 2.0 (2025-03-26) tool discovery and deterministic Rust price
            waterfall diagnostics.
          </p>
        </div>
        <span className="badge badge-ok">
          {(toolsQuery.data ?? []).length} Registered MCP Tools
        </span>
      </header>

      <section className="kpi-grid" style={{ marginTop: "1.25rem" }}>
        {(toolsQuery.data ?? []).map((tool) => (
          <div key={tool.name} className="card">
            <div className="kpi-label mono">{tool.name}</div>
            <div className="kpi-meta" style={{ marginTop: "0.4rem" }}>
              {tool.description}
            </div>
          </div>
        ))}
      </section>

      <section className="card" style={{ marginTop: "1.25rem" }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="mcp-channel">Channel Slug</label>
            <input
              id="mcp-channel"
              value={channelSlug}
              onChange={(e) => setChannelSlug(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="mcp-query">Hybrid BM25 + Vector Query</label>
            <input
              id="mcp-query"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="btn-row" style={{ marginTop: "1rem" }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => waterfallToolMutation.mutate()}
          >
            Invoke diagnose_price_waterfall (Margin Guard Demo)
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => searchToolMutation.mutate()}
          >
            Invoke search_catalog_hybrid
          </button>
        </div>
      </section>

      <pre className="code-block" style={{ marginTop: "1.25rem" }}>
        <code>
          {mcpOutput ||
            '// Select an MCP JSON-RPC 2.0 tool invocation above to inspect the live response payload.'}
        </code>
      </pre>
    </div>
  );
}
