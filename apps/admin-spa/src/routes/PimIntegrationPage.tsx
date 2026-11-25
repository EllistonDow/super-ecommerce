import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminRpcClient } from "../api/rpc-client.ts";
import { formatMinorUnits } from "../lib/money.ts";

export function PimIntegrationPage({ rpc }: { readonly rpc: AdminRpcClient }) {
  const queryClient = useQueryClient();
  const [outputJson, setOutputJson] = useState<string>("");

  const statusQuery = useQuery({
    queryKey: ["pim", "status"],
    queryFn: () => rpc.pim.getSyncStatus(),
    refetchInterval: 4000,
  });

  const syncMutation = useMutation({
    mutationFn: (simulateFault: boolean) => rpc.pim.syncSample(simulateFault),
    onSuccess: (res) => {
      setOutputJson(JSON.stringify(res, null, 2));
      void queryClient.invalidateQueries({ queryKey: ["pim", "status"] });
    },
  });

  const previewMutation = useMutation({
    mutationFn: () => rpc.pim.preview(),
    onSuccess: (res) => {
      setOutputJson(JSON.stringify(res, null, 2));
    },
  });

  const statusData = statusQuery.data;
  const projections = statusData?.materializedProjections ?? [];
  const auditLogs = statusData?.auditHistory ?? [];

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Enterprise PIM (Akeneo / Salsify) Integration Hub</h1>
          <p>
            Declarative Commerce-as-Code ingestion pipeline, Stage 1 pre-flight schema validation,
            immutable slug identity, and zero-JOIN CQRS catalog projection materialization.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span className="badge badge-ok">
            {statusData?.systemSource ?? "Akeneo PIM Active"}
          </span>
          <span className="badge badge-info mono">
            {projections.length} Projections Synced
          </span>
        </div>
      </header>

      {/* KPI Grid */}
      <section className="kpi-grid" style={{ marginTop: "1.25rem" }}>
        <div className="card">
          <div className="kpi-label">PIM INGESTION SOURCE</div>
          <div className="kpi-value" style={{ fontSize: "1.1rem" }}>Akeneo v7.3 Cloud</div>
          <div className="kpi-meta">Webhook Endpoint: /api/pim/webhook</div>
        </div>
        <div className="card">
          <div className="kpi-label">MATERIALIZED PROJECTIONS</div>
          <div className="kpi-value">{projections.length}</div>
          <div className="kpi-meta">Zero-JOIN PostgreSQL 17 Single-Table Read Model</div>
        </div>
        <div className="card">
          <div className="kpi-label">INGESTION AUDIT LOGS</div>
          <div className="kpi-value">{auditLogs.length}</div>
          <div className="kpi-meta">Immutable Execution Runs Logged</div>
        </div>
        <div className="card">
          <div className="kpi-label">PRE-FLIGHT GUARD</div>
          <div className="kpi-value" style={{ color: "var(--accent)" }}>ACTIVE</div>
          <div className="kpi-meta">Slug Regex &amp; Type Safety Enforced</div>
        </div>
      </section>

      {/* Action Controls */}
      <section className="card" style={{ marginTop: "1.25rem" }}>
        <div className="section-title">
          <h2>PIM Pipeline Ingestion Controls</h2>
          <span className="badge badge-neutral mono">Akeneo JSON Webhook Protocol</span>
        </div>
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: "0.25rem" }}>
          Trigger automated multi-channel catalog ingestion, simulate pre-flight schema rejection, or inspect topological diffs before committing to database projections.
        </p>

        <div className="btn-row" style={{ marginTop: "1rem" }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={syncMutation.isPending}
            onClick={() => syncMutation.mutate(false)}
          >
            {syncMutation.isPending ? "Ingesting..." : "Ingest Akeneo PIM Catalog (3 Products / 2 Families)"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            Preview Topological Diff
          </button>
          <button
            type="button"
            className="btn"
            style={{ borderColor: "var(--warn)", color: "var(--warn)" }}
            disabled={syncMutation.isPending}
            onClick={() => syncMutation.mutate(true)}
          >
            Simulate Broken PIM Payload (Pre-Flight Rejection Guard)
          </button>
        </div>
      </section>

      {/* Output Console */}
      <pre className="code-block" style={{ marginTop: "1.25rem" }}>
        <code>
          {outputJson ||
            "// Click any action above to inspect live PIM Ingestion responses, Topological Stage Diffs, and Pre-Flight Guard output."}
        </code>
      </pre>

      {/* Materialized Projections Grid */}
      <section className="card" style={{ marginTop: "1.25rem" }}>
        <div className="section-title">
          <h2>Materialized CQRS Catalog Projections (Synced from PIM)</h2>
          <span className="badge badge-ok mono">Instant Sub-ms Queryable</span>
        </div>
        <div className="table-wrapper" style={{ marginTop: "0.75rem" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>PRODUCT NAME</th>
                <th>CHANNEL</th>
                <th>PRICE</th>
                <th>STOCK</th>
                <th>DYNAMIC PIM ATTRIBUTES</th>
              </tr>
            </thead>
            <tbody>
              {projections.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "var(--muted)" }}>
                    No PIM products ingested yet. Click &quot;Ingest Akeneo PIM Catalog&quot; to materialize products.
                  </td>
                </tr>
              ) : (
                projections.map((p) => (
                  <tr key={`${p.productSlug}-${p.channelSlug}`}>
                    <td className="mono bold">{p.sku}</td>
                    <td>
                      <div className="bold">{p.productName}</div>
                      <div className="muted mono" style={{ fontSize: "0.75rem" }}>
                        slug: {p.productSlug}
                      </div>
                    </td>
                    <td>
                      <span className="badge badge-neutral mono">{p.channelSlug.toUpperCase()}</span>
                    </td>
                    <td className="mono bold">
                      {formatMinorUnits(
                        p.minEffectivePrice,
                        p.channelSlug.includes("eu") ? "EUR" : "USD"
                      )}
                    </td>
                    <td>
                      <span className="badge badge-ok mono">{p.totalAvailableQty} in stock</span>
                    </td>
                    <td style={{ fontSize: "0.8rem" }}>
                      {Object.entries(p.mergedAttributes)
                        .filter(([k]) => k !== "pimSource")
                        .map(([k, v]) => (
                          <span
                            key={k}
                            className="badge badge-neutral"
                            style={{ margin: "2px", fontSize: "0.7rem" }}
                          >
                            {k}: {String(v)}
                          </span>
                        ))}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Ingestion Audit Trail */}
      <section className="card" style={{ marginTop: "1.25rem" }}>
        <div className="section-title">
          <h2>PIM Pipeline Ingestion Audit Trail</h2>
          <span className="badge badge-info mono">{auditLogs.length} Records</span>
        </div>
        <div className="table-wrapper" style={{ marginTop: "0.75rem" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>SYNC ID</th>
                <th>SOURCE</th>
                <th>EXPORT ID</th>
                <th>LATENCY</th>
                <th>STATUS</th>
                <th>SUMMARY &amp; PRE-FLIGHT OUTCOME</th>
              </tr>
            </thead>
            <tbody>
              {auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "var(--muted)" }}>
                    No ingestion runs logged yet.
                  </td>
                </tr>
              ) : (
                auditLogs.map((log) => (
                  <tr key={log.syncId}>
                    <td className="mono bold">{log.syncId}</td>
                    <td style={{ fontSize: "0.8rem" }}>{log.systemSource}</td>
                    <td className="mono" style={{ fontSize: "0.8rem" }}>{log.exportId}</td>
                    <td className="mono">{log.durationUs} µs</td>
                    <td>
                      <span
                        className={`badge ${
                          log.status === "APPLIED"
                            ? "badge-ok"
                            : log.status === "ZERO_DIFF_NOOP"
                            ? "badge-info"
                            : "badge-warn"
                        }`}
                      >
                        {log.status}
                      </span>
                    </td>
                    <td style={{ fontSize: "0.8rem", maxWidth: "450px" }}>{log.summary}</td>
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
