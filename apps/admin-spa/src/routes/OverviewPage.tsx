import { useId, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdminRpcClient } from "../api/rpc-client.ts";
import { formatMinorUnits } from "../lib/money.ts";

export function OverviewPage({ rpc }: { readonly rpc: AdminRpcClient }) {
  const ledgerCaptionId = useId();
  const skuCaptionId = useId();

  const healthQuery = useQuery({
    queryKey: ["healthz"],
    queryFn: () => rpc.getHealth(),
  });

  const trialBalanceQuery = useQuery({
    queryKey: ["ledger", "trialBalance", "USD"],
    queryFn: () => rpc.ledger.getTrialBalance("USD"),
  });

  const skuAnalyticsQuery = useQuery({
    queryKey: ["orders", "analyticsBySku"],
    queryFn: () => rpc.orders.analyticsBySku(),
  });

  const tb = trialBalanceQuery.data;
  const skuRows = skuAnalyticsQuery.data ?? [];

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Operations & Double-Entry Subledger</h1>
          <p>
            Real-time financial trial balance, normalized SQL SKU revenue telemetry, and Rust
            kernel readiness.
          </p>
        </div>
        <div className="btn-row">
          <span className={`badge ${tb?.isBalanced !== false ? "badge-ok" : "badge-danger"}`}>
            {tb?.isBalanced !== false ? "Subledger Balanced (Dr == Cr)" : "Ledger Out of Balance"}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void healthQuery.refetch();
              void trialBalanceQuery.refetch();
              void skuAnalyticsQuery.refetch();
            }}
          >
            Refresh Telemetry
          </button>
        </div>
      </header>

      <section className="kpi-grid" aria-label="Key Financial and Engine Indicators" style={{ marginTop: "1.25rem" }}>
        <div className="card">
          <div className="kpi-label">Engine & Storage</div>
          <div className="kpi-value">{healthQuery.data?.version ?? "0.4.0"}</div>
          <div className="kpi-meta">
            DB: {healthQuery.data?.database ?? "loading"} ({healthQuery.data?.pgVersion ?? "Offline AST / PG17"})
          </div>
        </div>
        <div className="card">
          <div className="kpi-label">Grand Total Debits</div>
          <div className="kpi-value">
            {tb ? formatMinorUnits(tb.grandTotalDebits, tb.currencyCode) : "USD 0.00"}
          </div>
          <div className="kpi-meta">Immutable journal postings</div>
        </div>
        <div className="card">
          <div className="kpi-label">Grand Total Credits</div>
          <div className="kpi-value">
            {tb ? formatMinorUnits(tb.grandTotalCredits, tb.currencyCode) : "USD 0.00"}
          </div>
          <div className="kpi-meta">Zero-float BigInt accounting</div>
        </div>
        <div className="card">
          <div className="kpi-label">Active Revenue SKUs</div>
          <div className="kpi-value">{skuRows.length}</div>
          <div className="kpi-meta">Normalized order_lines SQL view</div>
        </div>
      </section>

      <div style={{ marginTop: "1.5rem" }} className="table-wrapper" tabIndex={0} role="region" aria-labelledby={ledgerCaptionId}>
        <table
          className="data-table"
          style={
            {
              "--col-2": '"Normal"',
              "--col-3": '"Debits"',
              "--col-4": '"Credits"',
              "--col-5": '"Net Balance"',
            } as CSSProperties
          }
        >
          <caption id={ledgerCaptionId}>Double-Entry Subledger Trial Balance (USD)</caption>
          <thead>
            <tr>
              <th scope="col">Account Code</th>
              <th scope="col">Normal</th>
              <th scope="col">Debits</th>
              <th scope="col">Credits</th>
              <th scope="col">Net Balance</th>
            </tr>
          </thead>
          <tbody>
            {(tb?.accounts ?? []).length === 0 ? (
              <tr>
                <th scope="row" className="mono">
                  NO_POSTINGS_YET
                </th>
                <td colSpan={4}>Complete a checkout or OMS order edit to record journal entries.</td>
              </tr>
            ) : (
              tb!.accounts.map((acc) => (
                <tr key={acc.accountCode}>
                  <th scope="row" className="mono">
                    {acc.accountCode}
                  </th>
                  <td>
                    <span className="badge">{acc.normalBalance}</span>
                  </td>
                  <td className="mono">{formatMinorUnits(acc.debitTotal, tb!.currencyCode)}</td>
                  <td className="mono">{formatMinorUnits(acc.creditTotal, tb!.currencyCode)}</td>
                  <td className="mono">{formatMinorUnits(acc.netBalance, tb!.currencyCode)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: "1.5rem" }} className="table-wrapper" tabIndex={0} role="region" aria-labelledby={skuCaptionId}>
        <table
          className="data-table"
          style={
            {
              "--col-2": '"Channel"',
              "--col-3": '"Units Sold"',
              "--col-4": '"Net Revenue"',
              "--col-5": '"Gross Revenue"',
            } as CSSProperties
          }
        >
          <caption id={skuCaptionId}>Normalized SKU Revenue & Tax Aggregation (order_lines)</caption>
          <thead>
            <tr>
              <th scope="col">Variant SKU</th>
              <th scope="col">Channel</th>
              <th scope="col">Units Sold</th>
              <th scope="col">Net Revenue</th>
              <th scope="col">Gross Revenue</th>
            </tr>
          </thead>
          <tbody>
            {skuRows.length === 0 ? (
              <tr>
                <th scope="row" className="mono">
                  EMPTY
                </th>
                <td colSpan={4}>No SKU revenue rows recorded yet.</td>
              </tr>
            ) : (
              skuRows.map((row) => (
                <tr key={`${row.channelSlug}:${row.variantId}:${row.currencyCode}`}>
                  <th scope="row" className="mono">
                    {row.variantId}
                  </th>
                  <td>{row.channelSlug}</td>
                  <td className="mono">{row.unitsSold}</td>
                  <td className="mono">{formatMinorUnits(row.totalNetAmount, row.currencyCode)}</td>
                  <td className="mono">{formatMinorUnits(row.totalGrossAmount, row.currencyCode)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
