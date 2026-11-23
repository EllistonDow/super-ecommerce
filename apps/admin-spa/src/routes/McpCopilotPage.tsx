import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminRpcClient } from "../api/rpc-client.ts";

export function McpCopilotPage({ rpc }: { readonly rpc: AdminRpcClient }) {
  const queryClient = useQueryClient();
  const [channelSlug, setChannelSlug] = useState("us-retail");
  const [searchQuery, setSearchQuery] = useState("titanium keyboard");
  const [mcpOutput, setMcpOutput] = useState<string>("");

  const toolsQuery = useQuery({
    queryKey: ["mcp", "tools"],
    queryFn: () => rpc.mcp.listToolsJsonRpc(),
  });

  const logsQuery = useQuery({
    queryKey: ["mcp", "logs"],
    queryFn: () => rpc.mcp.listLogs(10),
    refetchInterval: 5000,
  });

  const searchToolMutation = useMutation({
    mutationFn: () =>
      rpc.mcp.callToolJsonRpc("search_catalog_hybrid", {
        channelSlug,
        queryText: searchQuery,
      }),
    onSuccess: (res) => {
      setMcpOutput(JSON.stringify(res, null, 2));
      void queryClient.invalidateQueries({ queryKey: ["mcp", "logs"] });
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
      void queryClient.invalidateQueries({ queryKey: ["mcp", "logs"] });
    },
  });

  const stockDoctorMutation = useMutation({
    mutationFn: () =>
      rpc.mcp.callToolJsonRpc("diagnose_stock_availability_doctor", {
        variantId: "KR-KB75-TI",
        requestedQuantity: 35,
        availabilityMode: "LEGACY_SHIPPING_ZONE_WAREHOUSES",
        slots: [
          {
            warehouseId: "US-EAST",
            priorityRank: 1,
            linkedToChannel: true,
            supportsShippingZone: true,
            variantId: "KR-KB75-TI",
            quantityOnHand: 6,
            quantityReserved: 0,
            quantityAllocated: 0,
          },
          {
            warehouseId: "US-CENTRAL",
            priorityRank: 2,
            linkedToChannel: true,
            supportsShippingZone: true,
            variantId: "KR-KB75-TI",
            quantityOnHand: 24,
            quantityReserved: 0,
            quantityAllocated: 0,
          },
          {
            warehouseId: "EU-ROTTERDAM-OVERFLOW",
            priorityRank: 3,
            linkedToChannel: true,
            supportsShippingZone: false,
            variantId: "KR-KB75-TI",
            quantityOnHand: 15,
            quantityReserved: 0,
            quantityAllocated: 0,
          },
        ],
      }),
    onSuccess: (res) => {
      setMcpOutput(JSON.stringify(res, null, 2));
      void queryClient.invalidateQueries({ queryKey: ["mcp", "logs"] });
    },
  });

  const configDiffMutation = useMutation({
    mutationFn: () =>
      rpc.mcp.callToolJsonRpc("preview_store_config_diff", {
        remoteState: {
          warehouses: [
            { slug: "us-east", name: "US East Regional DC", countryCode: "US" },
            { slug: "us-west", name: "US West Secondary DC", countryCode: "US" },
          ],
          channels: [
            {
              slug: "us-retail",
              name: "US Retail Channel",
              currencyCode: "USD",
              defaultCountry: "US",
              warehouseSlugs: ["us-east", "us-west"],
            },
          ],
          productTypes: [
            {
              slug: "keyboards",
              name: "Mechanical Keyboards",
              productAttributesSchema: [],
              variantAttributesSchema: [],
            },
          ],
          products: [
            {
              slug: "kronos-ti",
              name: "Kronos Titanium 75",
              productTypeSlug: "keyboards",
              attributes: {},
              variants: [],
            },
          ],
        },
        desiredConfig: {
          warehouses: [
            { slug: "us-east", name: "US East Regional DC", countryCode: "US" },
            { slug: "us-west", name: "US West Secondary DC", countryCode: "US" },
            { slug: "eu-central", name: "EU Frankfurt Hub", countryCode: "DE" },
          ],
          channels: [
            {
              slug: "us-retail",
              name: "US Retail Channel",
              currencyCode: "USD",
              defaultCountry: "US",
              warehouseSlugs: ["us-east", "us-west"],
            },
            {
              slug: "eu-flagship",
              name: "EU Flagship Channel",
              currencyCode: "EUR",
              defaultCountry: "DE",
              warehouseSlugs: ["eu-central"],
            },
          ],
          productTypes: [
            {
              slug: "keyboards",
              name: "Mechanical Keyboards (Pro)",
              productAttributesSchema: [],
              variantAttributesSchema: [],
            },
          ],
          products: [
            {
              slug: "kronos-ti",
              name: "Kronos Titanium 75 (2026 Edition)",
              productTypeSlug: "keyboards",
              attributes: {},
              variants: [],
            },
          ],
        },
      }),
    onSuccess: (res) => {
      setMcpOutput(JSON.stringify(res, null, 2));
      void queryClient.invalidateQueries({ queryKey: ["mcp", "logs"] });
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
            Invoke diagnose_price_waterfall
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => searchToolMutation.mutate()}
          >
            Invoke search_catalog_hybrid
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => stockDoctorMutation.mutate()}
          >
            Invoke diagnose_stock_availability_doctor
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => configDiffMutation.mutate()}
          >
            Invoke preview_store_config_diff
          </button>
        </div>
      </section>

      <pre className="code-block" style={{ marginTop: "1.25rem" }}>
        <code>
          {mcpOutput ||
            '// Select an MCP JSON-RPC 2.0 tool invocation above to inspect the live response payload.'}
        </code>
      </pre>

      <section className="card" style={{ marginTop: "1.25rem" }}>
        <div className="section-title">
          <h2>MCP Diagnostic Invocation Audit Trail</h2>
          <span className="badge badge-info mono">
            {(logsQuery.data ?? []).length} Recorded Invocations
          </span>
        </div>
        <div className="table-wrapper" style={{ marginTop: "0.75rem" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>INVOCATION ID</th>
                <th>TOOL</th>
                <th>PERSONA</th>
                <th>LATENCY</th>
                <th>STATUS</th>
                <th>HEADLINE FINDING</th>
              </tr>
            </thead>
            <tbody>
              {(logsQuery.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "var(--muted)" }}>
                    No diagnostic invocations logged yet. Click any tool above to trigger an audit record.
                  </td>
                </tr>
              ) : (
                (logsQuery.data ?? []).map((log) => (
                  <tr key={log.invocationId}>
                    <td className="mono bold">{log.invocationId}</td>
                    <td className="mono">{log.toolName}</td>
                    <td>
                      <span className="badge badge-neutral mono" style={{ fontSize: "0.7rem" }}>
                        {log.persona}
                      </span>
                    </td>
                    <td className="mono">{log.latencyUs} µs</td>
                    <td>
                      <span className={`badge ${log.status === "SUCCESS" ? "badge-ok" : "badge-warn"}`}>
                        {log.status}
                      </span>
                    </td>
                    <td style={{ fontSize: "0.8rem", maxWidth: "400px" }}>{log.headlineFinding}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
