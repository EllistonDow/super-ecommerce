/**
 * Commerce Backoffice Route Renderers (`overview`, `orders`, `order_detail`,
 * `catalog`, `discounts`, `inventory`, `b2b`) for `@super-ecommerce/admin`.
 *
 * Every HTML output must contain zero em-dashes and zero en-dashes.
 */

import { ADMIN_MUTATION_SCRIPT } from "./mutations.ts";
import {
  escapeHtml,
  fmtMoney,
} from "./shell.ts";
import type {
  AdminCatalogVariantView,
  AdminDashboardRenderInput,
  AdminVoucherRuleView,
} from "./types.ts";

function renderBanner(id: string, text: string): string {
  return `<div id="${escapeHtml(id)}" class="panel-banner mono" role="status" aria-live="polite">${escapeHtml(text)}</div>`;
}

function renderSseStreamPanel(input: AdminDashboardRenderInput): string {
  const telemetryEventsList = input.telemetryEvents ?? [];
  const telemetryRowsHtml =
    telemetryEventsList.length === 0
      ? `<tr><td colspan="5" class="empty-cell">Waiting for live SSE events on /api/admin/events. Execute a Checkout, RMA, Catalog, Voucher, Inventory, PO, Outbox, or Configurator action to see real-time frames.</td></tr>`
      : telemetryEventsList
          .slice(0, 12)
          .map((evt) => {
            const sevClass =
              evt.severity === "OK"
                ? "accent-green"
                : evt.severity === "WARN"
                ? "accent-amber"
                : "accent-blue";
            return `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(evt.eventId)}</td>
        <td class="mono ${sevClass}" style="white-space: nowrap;">${escapeHtml(evt.channel)}</td>
        <td style="font-weight: 600;">${escapeHtml(evt.summary)}</td>
        <td class="mono" style="color: var(--text-secondary); max-width: 280px; word-break: break-word;">${escapeHtml(evt.detail ?? "-")}</td>
        <td class="mono num" style="white-space: nowrap; color: var(--text-muted);">${escapeHtml(evt.timestampIso.replace(/^.*T/, ""))}</td>
      </tr>`;
          })
          .join("");

  return `
    <section class="panel" aria-label="Live Server-Sent Events Telemetry Stream">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Live Server-Sent Events (SSE) Telemetry Stream (/api/admin/events)</h2>
          <p class="panel-subtitle">
            Real-time push feed across Checkout Sagas, RMA Returns, Catalog, Discounts, Inventory, B2B POs, Outbox &amp; Configurator
          </p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-sse-ping" class="btn" style="color: var(--accent-green);">Emit Telemetry Ping</button>
          <button type="button" id="btn-sse-toggle" class="btn" style="color: var(--accent-blue);">Pause Stream</button>
          <button type="button" id="btn-sse-clear" class="btn">Clear Buffer</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Event ID</th>
              <th>Stream Channel</th>
              <th>Live Domain Event</th>
              <th>Structured Telemetry Payload</th>
              <th class="num">UTC Time</th>
            </tr>
          </thead>
          <tbody id="sse-events-tbody">
            ${telemetryRowsHtml}
          </tbody>
        </table>
      </div>
    </section>`;
}

export function renderOverviewRoute(input: AdminDashboardRenderInput): {
  readonly bodyHtml: string;
  readonly extraScriptHtml: string;
} {
  const totalOrdersCount = input.orders.length;
  const totalGmvMinor = input.orders.reduce(
    (sum, o) => sum + BigInt(o.pricing.totalGrossAmount),
    0n
  );
  const totalAvailUnits = input.stockSlots.reduce(
    (sum, s) => sum + Math.max(0, s.quantityOnHand - s.quantityReserved - s.quantityAllocated),
    0
  );
  const totalHeldUnits = input.stockSlots.reduce(
    (sum, s) => sum + s.quantityReserved + s.quantityAllocated,
    0
  );
  const b2bPos = input.b2bPurchaseOrders ?? [];
  const pendingPos = b2bPos.filter((p) => p.status === "PENDING_APPROVAL");
  const activeCompany = (input.b2bCompanies ?? [])[0];
  const availCredit = activeCompany
    ? activeCompany.creditLimit - activeCompany.creditUsed - activeCompany.creditReserved
    : 0n;
  const activeVouchers = (input.vouchers ?? []).filter((v) => v.isActive).length;
  const channelsCount = (input.channels ?? []).length || 2;

  const recentOrdersHtml =
    input.orders.length === 0
      ? `<tr><td colspan="4" class="empty-cell">No orders committed yet. Run a Saga checkout from <a href="/admin/orders" class="accent-blue">Orders</a> or the <a href="/" class="accent-blue">Storefront</a>.</td></tr>`
      : input.orders
          .slice(0, 6)
          .map((ord) => {
            const stClass =
              ord.paymentStatus === "REFUNDED" || ord.paymentStatus === "FAILED"
                ? "accent-amber"
                : "accent-green";
            return `
          <tr>
            <td class="mono"><a href="/admin/orders/${encodeURIComponent(ord.orderId)}" class="accent-blue">${escapeHtml(ord.orderId)}</a></td>
            <td class="mono">${escapeHtml(ord.channelSlug)}</td>
            <td class="mono num">${fmtMoney(ord.pricing.totalGrossAmount, ord.pricing.currencyCode)}</td>
            <td class="mono ${stClass}">${escapeHtml(ord.paymentStatus ?? "CAPTURED")}</td>
          </tr>`;
          })
          .join("");

  const pendingPoRowsHtml =
    b2bPos.length === 0
      ? `<tr><td colspan="4" class="empty-cell">No B2B Purchase Orders submitted yet. Visit <a href="/admin/b2b" class="accent-blue">B2B &amp; Credit</a> to create or approve POs.</td></tr>`
      : b2bPos
          .slice(0, 6)
          .map((po) => {
            const isPending = po.status === "PENDING_APPROVAL";
            const stClass = isPending
              ? "accent-amber"
              : po.status === "APPROVED_AUTO" || po.status === "APPROVED_BY_SUPERVISOR"
              ? "accent-green"
              : "accent-blue";
            return `
          <tr>
            <td class="mono accent-blue">${escapeHtml(po.poNumber)}</td>
            <td>${escapeHtml(po.buyerName)}</td>
            <td class="mono num">${fmtMoney(po.pricing.totalGrossAmount)}</td>
            <td class="mono ${stClass}">
              ${escapeHtml(po.status.replaceAll("_", " "))}
              ${
                isPending
                  ? `<div style="margin-top: 4px; display: flex; gap: 4px;">
                       <button type="button" class="btn" data-b2b-approve="${escapeHtml(po.poId)}" style="padding: 2px 8px; font-size: 11px; color: var(--accent-green);">Approve</button>
                       <button type="button" class="btn" data-b2b-reject="${escapeHtml(po.poId)}" style="padding: 2px 8px; font-size: 11px; color: var(--accent-amber);">Reject</button>
                     </div>`
                  : ""
              }
            </td>
          </tr>`;
          })
          .join("");

  const bodyHtml = `
    <section class="kpi-grid" aria-label="Merchant Operations Key Metrics">
      <div class="kpi-card">
        <div class="kpi-label">Orders Committed</div>
        <div class="kpi-value mono">${totalOrdersCount}</div>
        <div class="kpi-meta mono">GMV: ${fmtMoney(totalGmvMinor, "USD")}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">MSI Available Units</div>
        <div class="kpi-value mono accent-green">${totalAvailUnits}</div>
        <div class="kpi-meta mono">Reserved + Allocated: ${totalHeldUnits}u across ${input.stockSlots.length} slots</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Pending B2B PO Approvals</div>
        <div class="kpi-value mono ${pendingPos.length > 0 ? "accent-amber" : "accent-blue"}">${pendingPos.length}</div>
        <div class="kpi-meta mono">Net-30 Pool Avail: ${fmtMoney(availCredit, "USD")}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Active Channels &amp; Promos</div>
        <div class="kpi-value mono">${channelsCount} / ${activeVouchers}</div>
        <div class="kpi-meta mono">Outbox Pending: ${input.pendingOutboxEvents.length} | DLQ: ${input.outboxStats?.deadLetterCount ?? 0}</div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Quick Operational Workflows</h2>
          <p class="panel-subtitle">Jump directly to day-to-day merchant workflows or trigger a live end-to-end sample checkout</p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-overview-checkout" class="btn btn-primary">Execute 5-Step Saga Checkout</button>
          <a href="/admin/catalog" class="btn">Edit Catalog &amp; Prices</a>
          <a href="/admin/discounts" class="btn">Manage Vouchers</a>
          <a href="/admin/inventory" class="btn">Adjust Warehouse Stock</a>
          <a href="/admin/lab" class="btn">Engineering Lab</a>
        </div>
      </div>
    </section>

    ${renderSseStreamPanel(input)}

    <section class="split-grid">
      <div class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Recent Orders</h2>
            <p class="panel-subtitle">Click any Order ID to inspect Two-Pass Hare-Niemeyer attribution or execute partial RMA refunds</p>
          </div>
          <a href="/admin/orders" class="btn">All Orders</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Channel</th>
                <th class="num">Total Gross</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${recentOrdersHtml}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">B2B Purchase Orders &amp; Holds</h2>
            <p class="panel-subtitle">Supervisor approval releases 72h MSI hold into confirmed order</p>
          </div>
          <a href="/admin/b2b" class="btn">Open B2B</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>PO Number</th>
                <th>Buyer</th>
                <th class="num">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${pendingPoRowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;

  const extraScriptHtml = `
  <script type="module">
    ${ADMIN_MUTATION_SCRIPT}
    document.getElementById("btn-overview-checkout")?.addEventListener("click", async () => {
      const btn = document.getElementById("btn-overview-checkout");
      if (btn) btn.textContent = "Executing 5-Step Saga...";
      await fetch("/api/demo/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelSlug: "us-retail", scenario: "healthy_5step_saga" }),
      });
      window.location.reload();
    });

    document.addEventListener("click", async (e) => {
      const appBtn = e.target.closest("button[data-b2b-approve]");
      if (appBtn) {
        const poId = appBtn.getAttribute("data-b2b-approve");
        if (poId) {
          appBtn.textContent = "Approving...";
          await fetch("/api/demo/b2b", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "approve_latest_pending_po", poId }),
          });
          window.location.reload();
        }
        return;
      }
      const rejBtn = e.target.closest("button[data-b2b-reject]");
      if (rejBtn) {
        const poId = rejBtn.getAttribute("data-b2b-reject");
        if (poId) {
          rejBtn.textContent = "Rejecting...";
          await fetch("/api/demo/b2b", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "reject_latest_pending_po", poId }),
          });
          window.location.reload();
        }
      }
    });
  </script>`;

  return { bodyHtml, extraScriptHtml };
}

export function renderOrdersRoute(input: AdminDashboardRenderInput): {
  readonly bodyHtml: string;
  readonly extraScriptHtml: string;
} {
  const filterQ = (input.ordersFilterQuery ?? "").trim().toLowerCase();
  const filterStatus = (input.ordersFilterStatus ?? "ALL").toUpperCase();

  const filteredOrders = input.orders.filter((ord) => {
    const status = (ord.paymentStatus ?? "CAPTURED").toUpperCase();
    if (filterStatus !== "ALL" && status !== filterStatus) return false;
    if (!filterQ) return true;
    const haystack = [
      ord.orderId,
      ord.checkoutId,
      ord.channelSlug,
      ord.paymentTransactionId ?? "",
      ord.storeCreditLedgerTxId ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(filterQ);
  });

  const orderRowsHtml =
    filteredOrders.length === 0
      ? `<tr><td colspan="7" class="empty-cell">No matching orders found. Clear filters or execute a 5-Step Saga Checkout below.</td></tr>`
      : filteredOrders
          .map(
            (ord) => `
      <tr>
        <td class="mono" style="white-space: nowrap;"><a href="/admin/orders/${encodeURIComponent(ord.orderId)}" class="accent-blue">${escapeHtml(ord.orderId)}</a></td>
        <td class="mono">${escapeHtml(ord.channelSlug)}</td>
        <td class="mono" style="max-width: 190px; word-break: break-word;">${escapeHtml(ord.paymentTransactionId ?? "STORE_CREDIT")}${ord.storeCreditLedgerTxId ? ` + ${escapeHtml(ord.storeCreditLedgerTxId)}` : ""}</td>
        <td class="mono">${escapeHtml(ord.shipments.map((s) => `${s.warehouseId}(${s.quantityAllocated})`).join(", "))}</td>
        <td class="mono num">${escapeHtml(ord.pricing.currencyCode)} ${(Number(ord.pricing.totalGrossAmount) / 100).toFixed(2)}</td>
        <td class="mono ${ord.paymentStatus === "REFUNDED" || ord.paymentStatus === "FAILED" ? "accent-amber" : "accent-green"}" style="white-space: nowrap;">${escapeHtml(ord.paymentStatus ?? "CAPTURED")}</td>
        <td class="num" style="white-space: nowrap;">
          <a href="/admin/orders/${encodeURIComponent(ord.orderId)}" class="btn" style="padding: 3px 10px; font-size: 11px;">Inspect &amp; RMA</a>
        </td>
      </tr>`
          )
          .join("");

  const workflowRunsList = input.workflowRuns ?? [];
  const workflowRunRowsHtml =
    workflowRunsList.length === 0
      ? `<tr><td colspan="5" class="empty-cell">No Saga workflow runs recorded yet. Use the Saga simulation buttons above to test 5-step execution &amp; LIFO reverse compensation.</td></tr>`
      : workflowRunsList
          .map((run) => {
            const statusClass =
              run.status === "COMPLETED"
                ? "accent-green"
                : run.status === "COMPENSATED"
                ? "accent-amber"
                : "accent-blue";
            const forwardTrace = run.steps
              .map(
                (s) =>
                  `${s.stepOrder}.${s.stepName}(${s.status === "COMPENSATED" ? "COMP" : "OK"})`
              )
              .join(" -> ");
            const lifoTrace =
              run.compensatedLifoChain.length > 0
                ? run.compensatedLifoChain.join(" -> ")
                : "NONE (All 5 Steps Committed)";
            const faultDiag = run.errorMessage
              ? run.errorMessage
              : `Committed (${run.steps.length}/5 steps)`;
            return `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(run.idempotencyKey)}</td>
        <td class="mono" style="max-width: 220px; word-break: break-word; color: var(--text-secondary);">${escapeHtml(forwardTrace)}</td>
        <td class="mono ${run.compensatedLifoChain.length > 0 ? "accent-amber" : "accent-green"}" style="max-width: 190px; word-break: break-word;">${escapeHtml(lifoTrace)}</td>
        <td class="mono" style="max-width: 165px; word-break: break-word; color: var(--text-secondary);">${escapeHtml(faultDiag)}</td>
        <td class="mono ${statusClass}" style="white-space: nowrap;">${escapeHtml(run.status)}</td>
      </tr>`;
          })
          .join("");

  const rmaList = input.rmaReturns ?? [];
  const rmaRowsHtml =
    rmaList.length === 0
      ? `<tr><td colspan="6" class="empty-cell">No RMA partial returns executed yet. Click 3-Wave Penny Reconcile (334+333+333) above or inspect any order detail page.</td></tr>`
      : rmaList
          .map((rma) => {
            const sym = rma.currencyCode === "EUR" ? "€" : "$";
            const fmtCents = (v: bigint) => `${sym}${(Number(v) / 100).toFixed(2)}`;
            const lineSummary = rma.calculation.lines
              .filter((l) => l.acceptedReturnQuantity > 0)
              .map(
                (l) =>
                  `${l.variantId} x${l.acceptedReturnQuantity}/${l.originalQuantity}${
                    l.isFinalUnitReconciliation ? " [FINAL_CEILING]" : ""
                  }`
              )
              .join(", ");
            const msiSummary =
              rma.restockedSlices.length === 0
                ? "0 units"
                : rma.restockedSlices
                    .map((s) => `${s.warehouseId}: +${s.quantityReturned} (${s.condition})`)
                    .join(", ");
            const feeTag =
              rma.calculation.totalRestockingFeeAmount > 0n
                ? ` | Fee -${fmtCents(rma.calculation.totalRestockingFeeAmount)}`
                : "";
            const stClass =
              rma.orderPaymentStatusAfter === "REFUNDED"
                ? "accent-green"
                : "accent-blue";
            return `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(rma.rmaId)}</td>
        <td class="mono" style="white-space: nowrap;"><a href="/admin/orders/${encodeURIComponent(rma.orderId)}" class="accent-blue">${escapeHtml(rma.orderId)}</a></td>
        <td class="mono">${escapeHtml(lineSummary)}</td>
        <td class="mono">${escapeHtml(msiSummary)}</td>
        <td class="mono">
          <span class="accent-green">${fmtCents(rma.calculation.totalRefundGrossAmount)}</span>
          <span style="color: var(--text-secondary); font-size: 11px;"> (Cash ${fmtCents(rma.calculation.paymentGatewayRefundAmount)} / SC ${fmtCents(rma.calculation.storeCreditRefundAmount)}${feeTag})</span>
        </td>
        <td class="mono ${stClass}" style="white-space: nowrap;">${escapeHtml(rma.orderPaymentStatusAfter)}</td>
      </tr>`;
          })
          .join("");

  const bodyHtml = `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Committed Orders Ledger</h2>
          <p class="panel-subtitle">Showing ${filteredOrders.length} of ${input.ordersPagination ? input.ordersPagination.totalMatchingCount : input.orders.length} committed order(s)</p>
        </div>
        <form method="GET" action="/admin/orders" class="panel-actions">
          <input type="text" name="q" value="${escapeHtml(input.ordersFilterQuery ?? "")}" placeholder="Search Order ID, TX, Channel..." class="field-input mono" style="width: 220px;" />
          <select name="status" class="field-select mono" style="width: 170px;">
            <option value="ALL" ${filterStatus === "ALL" ? "selected" : ""}>All Statuses</option>
            <option value="CAPTURED" ${filterStatus === "CAPTURED" ? "selected" : ""}>CAPTURED</option>
            <option value="PARTIALLY_REFUNDED" ${filterStatus === "PARTIALLY_REFUNDED" ? "selected" : ""}>PARTIALLY_REFUNDED</option>
            <option value="REFUNDED" ${filterStatus === "REFUNDED" ? "selected" : ""}>REFUNDED</option>
          </select>
          <button type="submit" class="btn btn-primary">Filter Orders</button>
        </form>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Order ID</th>
              <th>Channel</th>
              <th>Payment TX &amp; Store Credit</th>
              <th>MSI Warehouse Splits</th>
              <th class="num">Total Gross</th>
              <th>Status</th>
              <th class="num">Action</th>
            </tr>
          </thead>
          <tbody>
            ${orderRowsHtml}
          </tbody>
        </table>
      </div>
      ${
        input.ordersPagination
          ? `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-top: 1px solid var(--border-hairline, #E2E8F0); flex-wrap: wrap; gap: 8px;">
        <div>
          ${
            input.ordersPagination.hasPrev && input.ordersPagination.prevCursor
              ? `<a href="/admin/orders?q=${encodeURIComponent(input.ordersFilterQuery ?? "")}&status=${encodeURIComponent(input.ordersFilterStatus ?? "ALL")}&limit=${input.ordersPagination.limit}&cursor=${encodeURIComponent(input.ordersPagination.prevCursor)}&direction=prev" class="btn">&lt; Previous</a>`
              : `<span class="btn" style="opacity: 0.45; cursor: not-allowed;">&lt; Previous</span>`
          }
        </div>
        <span class="mono" style="font-size: 12px; color: var(--text-secondary);">
          Showing ${filteredOrders.length} of ${input.ordersPagination.totalMatchingCount} committed order(s) (Page limit: ${input.ordersPagination.limit})
        </span>
        <div>
          ${
            input.ordersPagination.hasMore && input.ordersPagination.nextCursor
              ? `<a href="/admin/orders?q=${encodeURIComponent(input.ordersFilterQuery ?? "")}&status=${encodeURIComponent(input.ordersFilterStatus ?? "ALL")}&limit=${input.ordersPagination.limit}&cursor=${encodeURIComponent(input.ordersPagination.nextCursor)}&direction=next" class="btn">Next &gt;</a>`
              : `<span class="btn" style="opacity: 0.45; cursor: not-allowed;">Next &gt;</span>`
          }
        </div>
      </div>`
          : ""
      }
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Durable Saga Orders &amp; LIFO Reverse Compensation</h2>
          <p class="panel-subtitle">
            Store Credit (${escapeHtml(input.sagaAuditMetrics?.customerId ?? "cust_vip_01")}): ${escapeHtml(input.sagaAuditMetrics?.storeCreditBalanceFormatted ?? "$500.00")} (Deducted: ${input.sagaAuditMetrics?.storeCreditDeductCount ?? 0} / Restored: ${input.sagaAuditMetrics?.storeCreditRestoredCount ?? 0}) | Stripe Gateway: ${input.sagaAuditMetrics?.paymentCapturedCount ?? 0} Captured / ${input.sagaAuditMetrics?.paymentDeclinedAttemptsCount ?? 0} Declined / ${input.sagaAuditMetrics?.paymentVoidedCount ?? 0} Voided | PG Mirror: ${input.pgWorkflowMirror?.connected ? `SYNCED (${input.pgWorkflowMirror.pgCompletedRuns} Completed / ${input.pgWorkflowMirror.pgCompensatedRuns} Compensated)` : "LOCAL SQL"}
          </p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-saga-healthy" class="btn" style="color: var(--accent-green);">Execute 5-Step Saga</button>
          <button type="button" id="btn-saga-step4" class="btn" style="color: var(--accent-amber);">Step 4 Decline -&gt; 2-Step LIFO</button>
          <button type="button" id="btn-saga-step5" class="btn" style="color: var(--accent-amber);">Step 5 Fault -&gt; 3-Step LIFO + Void</button>
          <button type="button" id="btn-saga-replay" class="btn" style="color: var(--accent-blue);">Replay Idempotent Key</button>
        </div>
      </div>
      ${renderBanner("saga-sim-banner", input.sagaSimulationSummary ?? "Ready: 5-Step Durable Saga (verify-pricing -> allocate-inventory -> redeem-store-credit -> capture-payment -> commit-order-and-outbox) | LIFO Compensation Stack Active")}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Idempotency Key</th>
              <th>Forward Step Execution Trace</th>
              <th>LIFO Reverse Compensation Stack</th>
              <th>Fault / Commit Outcome</th>
              <th>Saga Run Status</th>
            </tr>
          </thead>
          <tbody>
            ${workflowRunRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">RMA Partial Return &amp; Penny Ceiling Reconciliation Engine</h2>
          <p class="panel-subtitle">
            Rust N-API Hare-Niemeyer Unit Slicing + Final-Unit Ceiling Reconciliation (334 + 333 + 333 == 1000 cents) | MSI Restock vs Damaged Quarantine
          </p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-rma-3wave" class="btn" style="color: var(--accent-green);">3-Wave Penny Reconcile (334+333+333)</button>
          <button type="button" id="btn-rma-quarantine" class="btn" style="color: var(--accent-blue);">Quarantine Restock (-15% Fee)</button>
          <button type="button" id="btn-rma-fault" class="btn" style="color: var(--accent-amber);">Step 5 Fault -&gt; 3-Step RMA LIFO</button>
        </div>
      </div>
      ${renderBanner("rma-sim-banner", input.rmaSimulationSummary ?? "Ready: 5-Step RMA Saga (verify-rma-calculation -> restock-msi-inventory -> restore-store-credit -> refund-payment-gateway -> commit-rma-and-outbox)")}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>RMA ID</th>
              <th>Order ID</th>
              <th>Returned Lines &amp; Ceiling Flag</th>
              <th>MSI Restock / Quarantine</th>
              <th>Refund Breakdown (Cash / Store Credit / Fee)</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${rmaRowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  `;

  const extraScriptHtml = `
  <script type="module">
    ${ADMIN_MUTATION_SCRIPT}
    async function runSagaScenario(scenario, btnId, busyLabel) {
      const btn = btnId ? document.getElementById(btnId) : null;
      if (btn && busyLabel) btn.textContent = busyLabel;
      await fetch("/api/demo/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelSlug: "us-retail", scenario }),
      });
      window.location.reload();
    }

    document.getElementById("btn-saga-healthy")?.addEventListener("click", () =>
      runSagaScenario("healthy_5step_saga", "btn-saga-healthy", "Running 5-Step Saga...")
    );
    document.getElementById("btn-saga-step4")?.addEventListener("click", () =>
      runSagaScenario("step4_payment_decline_lifo", "btn-saga-step4", "Compensating 2-Step LIFO...")
    );
    document.getElementById("btn-saga-step5")?.addEventListener("click", () =>
      runSagaScenario("step5_commit_fault_lifo", "btn-saga-step5", "Voiding & 3-Step LIFO...")
    );
    document.getElementById("btn-saga-replay")?.addEventListener("click", () =>
      runSagaScenario("idempotent_crash_replay", "btn-saga-replay", "Replaying Idempotent Key...")
    );

    async function runRmaScenario(scenario, btnId, busyLabel) {
      const btn = btnId ? document.getElementById(btnId) : null;
      if (btn && busyLabel) btn.textContent = busyLabel;
      await fetch("/api/demo/rma", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      window.location.reload();
    }

    document.getElementById("btn-rma-3wave")?.addEventListener("click", () =>
      runRmaScenario("3wave_penny_reconcile", "btn-rma-3wave", "Reconciling 3 Waves (334+333+333)...")
    );
    document.getElementById("btn-rma-quarantine")?.addEventListener("click", () =>
      runRmaScenario("damaged_quarantine_restock", "btn-rma-quarantine", "Quarantining Damaged Unit...")
    );
    document.getElementById("btn-rma-fault")?.addEventListener("click", () =>
      runRmaScenario("rma_commit_fault_lifo", "btn-rma-fault", "Compensating 3-Step RMA LIFO...")
    );
  </script>`;

  return { bodyHtml, extraScriptHtml };
}

export function renderOrderDetailRoute(input: AdminDashboardRenderInput): {
  readonly bodyHtml: string;
  readonly extraScriptHtml: string;
} {
  const order = input.selectedOrder;
  if (!order) {
    return {
      bodyHtml: `
        <section class="panel">
          <div class="panel-body" style="text-align: center; padding: 36px 20px;">
            <h2 class="panel-title" style="margin-bottom: 8px;">Order Not Found</h2>
            <p class="panel-subtitle" style="margin-bottom: 16px;">The requested order ID does not exist in the current ledger.</p>
            <a href="/admin/orders" class="btn btn-primary">Back to Orders Ledger</a>
          </div>
        </section>`,
      extraScriptHtml: "",
    };
  }

  const currency = order.pricing.currencyCode;
  const priorReturns = input.selectedOrderReturns ?? [];
  const returnedQtyByLine: Record<string, number> = {};
  for (const rma of priorReturns) {
    for (const ln of rma.calculation.lines) {
      returnedQtyByLine[ln.lineId] = (returnedQtyByLine[ln.lineId] ?? 0) + ln.acceptedReturnQuantity;
    }
  }

  const totalOrderDiscountAmount = order.pricing.lines.reduce(
    (s, l) => s + BigInt(l.allocatedOrderDiscountAmount),
    0n
  );

  const lineRowsHtml = order.pricing.lines
    .map((ln) => {
      const returnedSoFar = returnedQtyByLine[ln.lineId] ?? 0;
      const returnable = Math.max(0, ln.quantity - returnedSoFar);
      const isGift = Boolean(ln.isGift);
      return `
      <tr>
        <td class="mono accent-blue">${escapeHtml(ln.lineId)}</td>
        <td class="mono">${escapeHtml(ln.variantId)} ${isGift ? '<span class="pill accent-green">GIFT (isGift=true)</span>' : ""}</td>
        <td class="mono num">${ln.quantity} (${returnedSoFar} ret / ${returnable} left)</td>
        <td class="mono num">${fmtMoney(ln.effectiveBaseUnitPrice, currency)}</td>
        <td class="mono num accent-blue">${fmtMoney(ln.lineLevelDiscountAmount, currency)}</td>
        <td class="mono num accent-amber">${fmtMoney(ln.allocatedOrderDiscountAmount, currency)}</td>
        <td class="mono num">${fmtMoney(ln.totalTaxAmount, currency)}</td>
        <td class="mono num accent-green">${fmtMoney(ln.totalGrossAmount, currency)}</td>
      </tr>`;
    })
    .join("");

  const shipmentRowsHtml =
    order.shipments.length === 0
      ? `<tr><td colspan="4" class="empty-cell">No MSI warehouse allocations recorded for this order.</td></tr>`
      : order.shipments
          .map((s) => {
            const rank = input.warehousePriorityById?.[s.warehouseId] ?? 1;
            return `
          <tr>
            <td class="mono accent-blue">${escapeHtml(s.warehouseId)}</td>
            <td class="mono">#${rank}</td>
            <td class="mono">${escapeHtml(s.variantId)} (${escapeHtml(s.lineId)})</td>
            <td class="mono num accent-green">${s.quantityAllocated}u</td>
          </tr>`;
          })
          .join("");

  const rmaRowsHtml =
    priorReturns.length === 0
      ? `<tr><td colspan="5" class="empty-cell">No returns recorded for this order yet. Submit a partial or full RMA return below.</td></tr>`
      : priorReturns
          .map((rma) => {
            const linesDesc = rma.calculation.lines
              .filter((l) => l.acceptedReturnQuantity > 0)
              .map(
                (l) =>
                  `${l.lineId} (${l.variantId}) x${l.acceptedReturnQuantity}${
                    l.isFinalUnitReconciliation ? " [FINAL_CEILING]" : ""
                  }`
              )
              .join(", ");
            const restockDesc = rma.restockedSlices
              .map((s) => `${s.warehouseId}: +${s.quantityReturned} (${s.condition})`)
              .join(", ");
            return `
          <tr>
            <td class="mono accent-blue">${escapeHtml(rma.rmaId)}</td>
            <td class="mono">${escapeHtml(linesDesc)}</td>
            <td class="mono">${escapeHtml(restockDesc || "0 units")}</td>
            <td class="mono num accent-green">${fmtMoney(rma.calculation.totalRefundGrossAmount, rma.currencyCode)}</td>
            <td class="mono">${escapeHtml(rma.orderPaymentStatusAfter)}</td>
          </tr>`;
          })
          .join("");

  const returnableLinesOptions = order.pricing.lines
    .filter((ln) => !ln.isGift)
    .map((ln) => {
      const rem = Math.max(0, ln.quantity - (returnedQtyByLine[ln.lineId] ?? 0));
      return `<option value="${escapeHtml(ln.lineId)}" data-max="${rem}" ${rem === 0 ? "disabled" : ""}>${escapeHtml(ln.lineId)} / ${escapeHtml(ln.variantId)} (${rem} returnable)</option>`;
    })
    .join("");

  const hasAnyReturnable = order.pricing.lines.some(
    (ln) => !ln.isGift && ln.quantity - (returnedQtyByLine[ln.lineId] ?? 0) > 0
  );

  const channelTaxMode =
    input.channels?.find((c) => c.slug === order.channelSlug)?.taxInclusionMode ??
    "TAX_EXCLUSIVE";

  const bodyHtml = `
    <section class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Order Gross Total</div>
        <div class="kpi-value mono accent-green">${fmtMoney(order.pricing.totalGrossAmount, currency)}</div>
        <div class="kpi-meta mono">Channel: ${escapeHtml(order.channelSlug)} (${escapeHtml(channelTaxMode)})</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Order-Level Discount (Pass A)</div>
        <div class="kpi-value mono accent-amber">${fmtMoney(totalOrderDiscountAmount, currency)}</div>
        <div class="kpi-meta mono">Distributed in Pass B via Hare-Niemeyer</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Payment &amp; Store Credit</div>
        <div class="kpi-value mono">${fmtMoney(order.paymentCapturedAmount ?? 0n, currency)}</div>
        <div class="kpi-meta mono">Store Credit Used: ${fmtMoney(order.storeCreditRedeemedAmount ?? 0n, currency)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Fulfillment Status</div>
        <div class="kpi-value mono ${order.fulfillmentStatus === "FULFILLED" ? "accent-green" : order.fulfillmentStatus === "CANCELLED" ? "accent-amber" : "accent-blue"}">${escapeHtml(order.fulfillmentStatus ?? "UNFULFILLED")}</div>
        <div class="kpi-meta mono">Payment: ${escapeHtml(order.paymentStatus ?? "CAPTURED")} | TX: ${escapeHtml(order.paymentTransactionId ?? "STORE_CREDIT")}</div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Order Lifecycle &amp; Fulfillment Dispatch</h2>
          <p class="panel-subtitle">Transactional order state machine backed by PostgreSQL 17 primary ledger</p>
        </div>
      </div>
      <div class="panel-body">
        ${
          order.fulfillmentStatus === "FULFILLED"
            ? `<div class="mono accent-green" style="padding: 12px; background: rgba(16, 185, 129, 0.08); border-radius: 6px; border: 1px solid rgba(16, 185, 129, 0.2);">
                 Order has been dispatched and marked FULFILLED. Stock allocations have been deducted from MSI physical inventory. To process customer returns, submit an RMA below.
               </div>`
            : order.fulfillmentStatus === "CANCELLED"
            ? `<div class="mono accent-amber" style="padding: 12px; background: rgba(245, 158, 11, 0.08); border-radius: 6px; border: 1px solid rgba(245, 158, 11, 0.2);">
                 Order is CANCELLED. All MSI stock reservations and allocations have been released back to the available pool, and payment has been voided/refunded.
               </div>`
            : `
            <div class="split-grid" style="gap: 16px;">
              <div style="padding: 16px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--panel-bg-subtle, rgba(255,255,255,0.02));">
                <h3 style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">Dispatch Shipment</h3>
                <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">Deducts physical MSI inventory and marks order FULFILLED.</p>
                <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;">
                  <div>
                    <label class="field-label" for="fulfill-carrier">Carrier</label>
                    <input id="fulfill-carrier" type="text" value="DHL Express" class="field-input mono" />
                  </div>
                  <div>
                    <label class="field-label" for="fulfill-tracking">Tracking #</label>
                    <input id="fulfill-tracking" type="text" placeholder="TRACK-AUTO" class="field-input mono" />
                  </div>
                </div>
                <button type="button" id="btn-dispatch-fulfillment" class="btn btn-primary btn-press" style="width: 100%;">Dispatch Fulfillment</button>
                <div id="fulfillment-status-msg" class="mono" role="status" aria-live="polite" style="margin-top: 8px; font-size: 12px; color: var(--text-secondary);"></div>
              </div>

              <div style="padding: 16px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--panel-bg-subtle, rgba(255,255,255,0.02));">
                <h3 style="font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--accent-amber);">Cancel Pre-Fulfillment Order</h3>
                <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">Releases allocated stock back to available pool and voids payment.</p>
                <div style="margin-bottom: 12px;">
                  <label class="field-label" for="cancel-reason">Cancellation Reason</label>
                  <input id="cancel-reason" type="text" value="Customer requested cancellation before shipment" class="field-input mono" />
                </div>
                <button type="button" id="btn-cancel-order" class="btn btn-press" style="width: 100%; border-color: var(--accent-amber); color: var(--accent-amber);">Cancel Order &amp; Release Stock</button>
                <div id="cancel-status-msg" class="mono" role="status" aria-live="polite" style="margin-top: 8px; font-size: 12px; color: var(--text-secondary);"></div>
              </div>
            </div>`
        }
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Two-Pass Hare-Niemeyer Price Waterfall (Saleor Core Invariant)</h2>
          <p class="panel-subtitle">
            Pass A collapses order-level discounts into subtotal_discount; Pass B apportions across lines proportionally with final line absorbing integer rounding remainder
          </p>
        </div>
        <a href="/admin/orders" class="btn">Back to Orders</a>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Line ID</th>
              <th>Variant SKU</th>
              <th class="num">Qty (Ret / Left)</th>
              <th class="num">Base Unit</th>
              <th class="num">Line Promo</th>
              <th class="num">Pass B Order Disc</th>
              <th class="num">Tax</th>
              <th class="num">Line Gross</th>
            </tr>
          </thead>
          <tbody>
            ${lineRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="split-grid">
      <div class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">MSI Warehouse Fulfillment Slices</h2>
            <p class="panel-subtitle">Allocated inventory deductions committed during Step 2</p>
          </div>
          <a href="/admin/inventory" class="btn">View Inventory</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Warehouse</th>
                <th>Priority</th>
                <th>SKU / Line</th>
                <th class="num">Allocated</th>
              </tr>
            </thead>
            <tbody>
              ${shipmentRowsHtml}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Execute Admin RMA Partial Return &amp; Refund</h2>
            <p class="panel-subtitle">LIFO refund priority: Cash gateway refunded before Store Credit restoration</p>
          </div>
        </div>
        <div class="panel-body">
          ${
            hasAnyReturnable
              ? `
          <form id="admin-order-rma-form" class="form-grid" data-order-id="${escapeHtml(order.orderId)}">
            <div>
              <label class="field-label" for="rma-line-id">Order Line</label>
              <select id="rma-line-id" class="field-select mono">
                ${returnableLinesOptions}
              </select>
            </div>
            <div>
              <label class="field-label" for="rma-qty">Return Quantity</label>
              <input id="rma-qty" type="number" min="1" value="1" class="field-input mono" />
            </div>
            <div>
              <label class="field-label" for="rma-condition">Restock Condition</label>
              <select id="rma-condition" class="field-select mono">
                <option value="RESELLABLE">RESELLABLE (Return to Available)</option>
                <option value="DAMAGED_QUARANTINE">DAMAGED_QUARANTINE (Hold Quarantine)</option>
              </select>
            </div>
            <div>
              <label class="field-label" for="rma-fee-bps">Restocking Fee (bps)</label>
              <input id="rma-fee-bps" type="number" min="0" max="5000" value="0" class="field-input mono" />
            </div>
            <div>
              <button type="submit" id="btn-execute-admin-rma" class="btn btn-primary" style="width: 100%;">Execute RMA Refund</button>
            </div>
          </form>
          <div id="admin-rma-status" class="mono" role="status" aria-live="polite" style="margin-top: 10px; font-size: 12px; color: var(--text-secondary);"></div>`
              : `<div class="mono accent-green">All line quantities on this order have already been returned and reconciled.</div>`
          }
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">RMA Return &amp; Penny Ceiling Ledger for ${escapeHtml(order.orderId)}</h2>
          <p class="panel-subtitle">${priorReturns.length} return wave(s) processed</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>RMA ID</th>
              <th>Returned Lines &amp; Ceiling Flag</th>
              <th>MSI Restock</th>
              <th class="num">Total Refund</th>
              <th>Order Status After</th>
            </tr>
          </thead>
          <tbody>
            ${rmaRowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  `;

  const extraScriptHtml = `
  <script type="module">
    ${ADMIN_MUTATION_SCRIPT}
    const orderId = "${escapeHtml(order.orderId)}";

    const btnFulfill = document.getElementById("btn-dispatch-fulfillment");
    btnFulfill?.addEventListener("click", async () => {
      const carrier = document.getElementById("fulfill-carrier")?.value || "DHL Express";
      const trackingNumber = document.getElementById("fulfill-tracking")?.value || "";
      const statusEl = document.getElementById("fulfillment-status-msg");
      await runAdminMutation(
        btnFulfill, statusEl,
        "/api/admin/orders/" + encodeURIComponent(orderId) + "/fulfill",
        { carrier, trackingNumber }, "Dispatching fulfillment..."
      );
    });

    const btnCancel = document.getElementById("btn-cancel-order");
    btnCancel?.addEventListener("click", async () => {
      if (!confirm("Are you sure you want to cancel this order and release stock allocations?")) return;
      const reason = document.getElementById("cancel-reason")?.value || "Customer pre-fulfillment cancellation";
      const statusEl = document.getElementById("cancel-status-msg");
      await runAdminMutation(
        btnCancel, statusEl,
        "/api/admin/orders/" + encodeURIComponent(orderId) + "/cancel",
        { reason }, "Cancelling order..."
      );
    });

    const form = document.getElementById("admin-order-rma-form");
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const lineId = document.getElementById("rma-line-id")?.value;
      const quantity = Number(document.getElementById("rma-qty")?.value || 1);
      const condition = document.getElementById("rma-condition")?.value || "RESELLABLE";
      const restockingFeeBps = Number(document.getElementById("rma-fee-bps")?.value || 0);
      const statusEl = document.getElementById("admin-rma-status");
      await runAdminMutation(
        document.getElementById("btn-execute-admin-rma"), statusEl,
        "/api/admin/orders/" + encodeURIComponent(orderId) + "/rma",
        { lineId, quantity, condition, restockingFeeBps }, "Processing return..."
      );
    });
  </script>`;

  return { bodyHtml, extraScriptHtml };
}

export function renderCatalogRoute(input: AdminDashboardRenderInput): {
  readonly bodyHtml: string;
  readonly extraScriptHtml: string;
} {
  const activeChannelSlug = input.activeChannelSlug ?? "us-retail";
  const activeCurrency = input.channels?.find((channel) => channel.slug === activeChannelSlug)?.currencyCode ?? "USD";
  const variants: readonly AdminCatalogVariantView[] = input.catalogVariants ?? [];
  const projections = input.catalogProjections ?? [];

  const variantRowsHtml =
    variants.length === 0
      ? `<tr><td colspan="7" class="empty-cell">No catalog variants configured yet. Create a product below.</td></tr>`
      : variants
          .map((v) => {
            const chassisVal = String(v.attributes["chassis"] ?? v.attributes["material"] ?? "grade-5-titanium");
            return `
      <tr data-variant-row="${escapeHtml(v.variantId)}">
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(v.sku)}</td>
        <td>
          <div style="font-weight: 600;">${escapeHtml(v.productName)}</div>
          <div class="mono" style="font-size: 11px; color: var(--text-muted);">${escapeHtml(v.name)} (${escapeHtml(v.productSlug)})</div>
        </td>
        <td>
          <input type="number" min="1" step="1" class="field-input mono" data-field="priceAmountCents" value="${escapeHtml(v.priceAmountCents)}" style="width: 110px;" aria-label="Price cents for ${escapeHtml(v.sku)}" />
          <div class="mono" style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">${fmtMoney(v.priceAmountCents, activeCurrency)}</div>
        </td>
        <td>
          <select class="field-select mono" data-field="isPublished" style="width: 115px;" aria-label="Published status for ${escapeHtml(v.sku)}">
            <option value="true" ${v.isPublished ? "selected" : ""}>Published</option>
            <option value="false" ${!v.isPublished ? "selected" : ""}>Unpublished</option>
          </select>
        </td>
        <td>
          <input type="text" class="field-input mono" data-field="chassis" value="${escapeHtml(chassisVal)}" style="width: 140px;" aria-label="Chassis attribute for ${escapeHtml(v.sku)}" />
        </td>
        <td class="mono num accent-green">${v.availableQuantity}u</td>
        <td class="num" style="white-space: nowrap;">
          <button type="button" class="btn btn-primary" data-save-variant="${escapeHtml(v.variantId)}" data-product-id="${escapeHtml(v.productId)}" style="padding: 5px 10px;">Save</button>
          <a href="/products/${encodeURIComponent(v.productSlug)}?channel=${encodeURIComponent(activeChannelSlug)}" class="btn" style="padding: 5px 10px;">PDP</a>
        </td>
      </tr>`;
          })
          .join("");

  const projectionRowsHtml =
    projections.length === 0
      ? `<tr><td colspan="5" class="empty-cell">No CQRS projections materialized for ${escapeHtml(activeChannelSlug)}.</td></tr>`
      : projections
          .map((p) => {
            const minP = fmtMoney(p.minEffectivePrice, p.currencyCode);
            const maxP = fmtMoney(p.maxEffectivePrice, p.currencyCode);
            const facetSummary = Object.entries(p.mergedAttributes)
              .map(([k, vals]) => `${k}=[${vals.join(",")}]`)
              .join(" | ");
            return `
          <tr>
            <td class="mono"><a href="/products/${encodeURIComponent(p.productSlug)}?channel=${encodeURIComponent(p.channelSlug)}" class="accent-blue">${escapeHtml(p.productSlug)}</a></td>
            <td style="font-weight: 600;">${escapeHtml(p.productName)}</td>
            <td class="mono" style="color: var(--text-secondary); font-size: 11px;">${escapeHtml(facetSummary || "none")}</td>
            <td class="mono num ${p.isInStock ? "accent-green" : "accent-amber"}">${p.totalAvailableQty}u</td>
            <td class="mono num">${minP === maxP ? minP : `${minP} to ${maxP}`}</td>
          </tr>`;
          })
          .join("");

  const saleorProjections = input.saleorLiveReport?.projections ?? [];
  const activeTenantKey = input.saleorLiveReport?.activeTenantKey ?? "ntms";
  const tenantMatrix = input.saleorLiveReport?.tenantMatrix ?? [];
  const tenantMatrixRowsHtml =
    tenantMatrix.length === 0
      ? `<tr><td colspan="7" class="empty-cell">No multi-tenant matrix loaded yet.</td></tr>`
      : tenantMatrix
          .map((t) => {
            const isCurrent = t.key === activeTenantKey;
            return `
      <tr>
        <td class="mono ${isCurrent ? "accent-green" : "accent-blue"}">${escapeHtml(t.containerName)} ${isCurrent ? "(ACTIVE)" : ""}</td>
        <td>${escapeHtml(t.label)} (${escapeHtml(t.endpoint)})</td>
        <td class="mono num">${t.products.toLocaleString("en-US")} / ${t.variants.toLocaleString("en-US")} / ${t.warehouseStocks.toLocaleString("en-US")}</td>
        <td class="mono num accent-amber">${t.saleor11JoinLatencyUs} us</td>
        <td class="mono num accent-green">${t.super0JoinCqrsLatencyUs} us</td>
        <td class="mono num accent-green">${t.speedupMultiplier}x Faster</td>
        <td class="num">
          <button type="button" class="btn" data-switch-tenant="${escapeHtml(t.key)}" style="color: ${isCurrent ? "var(--accent-green)" : "var(--accent-blue)"};">
            ${isCurrent ? "Projected" : `Switch -> ${t.key.toUpperCase()}`}
          </button>
        </td>
      </tr>`;
          })
          .join("");

  const saleorRowsHtml =
    saleorProjections.length === 0
      ? `<tr><td colspan="6" class="empty-cell">No Saleor projections loaded yet. Click Re-Benchmark All 4 Tenants above.</td></tr>`
      : saleorProjections
          .slice(0, 8)
          .map((p) => {
            const minUsd = (Number(p.minEffectivePrice) / 100).toFixed(2);
            const maxUsd = (Number(p.maxEffectivePrice) / 100).toFixed(2);
            const priceLabel = minUsd === maxUsd ? `$${minUsd}` : `$${minUsd} to $${maxUsd}`;
            const cat = (p.mergedAttributes["category"] ?? ["uncategorized"])[0];
            const pType = (p.mergedAttributes["product_type"] ?? ["standard"])[0];
            return `
      <tr>
        <td class="mono accent-blue">${escapeHtml(p.productSlug)}</td>
        <td>${escapeHtml(p.productName)}</td>
        <td class="mono" style="color: var(--text-secondary);">${escapeHtml(String(pType))} / ${escapeHtml(String(cat))}</td>
        <td class="mono num">${p.variantsSnapshot.length} SKUs</td>
        <td class="mono num accent-green">${p.totalAvailableQty}</td>
        <td class="mono num">${priceLabel}</td>
      </tr>`;
          })
          .join("");

  const bodyHtml = `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Create New Product &amp; Variant SKU (Live Storefront + CQRS + RRF Sync)</h2>
          <p class="panel-subtitle">Newly created products immediately appear on Storefront and in Hybrid BM25 + Vector Search</p>
        </div>
      </div>
      ${renderBanner("catalog-sim-banner", input.catalogBanner ?? "Ready: Edit existing variant prices, publication flags, or JSONB attributes below and verify directly on Storefront")}
      <div class="panel-body">
        <form id="catalog-create-form" class="form-grid">
          <div>
            <label class="field-label" for="cat-prod-name">Product Name</label>
            <input id="cat-prod-name" type="text" required placeholder="Kronos Ergo Split 65" class="field-input" />
          </div>
          <div>
            <label class="field-label" for="cat-prod-slug">Product Slug</label>
            <input id="cat-prod-slug" type="text" required placeholder="kronos-ergo-65" class="field-input mono" />
          </div>
          <div>
            <label class="field-label" for="cat-var-sku">Variant SKU</label>
            <input id="cat-var-sku" type="text" required placeholder="KR-ERGO65-ALU" class="field-input mono" />
          </div>
          <div>
            <label class="field-label" for="cat-price-cents">Price (Cents)</label>
            <input id="cat-price-cents" type="number" min="100" required value="29900" class="field-input mono" />
          </div>
          <div>
            <label class="field-label" for="cat-initial-qty">US-EAST OnHand Qty</label>
            <input id="cat-initial-qty" type="number" min="0" required value="20" class="field-input mono" />
          </div>
          <div>
            <button type="submit" id="btn-catalog-create" class="btn btn-primary" style="width: 100%;">Create Product &amp; SKU</button>
          </div>
        </form>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Product &amp; Variant SKU Matrix (${variants.length} SKUs)</h2>
          <p class="panel-subtitle">Edits persist in server memory and immediately re-materialize Storefront CQRS projections</p>
        </div>
        <div class="panel-actions">
          <form action="/admin/catalog" method="get" class="panel-actions">
            <label for="catalog-channel" class="field-label" style="margin: 0;">Sales Channel</label>
            <select id="catalog-channel" name="channel" class="field-select" style="width: auto; max-width: 100%;">
              ${(input.channels ?? []).map((channel) => `<option value="${escapeHtml(channel.slug)}" ${channel.slug === activeChannelSlug ? "selected" : ""}>${escapeHtml(channel.name)} (${escapeHtml(channel.currencyCode)})</option>`).join("")}
            </select>
            <button type="submit" class="btn">View Channel</button>
          </form>
          <a href="/?channel=${encodeURIComponent(activeChannelSlug)}" class="btn">Inspect Storefront</a>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Variant SKU</th>
              <th>Product &amp; Variant</th>
              <th>Price (Cents)</th>
              <th>Channel Status</th>
              <th>Chassis / Material Facet</th>
              <th class="num">Available</th>
              <th class="num">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${variantRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">0-JOIN Materialized CQRS Storefront Projections (${escapeHtml(activeChannelSlug)})</h2>
          <p class="panel-subtitle">GIN jsonb_path_ops attribute facets &amp; channel effective pricing</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product Slug</th>
              <th>Product Name</th>
              <th>JSONB Facets</th>
              <th class="num">Avail Qty</th>
              <th class="num">Effective Price</th>
            </tr>
          </thead>
          <tbody>
            ${projectionRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">4-Tenant Apple Container Saleor Benchmark Matrix (ntms / hawk / sava / bdgy)</h2>
          <p class="panel-subtitle">
            Active Source: ${escapeHtml(input.saleorLiveReport?.sourceContainer ?? "ntms-postgres")} (${(input.saleorLiveReport?.sourceTotals.products ?? 0).toLocaleString("en-US")} Products / ${(input.saleorLiveReport?.sourceTotals.variants ?? 0).toLocaleString("en-US")} Variants)
          </p>
        </div>
        <div class="panel-actions">
          <span class="mono accent-green">
            ${input.saleorLiveReport?.speedupMultiplier ?? 1}x Faster (0-JOIN CQRS)
          </span>
          <button type="button" id="btn-saleor-sync" class="btn" style="color: var(--accent-blue);">Re-Benchmark All 4 Tenants</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Apple Container</th>
              <th>Tenant &amp; Endpoint</th>
              <th class="num">Products / Variants / Stocks</th>
              <th class="num">Saleor 11-JOIN</th>
              <th class="num">Super 0-JOIN CQRS</th>
              <th class="num">CQRS Speedup</th>
              <th class="num">Switch Active Catalog</th>
            </tr>
          </thead>
          <tbody>
            ${tenantMatrixRowsHtml}
          </tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Saleor Product Slug</th>
              <th>Product Name</th>
              <th>Collapsed JSONB Facets</th>
              <th class="num">Variants</th>
              <th class="num">Total Available</th>
              <th class="num">CQRS Effective Price</th>
            </tr>
          </thead>
          <tbody>
            ${saleorRowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  `;

  const extraScriptHtml = `
  <script type="module">
    ${ADMIN_MUTATION_SCRIPT}
    const banner = document.getElementById("catalog-sim-banner");
    document.getElementById("catalog-create-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("btn-catalog-create");
      await runAdminMutation(btn, banner, "/api/admin/catalog/product-create", {
        productName: document.getElementById("cat-prod-name")?.value,
        productSlug: document.getElementById("cat-prod-slug")?.value,
        sku: document.getElementById("cat-var-sku")?.value,
        priceAmountCents: document.getElementById("cat-price-cents")?.value,
        initialOnHandQty: Number(document.getElementById("cat-initial-qty")?.value || 0),
      }, "Creating product…");
    });

    document.addEventListener("click", async (e) => {
      const saveBtn = e.target.closest("button[data-save-variant]");
      if (saveBtn) {
        const variantId = saveBtn.getAttribute("data-save-variant");
        const productId = saveBtn.getAttribute("data-product-id");
        const row = saveBtn.closest("tr");
        const priceAmountCents = row?.querySelector('input[data-field="priceAmountCents"]')?.value;
        const isPublished = row?.querySelector('select[data-field="isPublished"]')?.value === "true";
        const chassis = row?.querySelector('input[data-field="chassis"]')?.value;
        await runAdminMutation(saveBtn, banner, "/api/admin/catalog/save",
          { variantId, productId, channelSlug: ${JSON.stringify(activeChannelSlug)}, priceAmountCents, isPublished, chassis },
          "Saving product…");
        return;
      }

      const tenantBtn = e.target.closest("button[data-switch-tenant]");
      if (tenantBtn) {
        const tenantKey = tenantBtn.getAttribute("data-switch-tenant");
        if (!tenantKey) return;
        tenantBtn.textContent = "Projecting " + tenantKey.toUpperCase() + "...";
        await fetch("/api/demo/saleor-sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantKey }),
        });
        window.location.reload();
      }
    });

    document.getElementById("btn-saleor-sync")?.addEventListener("click", async () => {
      const btn = document.getElementById("btn-saleor-sync");
      if (btn) btn.textContent = "Benchmarking 4 Saleor Containers...";
      await fetch("/api/demo/saleor-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ forceRefresh: true }),
      });
      window.location.reload();
    });
  </script>`;

  return { bodyHtml, extraScriptHtml };
}

export function renderDiscountsRoute(input: AdminDashboardRenderInput): {
  readonly bodyHtml: string;
  readonly extraScriptHtml: string;
} {
  const vouchers: readonly AdminVoucherRuleView[] = input.vouchers ?? [];

  const voucherRowsHtml =
    vouchers.length === 0
      ? `<tr><td colspan="6" class="empty-cell">No voucher rules defined. Create a voucher code below.</td></tr>`
      : vouchers
          .map((v) => {
            const valLabel =
              v.valueType === "PERCENTAGE"
                ? `${(v.valueBps / 100).toFixed(2)}% off subtotal`
                : `$${(Number(v.valueAmountCents) / 100).toFixed(2)} off order`;
            return `
          <tr>
            <td class="mono accent-blue" style="font-weight: 700;">${escapeHtml(v.code)}</td>
            <td>
              <div style="font-weight: 600;">${escapeHtml(v.name)}</div>
              <div class="mono" style="font-size: 11px; color: var(--text-muted);">${escapeHtml(v.description)}</div>
            </td>
            <td class="mono">${escapeHtml(v.kind)}</td>
            <td class="mono accent-green">${escapeHtml(valLabel)}</td>
            <td class="mono num">${v.usageCount}x</td>
            <td class="num" style="white-space: nowrap;">
              <span class="pill mono ${v.isActive ? "accent-green" : "accent-amber"}" style="margin-right: 6px;">${v.isActive ? "ACTIVE" : "PAUSED"}</span>
              <button type="button" class="btn" data-toggle-voucher="${escapeHtml(v.code)}" style="padding: 4px 10px;">
                ${v.isActive ? "Pause" : "Enable"}
              </button>
            </td>
          </tr>`;
          })
          .join("");

  const bodyHtml = `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Saleor Core Discount Precedence &amp; Stacking Rules</h2>
          <p class="panel-subtitle">Exact server pricing invariants enforced across Rust N-API Kernel &amp; Two-Pass Hare-Niemeyer attribution</p>
        </div>
        <a href="/checkout?channel=us-retail" class="btn">Test on Checkout</a>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Winner Precedence Order</th>
              <th>Suppression &amp; Attribution Semantics</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="mono accent-blue">Order-Level</td>
              <td class="mono accent-green">MANUAL_ORDER &gt; VOUCHER &gt; ORDER_PROMOTION</td>
              <td>Manual order discount clears vouchers and order promotions; a voucher suppresses order promotions (non-stacking order tier).</td>
            </tr>
            <tr>
              <td class="mono accent-blue">Line-Level</td>
              <td class="mono accent-green">MANUAL_LINE &gt; CATALOGUE_PROMOTION / VOUCHER_LINE</td>
              <td>Manual line unit discount overrides catalogue promotions; Pass B distributes order discounts proportionally with last line absorbing remainder.</td>
            </tr>
            <tr>
              <td class="mono accent-blue">Free Gift Lines</td>
              <td class="mono">OrderLine.isGift = true</td>
              <td>Gift lines carry 0 unit price with ORDER_PROMOTION line discount record; never merged with paid line of identical SKU.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Create or Update Voucher Rule (Live on Storefront Checkout)</h2>
          <p class="panel-subtitle">Vouchers saved here immediately work on /checkout and POST /api/demo/checkout</p>
        </div>
      </div>
      ${renderBanner("discounts-sim-banner", input.discountsBanner ?? "Ready: Create or toggle voucher rules; active codes apply immediately on Storefront Checkout")}
      <div class="panel-body">
        <form id="voucher-upsert-form" class="form-grid">
          <div>
            <label class="field-label" for="vch-code">Voucher Code</label>
            <input id="vch-code" type="text" required placeholder="SPRING20" class="field-input mono" />
          </div>
          <div>
            <label class="field-label" for="vch-name">Display Name</label>
            <input id="vch-name" type="text" required placeholder="Spring 20% Off Promo" class="field-input" />
          </div>
          <div>
            <label class="field-label" for="vch-type">Value Type</label>
            <select id="vch-type" class="field-select mono">
              <option value="PERCENTAGE">PERCENTAGE (bps)</option>
              <option value="FIXED">FIXED (minor cents)</option>
            </select>
          </div>
          <div>
            <label class="field-label" for="vch-value">Value (2000 bps = 20% | 2500 = $25)</label>
            <input id="vch-value" type="number" min="1" required value="2000" class="field-input mono" />
          </div>
          <div>
            <button type="submit" id="btn-voucher-save" class="btn btn-primary" style="width: 100%;">Save Voucher Rule</button>
          </div>
        </form>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Active Vouchers &amp; Promotion Registry (${vouchers.length})</h2>
          <p class="panel-subtitle">Toggle availability or inspect live checkout redemption counts</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Rule Name &amp; Scope</th>
              <th>Tier</th>
              <th>Discount Value</th>
              <th class="num">Redemptions</th>
              <th class="num">Status &amp; Control</th>
            </tr>
          </thead>
          <tbody>
            ${voucherRowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  `;

  const extraScriptHtml = `
  <script type="module">
    ${ADMIN_MUTATION_SCRIPT}
    const banner = document.getElementById("discounts-sim-banner");
    document.getElementById("voucher-upsert-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("btn-voucher-save");
      await runAdminMutation(btn, banner, "/api/admin/discounts/upsert", {
        code: document.getElementById("vch-code")?.value,
        name: document.getElementById("vch-name")?.value,
        valueType: document.getElementById("vch-type")?.value,
        valueRaw: Number(document.getElementById("vch-value")?.value || 0),
      }, "Saving voucher…");
    });

    document.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-toggle-voucher]");
      if (!btn) return;
      const code = btn.getAttribute("data-toggle-voucher");
      await runAdminMutation(btn, banner, "/api/admin/discounts/toggle", { code }, "Updating voucher…");
    });
  </script>`;

  return { bodyHtml, extraScriptHtml };
}

export function renderInventoryRoute(input: AdminDashboardRenderInput): {
  readonly bodyHtml: string;
  readonly extraScriptHtml: string;
} {
  const channels = input.channels ?? [];
  const channelModeRowsHtml =
    channels.length === 0
      ? `<tr><td colspan="4" class="empty-cell">No channels loaded.</td></tr>`
      : channels
          .map((ch) => {
            const isDirect = ch.stockAvailabilityMode === "DIRECT_CHANNEL_WAREHOUSES";
            return `
          <tr>
            <td class="mono accent-blue">${escapeHtml(ch.slug)}</td>
            <td>${escapeHtml(ch.name)}</td>
            <td class="mono ${isDirect ? "accent-green" : "accent-amber"}">${escapeHtml(ch.stockAvailabilityMode)}</td>
            <td class="mono">${escapeHtml(ch.allocationStrategy)} (${ch.reservationTtlSeconds}s TTL)</td>
          </tr>`;
          })
          .join("");

  const stockRowsHtml = input.stockSlots
    .map((slot) => {
      const avail = Math.max(
        0,
        slot.quantityOnHand - slot.quantityReserved - slot.quantityAllocated
      );
      return `
      <tr>
        <td class="mono">${escapeHtml(slot.warehouseId)}</td>
        <td class="mono">#${slot.priorityRank}</td>
        <td class="mono">${escapeHtml(slot.variantId)}</td>
        <td>
          <input type="number" min="0" value="${slot.quantityOnHand}" data-stock-onhand class="field-input mono" style="width: 82px;" aria-label="OnHand for ${escapeHtml(slot.warehouseId)} ${escapeHtml(slot.variantId)}" />
        </td>
        <td class="mono num">${slot.quantityReserved}</td>
        <td class="mono num accent-blue">${slot.quantityAllocated}</td>
        <td class="mono num accent-green">${avail}</td>
        <td>
          <label class="mono" style="font-size: 11px; display: inline-flex; align-items: center; gap: 4px; margin-right: 8px;">
            <input type="checkbox" data-stock-channel ${slot.linkedToChannel ? "checked" : ""} /> CH
          </label>
          <label class="mono" style="font-size: 11px; display: inline-flex; align-items: center; gap: 4px;">
            <input type="checkbox" data-stock-zone ${slot.supportsShippingZone ? "checked" : ""} /> Zone
          </label>
        </td>
        <td class="num">
          <button type="button" class="btn btn-primary" data-save-stock data-warehouse-id="${escapeHtml(slot.warehouseId)}" data-variant-id="${escapeHtml(slot.variantId)}" style="padding: 4px 10px; font-size: 11px;">Save Stock</button>
        </td>
      </tr>`;
    })
    .join("");

  const hybridReport = input.hybridSearchReport;
  const stockReservationsList = input.stockReservations ?? [];
  const reaperAuditList = input.reaperAuditHistory ?? [];
  const activeReservationsCount = stockReservationsList.filter(
    (r) => r.status === "ACTIVE"
  ).length;
  const activeUnitsHeld = stockReservationsList
    .filter((r) => r.status === "ACTIVE")
    .reduce((sum, r) => sum + r.quantity, 0);
  const expiredReservationsCount = stockReservationsList.filter(
    (r) => r.status === "EXPIRED"
  ).length;

  const hybridSearchRowsHtml =
    !hybridReport || hybridReport.hits.length === 0
      ? `<tr><td colspan="6" class="empty-cell">No Hybrid RRF search hits yet. Enter a query or click Semantic Recall: Quiet Typing above.</td></tr>`
      : hybridReport.hits
          .slice(0, 8)
          .map((hit, idx) => {
            const originClass =
              hit.matchedBy === "HYBRID_BOTH"
                ? "accent-green"
                : hit.matchedBy === "VECTOR_SEMANTIC"
                ? "accent-blue"
                : "accent-amber";
            const p = hit.projection;
            const bm25Label =
              hit.bm25Rank !== null
                ? `${hit.bm25Score} (Rank #${hit.bm25Rank})`
                : "0 (No Lexical Hit)";
            const vecLabel =
              hit.vectorRank !== null
                ? `${hit.vectorSimilarity} (Rank #${hit.vectorRank})`
                : `${hit.vectorSimilarity} (&lt; Threshold)`;
            return `
      <tr>
        <td class="mono ${originClass}" style="white-space: nowrap;">#${idx + 1} (${escapeHtml(hit.matchedBy)})</td>
        <td>
          <div style="font-weight: 600;">${escapeHtml(p.productName)}</div>
          <div class="mono" style="font-size: 11px; color: var(--text-muted);">${escapeHtml(p.productSlug)}</div>
        </td>
        <td class="mono">${bm25Label}</td>
        <td class="mono">${vecLabel}</td>
        <td class="mono num accent-green">${hit.rrfScore.toFixed(6)}</td>
        <td class="mono num">${escapeHtml(p.currencyCode)} ${(Number(p.minEffectivePrice) / 100).toFixed(2)} (${p.totalAvailableQty}u)</td>
      </tr>`;
          })
          .join("");

  const reservationRowsHtml =
    stockReservationsList.length === 0
      ? `<tr><td colspan="6" class="empty-cell">No MSI stock reservations recorded yet. Click Seed 2 Expired TTL Holds or Pending PO (72h MSI Hold) to observe holds.</td></tr>`
      : stockReservationsList
          .slice(0, 10)
          .map((res) => {
            const rClass =
              res.status === "ACTIVE"
                ? "accent-blue"
                : res.status === "CONVERTED"
                ? "accent-green"
                : "accent-amber";
            return `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(res.reservationId)}</td>
        <td class="mono">${escapeHtml(res.holderId)}</td>
        <td class="mono">${escapeHtml(res.warehouseId)} / ${escapeHtml(res.variantId)}</td>
        <td class="mono num">${res.quantity}u</td>
        <td class="mono" style="color: var(--text-secondary);">${escapeHtml(res.expiresAt)} (${res.ttlSeconds}s)</td>
        <td class="mono ${rClass}" style="white-space: nowrap;">${escapeHtml(res.status)}</td>
      </tr>`;
          })
          .join("");

  const reaperAuditRowsHtml =
    reaperAuditList.length === 0
      ? `<tr><td colspan="6" class="empty-cell">No TTL Reaper sweeps executed yet. Seed expired holds then click Reap Expired Holds Now above.</td></tr>`
      : reaperAuditList
          .map((aud) => `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(aud.sweepId)}</td>
        <td class="mono" style="color: var(--text-secondary);">${escapeHtml(aud.executedAtIso)}</td>
        <td class="mono num">${aud.reapedReservationsCount} row(s)</td>
        <td class="mono num accent-green">+${aud.totalUnitsReleased}u -&gt; Available</td>
        <td class="mono">${aud.expiredPoNumbers.length > 0 ? escapeHtml(aud.expiredPoNumbers.join(", ")) : "None"}</td>
        <td class="mono num">$${(Number(aud.releasedCreditMinorUnits) / 100).toFixed(2)} (${aud.latencyUs} us)</td>
      </tr>`)
          .join("");

  const bodyHtml = `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Channel Stock Availability Mode Diagnostics (Purchasability vs Shippability)</h2>
          <p class="panel-subtitle">DIRECT_CHANNEL_WAREHOUSES ignores shipping zone intersections for purchasability; SHIPPING_ZONE_INTERSECTION requires both Channel Warehouse AND Shipping Zone links</p>
        </div>
        <a href="/admin/configurator" class="btn">Edit Channel Modes</a>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Channel Slug</th>
              <th>Store Name</th>
              <th>Stock Availability Mode</th>
              <th>Allocation Strategy</th>
            </tr>
          </thead>
          <tbody>
            ${channelModeRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">MSI 3-Tier Inventory Matrix &amp; Cross-Warehouse Split Router</h2>
          <p class="panel-subtitle">Orthogonal formula: Available = OnHand - Reserved - Allocated (${input.saleorLiveReport?.syncedMsiSlots.length ?? 0} multi-warehouse Saleor slots synced)</p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-msi-sync" class="btn" style="color: var(--accent-green);">Sync Saleor Stock -&gt; MSI</button>
          <button type="button" id="btn-msi-single-hub" class="btn" style="color: var(--accent-blue);">Avoid Split (1 Hub)</button>
          <button type="button" id="btn-msi-three-wh" class="btn" style="color: var(--accent-amber);">3-Warehouse Split</button>
          <button type="button" id="btn-msi-alloc" class="btn" style="color: var(--accent-blue);">Route Saleor SKU (+5 Alloc)</button>
        </div>
      </div>
      ${renderBanner("inventory-sim-banner", input.inventoryBanner ?? "Ready: Adjust OnHand quantities or toggle Channel / Shipping Zone links inline and verify Storefront PDP stock")}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Warehouse</th>
              <th>Rank</th>
              <th>Variant SKU</th>
              <th>On Hand</th>
              <th class="num">Reserved</th>
              <th class="num">Allocated</th>
              <th class="num">Available</th>
              <th>Availability Links</th>
              <th class="num">Save</th>
            </tr>
          </thead>
          <tbody>
            ${stockRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Hybrid Catalog Search (BM25 + Vector RRF) &amp; MSI Reservation TTL Reaper</h2>
          <p class="panel-subtitle">
            RRF k=${hybridReport?.rrfK ?? 60} | Query: &quot;${escapeHtml(hybridReport?.queryText ?? "quiet titanium keyboard")}&quot; | BM25: ${hybridReport?.bm25MatchedCount ?? 0} | Vector 64D: ${hybridReport?.vectorMatchedCount ?? 0} | Active Reservations: ${activeReservationsCount} (${activeUnitsHeld}u Held) | Expired Reaped: ${expiredReservationsCount}
          </p>
        </div>
        <div class="panel-actions">
          <input type="text" id="input-phase7-query" value="${escapeHtml(hybridReport?.queryText ?? "quiet titanium keyboard")}" placeholder="Hybrid query..." class="field-input mono" style="width: 215px;" />
          <button type="button" id="btn-phase7-search" class="btn" style="color: var(--accent-blue);">Run Hybrid RRF Search</button>
          <button type="button" id="btn-phase7-semantic" class="btn" style="color: var(--accent-green);">Semantic Recall: Quiet Typing</button>
          <button type="button" id="btn-phase7-seed-ttl" class="btn" style="color: var(--accent-amber);">Seed 2 Expired TTL Holds</button>
          <button type="button" id="btn-phase7-reap-ttl" class="btn" style="color: var(--accent-green);">Reap Expired Holds Now</button>
        </div>
      </div>
      ${renderBanner("phase7-sim-banner", input.phase7Banner ?? "Ready: Hybrid RRF Search (Okapi BM25 + 64D Vector Cosine k=60) & Reservation TTL Reaper (partial index idx_stock_reservations_active_expiry)")}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>RRF Rank &amp; Origin</th>
              <th>Product &amp; Slug</th>
              <th>BM25 Lexical Score</th>
              <th>64D Vector Cosine</th>
              <th class="num">Fused RRF (k=60)</th>
              <th class="num">Effective Price &amp; Stock</th>
            </tr>
          </thead>
          <tbody>
            ${hybridSearchRowsHtml}
          </tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Reservation ID</th>
              <th>Holder (PO / Checkout)</th>
              <th>Warehouse &amp; SKU</th>
              <th class="num">Held Qty</th>
              <th>Expires At (TTL)</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${reservationRowsHtml}
          </tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Sweep ID</th>
              <th>Executed At</th>
              <th class="num">Rows Reaped</th>
              <th class="num">MSI Units Released</th>
              <th>B2B POs Expired (EXPIRED_TTL)</th>
              <th class="num">Credit Released &amp; Latency</th>
            </tr>
          </thead>
          <tbody>
            ${reaperAuditRowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  `;

  const extraScriptHtml = `
  <script type="module">
    ${ADMIN_MUTATION_SCRIPT}
    const invBanner = document.getElementById("inventory-sim-banner");
    document.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-save-stock]");
      if (!btn) return;
      const warehouseId = btn.getAttribute("data-warehouse-id");
      const variantId = btn.getAttribute("data-variant-id");
      const row = btn.closest("tr");
      const quantityOnHand = Number(row?.querySelector("input[data-stock-onhand]")?.value || 0);
      const linkedToChannel = Boolean(row?.querySelector("input[data-stock-channel]")?.checked);
      const supportsShippingZone = Boolean(row?.querySelector("input[data-stock-zone]")?.checked);
      await runAdminMutation(btn, invBanner, "/api/admin/inventory/adjust", {
        warehouseId,
        variantId,
        quantityOnHand,
        linkedToChannel,
        supportsShippingZone,
      }, "Saving stock…");
    });

    async function runMsiSyncAction(action, btnId, busyLabel) {
      const btn = document.getElementById(btnId);
      if (btn) btn.textContent = busyLabel;
      await fetch("/api/demo/msi-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      window.location.reload();
    }

    document.getElementById("btn-msi-sync")?.addEventListener("click", () =>
      runMsiSyncAction("sync_saleor_stock", "btn-msi-sync", "Syncing Saleor Stock...")
    );
    document.getElementById("btn-msi-single-hub")?.addEventListener("click", () =>
      runMsiSyncAction("single_hub_avoid_split", "btn-msi-single-hub", "Routing Single Hub...")
    );
    document.getElementById("btn-msi-three-wh")?.addEventListener("click", () =>
      runMsiSyncAction("three_warehouse_split", "btn-msi-three-wh", "Splitting 3 Warehouses...")
    );
    document.getElementById("btn-msi-alloc")?.addEventListener("click", () =>
      runMsiSyncAction("native_two_warehouse_split", "btn-msi-alloc", "Splitting 28u (2 Hubs)...")
    );

    async function runPhase7Action(action, btnId, busyLabel, extra) {
      const btn = btnId ? document.getElementById(btnId) : null;
      if (btn && busyLabel) btn.textContent = busyLabel;
      await fetch("/api/demo/phase7", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(extra || {}) }),
      });
      window.location.reload();
    }

    document.getElementById("btn-phase7-search")?.addEventListener("click", () => {
      const qInput = document.getElementById("input-phase7-query");
      const queryText = qInput ? qInput.value : "";
      runPhase7Action("hybrid_rrf_search", "btn-phase7-search", "Scoring BM25 + Vector RRF...", { queryText });
    });
    document.getElementById("btn-phase7-semantic")?.addEventListener("click", () =>
      runPhase7Action("hybrid_rrf_search", "btn-phase7-semantic", "Recalling Semantic Matches...", {
        queryText: "quiet mechanical typing",
      })
    );
    document.getElementById("btn-phase7-seed-ttl")?.addEventListener("click", () =>
      runPhase7Action("seed_expired_holds", "btn-phase7-seed-ttl", "Seeding Expired TTL Holds...")
    );
    document.getElementById("btn-phase7-reap-ttl")?.addEventListener("click", () =>
      runPhase7Action("reap_expired_holds", "btn-phase7-reap-ttl", "Reaping Expired Holds...")
    );
  </script>`;

  return { bodyHtml, extraScriptHtml };
}

export function renderB2bRoute(input: AdminDashboardRenderInput): {
  readonly bodyHtml: string;
  readonly extraScriptHtml: string;
} {
  const b2bCompanies = input.b2bCompanies ?? [];
  const b2bCostCenters = input.b2bCostCenters ?? [];
  const b2bBuyers = input.b2bBuyers ?? [];
  const b2bPos = input.b2bPurchaseOrders ?? [];
  const activeCompany = b2bCompanies[0];
  const fmtUsd = (cents: bigint) => `$${(Number(cents) / 100).toFixed(2)}`;
  const companyAvailCredit = activeCompany
    ? activeCompany.creditLimit - activeCompany.creditUsed - activeCompany.creditReserved
    : 0n;

  const b2bCostCenterRowsHtml =
    b2bCostCenters.length === 0
      ? `<tr><td colspan="5" class="empty-cell">No B2B Cost Centers seeded.</td></tr>`
      : b2bCostCenters
          .map((cc) => {
            const rem = cc.monthlyBudget - cc.monthlySpent - cc.monthlyReserved;
            return `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(cc.departmentCode)}</td>
        <td style="font-weight: 600;">${escapeHtml(cc.name)}</td>
        <td class="mono">${fmtUsd(cc.monthlyBudget)}</td>
        <td class="mono">${fmtUsd(cc.monthlySpent)} spent / ${fmtUsd(cc.monthlyReserved)} held</td>
        <td class="mono accent-green">${fmtUsd(rem)} left</td>
      </tr>`;
          })
          .join("");

  const buyerRowsHtml =
    b2bBuyers.length === 0
      ? `<tr><td colspan="5" class="empty-cell">No B2B buyers seeded.</td></tr>`
      : b2bBuyers
          .map((b) => `
      <tr>
        <td style="font-weight: 600;">${escapeHtml(b.fullName)}</td>
        <td class="mono">${escapeHtml(b.email)}</td>
        <td class="mono accent-blue">${escapeHtml(b.role)}</td>
        <td class="mono">${fmtUsd(b.singleOrderAutoApproveLimit)}</td>
        <td class="mono ${b.role === "APPROVER" || b.role === "COMPANY_ADMIN" ? "accent-green" : "accent-amber"}">${b.role === "APPROVER" || b.role === "COMPANY_ADMIN" ? "CAN_APPROVE_PO" : "SUBMITTER_ONLY"}</td>
      </tr>`)
          .join("");

  const b2bPoRowsHtml =
    b2bPos.length === 0
      ? `<tr><td colspan="6" class="empty-cell">No B2B Purchase Orders submitted yet. Click Auto-Approve PO or Pending PO (72h MSI Hold) above to test the Rust B2B Policy &amp; Net-30 Saga.</td></tr>`
      : b2bPos
          .map((po) => {
            const stClass =
              po.status === "APPROVED_AUTO" || po.status === "APPROVED_BY_SUPERVISOR"
                ? "accent-green"
                : po.status === "PENDING_APPROVAL" || po.status === "EXPIRED_TTL"
                ? "accent-amber"
                : "accent-blue";
            const msiHoldLabel =
              po.status === "PENDING_APPROVAL"
                ? `${po.reservedShipments.reduce((s, r) => s + r.quantityAllocated, 0)}u Reserved (${Math.round(po.reservationTtlSeconds / 3600)}h TTL)`
                : po.status === "EXPIRED_TTL"
                ? "Expired TTL -> 0u Held"
                : po.orderId
                ? `Order ${po.orderId}`
                : "0u Held";
            const exemptTag =
              po.taxExemptSavingsAmount > 0n
                ? ` (Tax Exempt Saved ${fmtUsd(po.taxExemptSavingsAmount)})`
                : "";
            const approveBtns =
              po.status === "PENDING_APPROVAL"
                ? `<div style="margin-top: 4px; display: flex; gap: 4px; flex-wrap: nowrap;">
                     <button type="button" class="btn" data-b2b-approve="${escapeHtml(po.poId)}" style="padding: 2px 8px; font-size: 11px; color: var(--accent-green);">Approve</button>
                     <button type="button" class="btn" data-b2b-reject="${escapeHtml(po.poId)}" style="padding: 2px 8px; font-size: 11px; color: var(--accent-amber);">Reject</button>
                   </div>`
                : "";
            const statusLabel = po.status.replaceAll("_", " ");
            return `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(po.poNumber)}</td>
        <td>${escapeHtml(po.buyerName)} <span class="mono" style="color: var(--text-muted); font-size: 11px;">(${escapeHtml(po.costCenterName)})</span></td>
        <td class="mono"><span class="accent-green">${fmtUsd(po.pricing.totalGrossAmount)}</span><span style="color: var(--text-secondary); font-size: 11px;">${escapeHtml(exemptTag)}</span></td>
        <td class="mono">${escapeHtml(msiHoldLabel)}</td>
        <td class="mono" style="font-size: 11px; color: var(--text-secondary); overflow-wrap: anywhere;">${escapeHtml(po.approverName ? `Signed by ${po.approverName}` : po.approvalReasons[0] ?? "Within Auto-Approve Limit")}</td>
        <td class="mono ${stClass}">${escapeHtml(statusLabel)}${approveBtns}</td>
      </tr>`;
          })
          .join("");

  const bodyHtml = `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">B2B Enterprise Organizations, Net-30 Credit Pool &amp; PO Approval Engine</h2>
          <p class="panel-subtitle">
            ${activeCompany ? `${escapeHtml(activeCompany.name)} (${escapeHtml(activeCompany.paymentTerms)} | ${(activeCompany.contractDiscountBps / 100).toFixed(2)}% Contract | Tax-Exempt: ${activeCompany.taxExemptVerified ? "VERIFIED" : "NO"}) | Credit Pool: ${fmtUsd(companyAvailCredit)} Avail / ${fmtUsd(activeCompany.creditUsed)} Used / ${fmtUsd(activeCompany.creditReserved)} Reserved` : "B2B Enterprise Organization Engine"}
          </p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-b2b-auto" class="btn" style="color: var(--accent-green);">Auto-Approve PO (&lt;=$2.5k)</button>
          <button type="button" id="btn-b2b-pending" class="btn" style="color: var(--accent-amber);">Pending PO (72h MSI Hold)</button>
          <button type="button" id="btn-b2b-approve" class="btn" style="color: var(--accent-blue);">Supervisor Approve PO</button>
          <button type="button" id="btn-b2b-reject" class="btn" style="color: var(--accent-amber);">Supervisor Reject PO</button>
          <button type="button" id="btn-b2b-credit-cap" class="btn" style="color: var(--accent-amber);">Exceed Net-30 Credit Cap</button>
        </div>
      </div>
      ${renderBanner("b2b-sim-banner", input.b2bSimulationSummary ?? "Ready: Kronos Robotics Corp ($50,000.00 Net-30 Credit Pool, 5.00% Contract Discount, Verified Tax-Exempt)")}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Dept Code</th>
              <th>Cost Center Name</th>
              <th>Monthly Budget</th>
              <th>Spent &amp; Held</th>
              <th>Remaining Budget</th>
            </tr>
          </thead>
          <tbody>
            ${b2bCostCenterRowsHtml}
          </tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Buyer Name</th>
              <th>Email</th>
              <th>B2B Role</th>
              <th>Auto-Approve Limit</th>
              <th>Supervisor Permission</th>
            </tr>
          </thead>
          <tbody>
            ${buyerRowsHtml}
          </tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>PO Number</th>
              <th>Buyer &amp; Cost Center</th>
              <th>PO Gross &amp; Tax Exemption</th>
              <th>MSI Hold / Order ID</th>
              <th>Policy Reason / Approver</th>
              <th>PO Status</th>
            </tr>
          </thead>
          <tbody>
            ${b2bPoRowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  `;

  const extraScriptHtml = `
  <script type="module">
    ${ADMIN_MUTATION_SCRIPT}
    async function runB2bAction(action, btnId, busyLabel, poId) {
      const btn = btnId ? document.getElementById(btnId) : null;
      if (btn && busyLabel) btn.textContent = busyLabel;
      await fetch("/api/demo/b2b", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, poId }),
      });
      window.location.reload();
    }

    document.getElementById("btn-b2b-auto")?.addEventListener("click", () =>
      runB2bAction("auto_approve_tax_exempt", "btn-b2b-auto", "Executing Auto-Approve PO...")
    );
    document.getElementById("btn-b2b-pending")?.addEventListener("click", () =>
      runB2bAction("pending_po_72h_hold", "btn-b2b-pending", "Reserving 72h MSI Hold...")
    );
    document.getElementById("btn-b2b-approve")?.addEventListener("click", () =>
      runB2bAction("approve_latest_pending_po", "btn-b2b-approve", "Approving PO via Saga...")
    );
    document.getElementById("btn-b2b-reject")?.addEventListener("click", () =>
      runB2bAction("reject_latest_pending_po", "btn-b2b-reject", "Releasing PO Hold...")
    );
    document.getElementById("btn-b2b-credit-cap")?.addEventListener("click", () =>
      runB2bAction("exceed_credit_limit", "btn-b2b-credit-cap", "Testing Credit Cap Gate...")
    );

    document.addEventListener("click", async (e) => {
      const appBtn = e.target.closest("button[data-b2b-approve]");
      if (appBtn) {
        const poId = appBtn.getAttribute("data-b2b-approve");
        if (poId) {
          appBtn.textContent = "Approving...";
          await runB2bAction("approve_latest_pending_po", null, null, poId);
        }
        return;
      }
      const rejBtn = e.target.closest("button[data-b2b-reject]");
      if (rejBtn) {
        const poId = rejBtn.getAttribute("data-b2b-reject");
        if (poId) {
          rejBtn.textContent = "Rejecting...";
          await runB2bAction("reject_latest_pending_po", null, null, poId);
        }
      }
    });
  </script>`;

  return { bodyHtml, extraScriptHtml };
}
