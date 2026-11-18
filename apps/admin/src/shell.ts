/**
 * Shared Saleor/Vendure-inspired App Shell, CSS Tokens, Sidebar Navigation,
 * Top Utility Bar, and Instant Cmd+K Command Palette for `@super-ecommerce/admin`.
 *
 * Design Invariants:
 * - Zero em-dashes and zero en-dashes in all rendered HTML and copy
 * - Consistent 8px panel / 6px control corner radius lock
 * - Instant Cmd+K palette (zero open/close animation per 100+/day rule)
 * - Tactile button press (`scale(0.97)`) and `prefers-reduced-motion: reduce`
 * - Zero horizontal page overflow at desktop (1440px), tablet (1024px), and mobile (375px)
 */

import { GUEST_ADMIN_PRINCIPAL } from "./types.ts";
import type {
  AdminDashboardRenderInput,
  AdminNavBadgeCounts,
  AdminRouteId,
} from "./types.ts";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function fmtMoney(minorUnits: bigint | number | string, currencyCode = "USD"): string {
  const sym = currencyCode === "EUR" ? "€" : "$";
  return `${sym}${(Number(minorUnits) / 100).toFixed(2)}`;
}

export interface RouteMeta {
  readonly id: AdminRouteId;
  readonly href: string;
  readonly group: "Commerce" | "Platform";
  readonly label: string;
  readonly title: string;
  readonly subtitle: string;
  readonly permissionHint?: string;
}

export const ADMIN_ROUTES: readonly RouteMeta[] = [
  {
    id: "overview",
    href: "/admin",
    group: "Commerce",
    label: "Overview",
    title: "Merchant Operations Overview",
    subtitle: "Live order telemetry, SSE event bus, inventory health, and PG mirror status",
  },
  {
    id: "orders",
    href: "/admin/orders",
    group: "Commerce",
    label: "Orders",
    title: "Orders & Saga Fulfillment Ledger",
    subtitle: "Search orders, inspect Two-Pass Hare-Niemeyer price waterfalls, and execute durable checkout sagas",
  },
  {
    id: "catalog",
    href: "/admin/catalog",
    group: "Commerce",
    label: "Catalog",
    title: "Catalog, Variants & Dynamic Attributes",
    subtitle: "Manage native and Saleor-projected products, variant pricing, channel publication, and JSONB facets",
  },
  {
    id: "discounts",
    href: "/admin/discounts",
    group: "Commerce",
    label: "Discounts",
    title: "Promotions, Vouchers & Precedence Rules",
    subtitle: "Enforce Manual > Voucher > Order Promotion precedence and manage active voucher rules",
  },
  {
    id: "inventory",
    href: "/admin/inventory",
    group: "Commerce",
    label: "Inventory",
    title: "Warehouses, MSI 3-Tier Stock & Search",
    subtitle: "Adjust OnHand stock, inspect direct vs legacy availability modes, reap expired holds, and test RRF search",
  },
  {
    id: "b2b",
    href: "/admin/b2b",
    group: "Commerce",
    label: "B2B & Credit",
    title: "B2B Organizations, Credit Pool & PO Approvals",
    subtitle: "Approve or reject pending Purchase Orders, monitor Net-30 credit pools, and audit cost centers",
  },
  {
    id: "configurator",
    href: "/admin/configurator",
    group: "Platform",
    label: "Configurator",
    title: "Channels & Commerce-as-Code GitOps",
    subtitle: "Configure sales channel stock modes and deploy 4-stage topological YAML/JSON configuration",
  },
  {
    id: "settings",
    href: "/admin/settings",
    group: "Platform",
    label: "Settings & RBAC",
    title: "RBAC Security, Webhooks & Outbox",
    subtitle: "Manage HMAC-SHA256 admin principals, audit RBAC decisions, replay DLQ, and verify Stripe webhooks",
  },
  {
    id: "lab",
    href: "/admin/lab",
    group: "Platform",
    label: "Developer Lab",
    title: "Engineering, Chaos & Benchmark Lab",
    subtitle: "SUPER_ADMIN engineering cockpit for Rust/WASM benchmarks, PG locking stress, AST DoS shield, and MCP Doctor",
    permissionHint: "SUPER_ADMIN",
  },
];

export function computeNavBadges(input: AdminDashboardRenderInput): AdminNavBadgeCounts {
  const pendingB2bPosCount = (input.b2bPurchaseOrders ?? []).filter(
    (p) => p.status === "PENDING_APPROVAL"
  ).length;
  const outboxAttentionCount =
    input.pendingOutboxEvents.length + (input.outboxStats?.deadLetterCount ?? 0);
  const catalogCount =
    (input.catalogProjections?.length ?? 0) ||
    (input.saleorLiveReport?.projections.length ?? 0) ||
    3;
  const activeVouchersCount = (input.vouchers ?? []).filter((v) => v.isActive).length;

  return {
    ordersCount: input.orders.length,
    pendingB2bPosCount,
    outboxAttentionCount,
    catalogProductsCount: catalogCount,
    activeVouchersCount,
    configChangesCount: input.configDiffPlan.totalChanges,
  };
}

export function renderAdminShellHtml(params: {
  readonly input: AdminDashboardRenderInput;
  readonly activeRoute: AdminRouteId;
  readonly pageTitle?: string;
  readonly pageSubtitle?: string;
  readonly bodyHtml: string;
  readonly extraScriptHtml?: string;
}): string {
  const { input, activeRoute, bodyHtml, extraScriptHtml } = params;
  const activePrincipal = input.activePrincipal ?? GUEST_ADMIN_PRINCIPAL;
  const hasChaosPerm = activePrincipal.permissions.includes("chaos:inject_faults");
  const badges = computeNavBadges(input);
  const routeMeta =
    ADMIN_ROUTES.find((r) => r.id === activeRoute) ??
    (activeRoute === "order_detail"
      ? {
          id: "order_detail" as const,
          href: `/admin/orders/${encodeURIComponent(input.selectedOrder?.orderId ?? "")}`,
          group: "Commerce" as const,
          label: "Order Detail",
          title: `Order ${input.selectedOrder?.orderId ?? "Detail"}`,
          subtitle:
            "Two-pass Hare-Niemeyer discount attribution, MSI fulfillment slices, and Admin RMA refund execution",
        }
      : ADMIN_ROUTES[0]!);

  const resolvedTitle = params.pageTitle ?? routeMeta.title;
  const resolvedSubtitle = params.pageSubtitle ?? routeMeta.subtitle;

  const badgeForRoute = (id: AdminRouteId): { text: string; tone?: "warn" | "info" | "ok" } | null => {
    if (id === "orders" && badges.ordersCount > 0) {
      return { text: String(badges.ordersCount), tone: "info" };
    }
    if (id === "b2b" && badges.pendingB2bPosCount > 0) {
      return { text: `${badges.pendingB2bPosCount} hold`, tone: "warn" };
    }
    if (id === "catalog" && badges.catalogProductsCount > 0) {
      return { text: String(badges.catalogProductsCount), tone: "info" };
    }
    if (id === "discounts" && badges.activeVouchersCount > 0) {
      return { text: String(badges.activeVouchersCount), tone: "ok" };
    }
    if (id === "configurator" && badges.configChangesCount > 0) {
      return { text: `${badges.configChangesCount} diff`, tone: "warn" };
    }
    if (id === "settings" && badges.outboxAttentionCount > 0) {
      return { text: String(badges.outboxAttentionCount), tone: "warn" };
    }
    if (id === "lab") {
      return { text: hasChaosPerm ? "UNLOCKED" : "403 LOCK", tone: hasChaosPerm ? "ok" : "warn" };
    }
    return null;
  };

  const renderGroup = (groupName: "Commerce" | "Platform") => {
    const items = ADMIN_ROUTES.filter((r) => r.group === groupName);
    return `
      <div class="nav-group">
        <div class="nav-group-label">${escapeHtml(groupName)}</div>
        <nav class="nav-list" aria-label="${escapeHtml(groupName)} Navigation">
          ${items
            .map((item) => {
              const isActive =
                activeRoute === item.id ||
                (activeRoute === "order_detail" && item.id === "orders");
              const badge = badgeForRoute(item.id);
              const badgeHtml = badge
                ? `<span class="nav-badge badge-${badge.tone ?? "info"} mono">${escapeHtml(badge.text)}</span>`
                : "";
              return `
          <a href="${escapeHtml(item.href)}" class="nav-link ${isActive ? "active" : ""}" ${isActive ? 'aria-current="page"' : ""}>
            <span class="nav-dot" aria-hidden="true"></span>
            <span class="nav-label">${escapeHtml(item.label)}</span>
            ${badgeHtml}
          </a>`;
            })
            .join("")}
        </nav>
      </div>`;
  };

  const pgConnected = Boolean(input.pgContainerStatus?.connected);
  const pgSummary = pgConnected
    ? `${input.pgContainerStatus!.containerName} (${input.pgContainerStatus!.tableCount} tbl)`
    : input.pgContainerStatus ? "PG Offline" : "Not checked";

  const roleTone =
    activePrincipal.role === "SUPER_ADMIN"
      ? "accent-green"
      : activePrincipal.role === "MERCHANT_OPS"
      ? "accent-blue"
      : "accent-amber";

  const cmdkRouteItemsHtml = ADMIN_ROUTES.map(
    (r) => `
      <li data-cmdk-keywords="${escapeHtml((r.label + " " + r.title + " " + r.group).toLowerCase())}">
        <a class="cmdk-item" href="${escapeHtml(r.href)}" data-cmdk-href="${escapeHtml(r.href)}">
          <span>
            <span style="display: block; font-weight: 600;">Go to ${escapeHtml(r.label)}</span>
            <span class="mono" style="font-size: 11px; color: var(--text-muted);">${escapeHtml(r.href)}</span>
          </span>
          <span class="kbd mono">${escapeHtml(r.group)}</span>
        </a>
      </li>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#090A0F" />
  <title>${escapeHtml(resolvedTitle)} // Super Ecommerce Admin</title>
  <style>
    :root {
      color-scheme: dark;
      --bg-canvas: #090A0F;
      --bg-surface: #10121A;
      --bg-elevated: #161924;
      --bg-hover: #1C2030;
      --text-primary: #F1F5F9;
      --text-secondary: #94A3B8;
      --text-muted: #8A99B0;
      --line: rgba(255, 255, 255, 0.08);
      --line-strong: rgba(255, 255, 255, 0.14);
      --accent-blue: #60A5FA;
      --button-primary: #2563EB;
      --accent-green: #10B981;
      --accent-amber: #F59E0B;
      --accent-red: #F87171;
      --sidebar-width: 248px;
      --topbar-height: 56px;
      --radius-panel: 8px;
      --radius-control: 6px;
      --ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      min-height: 100%;
      overflow-x: clip;
    }

    body {
      font-family: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background-color: var(--bg-canvas);
      color: var(--text-primary);
      font-size: 13px;
      line-height: 1.48;
      -webkit-font-smoothing: antialiased;
    }

    a { color: inherit; }

    :focus-visible {
      outline: 2px solid var(--accent-blue);
      outline-offset: 3px;
    }

    .skip-link {
      position: fixed;
      top: 8px;
      left: 8px;
      z-index: 100;
      padding: 10px 14px;
      border-radius: var(--radius-control);
      background: var(--bg-surface);
      color: var(--text-primary);
      transform: translateY(calc(-100% - 16px));
    }

    .skip-link:focus { transform: none; }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }

    body.sidebar-open { overflow: hidden; }

    .mono {
      font-family: "Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
      font-variant-numeric: tabular-nums;
    }

    .num { text-align: right; white-space: nowrap; }
    .accent-blue { color: var(--accent-blue); font-weight: 600; }
    .accent-green { color: var(--accent-green); font-weight: 600; }
    .accent-amber { color: var(--accent-amber); font-weight: 600; }
    .accent-red { color: var(--accent-red); font-weight: 600; }

    /* Two-Zone App Shell */
    .app-shell {
      display: grid;
      grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
      min-height: 100dvh;
    }

    .sidebar {
      position: sticky;
      top: 0;
      height: 100dvh;
      background: var(--bg-surface);
      border-right: 1px solid var(--line);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 14px 12px;
      overflow-y: auto;
      z-index: 40;
    }

    .sidebar-brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px 14px 8px;
      border-bottom: 1px solid var(--line);
      margin-bottom: 14px;
      gap: 8px;
    }

    .brand-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }

    .brand-sub {
      font-size: 11px;
      color: var(--text-muted);
    }

    .nav-group {
      margin-bottom: 16px;
    }

    .nav-group-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      padding: 0 10px 6px 10px;
      letter-spacing: 0.02em;
    }

    .nav-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .nav-link {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 7px 10px;
      border-radius: var(--radius-control);
      text-decoration: none;
      color: var(--text-secondary);
      font-weight: 500;
      font-size: 13px;
      border: 1px solid transparent;
      transition: background-color 140ms var(--ease-out-strong), color 140ms var(--ease-out-strong), border-color 140ms var(--ease-out-strong), transform 120ms var(--ease-out-strong);
    }

    .nav-link:hover {
      background: var(--bg-elevated);
      color: var(--text-primary);
    }

    .nav-link:active {
      transform: scale(0.98);
    }

    .nav-link.active {
      background: var(--bg-elevated);
      border-color: var(--line-strong);
      color: var(--text-primary);
      font-weight: 600;
    }

    .nav-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--text-muted);
      flex-shrink: 0;
    }

    .nav-link.active .nav-dot {
      background: var(--accent-blue);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.22);
    }

    .nav-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .nav-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 4px;
      border: 1px solid var(--line);
      flex-shrink: 0;
    }

    .badge-info { color: var(--text-secondary); background: rgba(255, 255, 255, 0.03); }
    .badge-ok { color: var(--accent-green); background: rgba(16, 185, 129, 0.12); border-color: rgba(16, 185, 129, 0.25); }
    .badge-warn { color: var(--accent-amber); background: rgba(245, 158, 11, 0.12); border-color: rgba(245, 158, 11, 0.25); }

    .sidebar-footer {
      border-top: 1px solid var(--line);
      padding-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .sidebar-status-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px;
      background: var(--bg-canvas);
      border: 1px solid var(--line);
      border-radius: var(--radius-control);
      font-size: 11px;
    }

    .workspace {
      min-width: 0;
      display: flex;
      flex-direction: column;
    }

    /* Sticky Topbar (56px) */
    .topbar {
      position: sticky;
      top: 0;
      min-height: var(--topbar-height);
      background: rgba(16, 18, 26, 0.92);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--line);
      padding: 8px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      z-index: 30;
    }

    .topbar-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .btn.mobile-menu-btn {
      display: none;
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-secondary);
      flex-wrap: wrap;
    }

    .breadcrumb strong {
      color: var(--text-primary);
      font-weight: 600;
    }

    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .page-content {
      width: 100%;
      max-width: 1360px;
      margin: 0 auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-width: 0;
      scroll-margin-top: calc(var(--topbar-height) + 20px);
    }

    .page-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 14px;
      flex-wrap: wrap;
      padding-bottom: 4px;
    }

    .page-title {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }

    .page-subtitle {
      font-size: 13px;
      color: var(--text-secondary);
      max-width: 78ch;
      margin-top: 3px;
    }

    /* Controls & Buttons */
    .btn {
      background: var(--bg-canvas);
      border: 1px solid var(--line);
      color: var(--text-secondary);
      padding: 6px 12px;
      border-radius: var(--radius-control);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      text-decoration: none;
      white-space: nowrap;
      transition: transform 140ms var(--ease-out-strong), border-color 140ms ease-out, background-color 140ms ease-out, color 140ms ease-out;
    }

    .btn:hover {
      border-color: var(--line-strong);
      color: var(--text-primary);
      background: var(--bg-elevated);
    }

    .btn:active {
      transform: scale(0.97);
    }

    .btn-primary {
      background: var(--button-primary);
      border-color: var(--button-primary);
      color: #FFFFFF;
      font-weight: 600;
    }

    .btn-primary:hover {
      background: #1D4ED8;
      border-color: #1D4ED8;
      color: #FFFFFF;
    }

    .cmdk-trigger {
      background: var(--bg-canvas);
      border: 1px solid var(--line);
      color: var(--text-secondary);
      padding: 6px 12px;
      border-radius: var(--radius-control);
      font-size: 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      white-space: nowrap;
      transition: transform 140ms var(--ease-out-strong), border-color 140ms ease-out;
    }

    .cmdk-trigger:hover {
      border-color: var(--line-strong);
      color: var(--text-primary);
    }

    .cmdk-trigger:active {
      transform: scale(0.97);
    }

    .kbd {
      background: rgba(255, 255, 255, 0.07);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
    }

    /* Grids & KPI Strip */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }

    .kpi-card {
      background: var(--bg-surface);
      border: 1px solid var(--line);
      border-radius: var(--radius-panel);
      padding: 14px 16px;
      min-width: 0;
    }

    .kpi-label {
      font-size: 12px;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }

    .kpi-value {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }

    .kpi-meta {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .split-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }

    /* Panels & Tables */
    .panel {
      background: var(--bg-surface);
      border: 1px solid var(--line);
      border-radius: var(--radius-panel);
      overflow: hidden;
      min-width: 0;
    }

    .panel-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }

    .panel-title {
      font-size: 13px;
      font-weight: 650;
      color: var(--text-primary);
    }

    .panel-subtitle {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .panel-actions {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }

    .panel-banner {
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      color: var(--text-secondary);
      font-size: 12px;
      background: rgba(255, 255, 255, 0.015);
    }

    .panel-body {
      padding: 16px;
    }

    .table-wrap {
      width: 100%;
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th, td {
      padding: 9px 14px;
      text-align: left;
      border-bottom: 1px solid var(--line);
      vertical-align: middle;
    }

    th {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.02);
      white-space: nowrap;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tbody tr:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .empty-cell {
      color: var(--text-muted);
      text-align: center;
      padding: 20px;
    }

    .op-badge {
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
    }

    .op-create { background: rgba(16, 185, 129, 0.15); color: var(--accent-green); }
    .op-update { background: rgba(59, 130, 246, 0.15); color: var(--accent-blue); }
    .op-delete { background: rgba(245, 158, 11, 0.15); color: var(--accent-amber); }

    /* Forms */
    .form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      align-items: end;
    }

    .field-label {
      display: block;
      font-size: 11px;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 5px;
    }

    .field-input, .field-select {
      width: 100%;
      background: var(--bg-canvas);
      border: 1px solid var(--line);
      border-radius: var(--radius-control);
      color: var(--text-primary);
      padding: 7px 10px;
      font-size: 12px;
    }

    .field-input:focus, .field-select:focus {
      border-color: var(--accent-blue);
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.03);
      white-space: nowrap;
    }

    /* Instant Command Palette (Zero animation per Emil Kowalski's 100+/day shortcut rule) */
    .cmdk-backdrop {
      position: fixed;
      inset: 0;
      width: 100%;
      max-width: none;
      height: 100dvh;
      max-height: none;
      margin: 0;
      border: 0;
      background: transparent;
      color: var(--text-primary);
      display: none;
      align-items: flex-start;
      justify-content: center;
      padding: 12vh 16px 16px 16px;
      overscroll-behavior: contain;
    }

    .cmdk-backdrop[open] { display: flex; }
    .cmdk-backdrop::backdrop { background: rgba(0, 0, 0, 0.65); }
    .cmdk-backdrop, .cmdk-backdrop * { animation: none; transition: none; }
    .cmdk-backdrop .btn:active { transform: none; }

    .cmdk-modal {
      width: 100%;
      max-width: 560px;
      max-height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--bg-surface);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-panel);
      overflow: hidden;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
    }

    .cmdk-search-row {
      display: flex;
      align-items: center;
      padding-right: 12px;
      border-bottom: 1px solid var(--line);
    }

    .cmdk-input {
      width: 100%;
      min-width: 0;
      background: transparent;
      border: none;
      color: var(--text-primary);
      padding: 14px 16px;
      font-size: 16px;
    }

    .cmdk-input:focus-visible { outline-offset: -3px; }

    .cmdk-list {
      list-style: none;
      padding: 6px;
      max-height: 360px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }

    .cmdk-item {
      width: 100%;
      padding: 9px 12px;
      border: 0;
      border-radius: var(--radius-control);
      background: transparent;
      font: inherit;
      text-align: left;
      text-decoration: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      color: var(--text-primary);
      gap: 12px;
    }

    .cmdk-item:hover, .cmdk-item.selected {
      background: var(--bg-elevated);
    }

    .cmdk-status {
      padding: 8px 16px;
      color: var(--text-secondary);
      font-size: 12px;
      border-top: 1px solid var(--line);
    }

    .sidebar-scrim {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      z-index: 35;
    }

    @media (max-width: 960px) {
      .app-shell {
        grid-template-columns: 1fr;
      }
      .sidebar {
        position: fixed;
        left: 0;
        top: 0;
        width: min(264px, 100vw);
        visibility: hidden;
        transform: translateX(-100%);
        transition: transform 220ms var(--ease-out-strong);
        overscroll-behavior: contain;
      }
      body.sidebar-open .sidebar {
        visibility: visible;
        transform: translateX(0);
      }
      body.sidebar-open .sidebar-scrim {
        display: block;
      }
      .btn.mobile-menu-btn {
        display: inline-flex;
      }
      .kpi-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .split-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 560px) {
      .kpi-grid {
        grid-template-columns: 1fr;
      }
      .page-content {
        padding: 14px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <a href="#admin-main" class="skip-link" id="admin-skip-link">Skip to main content</a>
  <div class="sidebar-scrim" id="sidebar-scrim" aria-hidden="true"></div>
  <div class="app-shell">
    <aside class="sidebar" id="admin-sidebar" aria-label="Admin Navigation Sidebar">
      <div>
        <div class="sidebar-brand">
          <div>
            <div class="brand-title">SUPER ECOMMERCE</div>
            <div class="brand-sub mono">Merchant Backoffice</div>
          </div>
          <span class="pill mono accent-blue" style="font-size: 10px;">v2</span>
          <button type="button" id="btn-close-sidebar" class="btn mobile-menu-btn" aria-label="Close Navigation Menu">Close</button>
        </div>

        ${renderGroup("Commerce")}
        ${renderGroup("Platform")}
      </div>

      <div class="sidebar-footer">
        <div class="sidebar-status-row">
          <span style="color: var(--text-secondary);">PG Mirror</span>
          <span class="mono ${pgConnected ? "accent-green" : "accent-amber"}">${escapeHtml(pgSummary)}</span>
        </div>
        <div class="sidebar-status-row">
          <span style="color: var(--text-secondary);">Telemetry Bus</span>
          <span id="sidebar-sse-pill" class="mono accent-blue">CONNECTING</span>
        </div>
        <div class="sidebar-status-row" style="flex-direction: column; align-items: flex-start; gap: 4px;">
          <div class="mono ${roleTone}" style="font-size: 11px;">${escapeHtml(activePrincipal.role)} (${activePrincipal.permissions.length}/7)</div>
          <div class="mono" style="font-size: 11px; color: var(--text-muted); word-break: break-all;">${escapeHtml(activePrincipal.email)}</div>
          <div style="display: flex; gap: 6px; width: 100%; margin-top: 2px;">
            <a href="/admin/login?next=${encodeURIComponent(routeMeta.href)}" class="btn" style="flex: 1; padding: 4px 8px; font-size: 11px;">Switch Role</a>
            <button type="button" id="btn-admin-logout" class="btn" style="padding: 4px 8px; font-size: 11px; color: var(--accent-amber);">Sign Out</button>
          </div>
        </div>
      </div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="topbar-left">
          <button type="button" id="btn-mobile-sidebar" class="btn mobile-menu-btn" aria-label="Toggle Navigation Menu" aria-expanded="false" aria-controls="admin-sidebar">
            Menu
          </button>
          <div class="breadcrumb">
            <a href="/admin" style="text-decoration: none;">Admin</a>
            <span>/</span>
            <span class="mono" style="color: var(--text-muted);">${escapeHtml(routeMeta.group)}</span>
            <span>/</span>
            <strong>${escapeHtml(routeMeta.label)}</strong>
          </div>
        </div>

        <div class="topbar-actions">
          <span id="sse-conn-badge" class="mono accent-blue" style="font-size: 11px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 4px;">
            SSE CONNECTING...
          </span>
          <button type="button" id="btn-open-cmdk" class="cmdk-trigger" aria-haspopup="dialog" aria-controls="cmdk-backdrop" aria-expanded="false" aria-keyshortcuts="Meta+K Control+K">
            <span>Command Palette</span>
            <span class="kbd mono">Cmd+K</span>
          </button>
          <a href="/" class="btn">Storefront</a>
        </div>
      </header>

      <main class="page-content" id="admin-main" tabindex="-1">
        <div class="page-head">
          <div>
            <h1 class="page-title">${escapeHtml(resolvedTitle)}</h1>
            <p class="page-subtitle">${escapeHtml(resolvedSubtitle)}</p>
          </div>
        </div>

        ${bodyHtml}
      </main>
    </div>
  </div>

  <dialog id="cmdk-backdrop" class="cmdk-backdrop" aria-label="Command Palette">
    <div class="cmdk-modal">
      <div class="cmdk-search-row">
        <label for="cmdk-input" class="sr-only">Search commands</label>
        <input type="search" id="cmdk-input" name="command" class="cmdk-input" autocomplete="off" spellcheck="false" placeholder="Find a route or action (e.g. Orders)…" />
        <button type="button" id="btn-close-cmdk" class="btn">Close</button>
      </div>
      <ul class="cmdk-list" id="cmdk-list" aria-label="Command destinations and actions">
        ${cmdkRouteItemsHtml}
        <li data-cmdk-keywords="execute sample saga checkout us-retail action">
          <button type="button" class="cmdk-item" id="cmd-trigger-checkout">
            <span>
              <span style="display: block; font-weight: 600;">Execute Sample Saga Checkout (us-retail)</span>
              <span class="mono" style="font-size: 11px; color: var(--text-muted);">POST /api/demo/checkout</span>
            </span>
            <span class="kbd mono">Action</span>
          </button>
        </li>
        <li data-cmdk-keywords="switch to edge storefront customer view">
          <a class="cmdk-item" id="cmd-go-storefront" href="/">
            <span>
              <span style="display: block; font-weight: 600;">Switch to Edge Storefront</span>
              <span class="mono" style="font-size: 11px; color: var(--text-muted);">/</span>
            </span>
            <span class="kbd mono">Storefront</span>
          </a>
        </li>
      </ul>
      <p class="cmdk-status" id="cmdk-status" role="status" aria-live="polite" aria-atomic="true"></p>
    </div>
  </dialog>

  <script type="module">
    const backdrop = document.getElementById("cmdk-backdrop");
    const openBtn = document.getElementById("btn-open-cmdk");
    const inputEl = document.getElementById("cmdk-input");
    const cmdkList = document.getElementById("cmdk-list");
    const cmdkStatus = document.getElementById("cmdk-status");
    const cmdkItems = Array.from(cmdkList.querySelectorAll(".cmdk-item"));
    const mobileMenuBtn = document.getElementById("btn-mobile-sidebar");
    const closeSidebarBtn = document.getElementById("btn-close-sidebar");
    const sidebar = document.getElementById("admin-sidebar");
    const workspace = document.querySelector(".workspace");
    const skipLink = document.getElementById("admin-skip-link");
    const sidebarScrim = document.getElementById("sidebar-scrim");
    const mobileLayout = window.matchMedia("(max-width: 960px)");
    let paletteReturnFocus = null;

    function setSidebarOpen(open, restoreFocus = true) {
      const wasOpen = document.body.classList.contains("sidebar-open");
      const next = mobileLayout.matches && open;
      document.body.classList.toggle("sidebar-open", next);
      mobileMenuBtn.setAttribute("aria-expanded", String(next));
      sidebar.inert = mobileLayout.matches && !next;
      workspace.inert = next;
      skipLink.inert = next;
      if (next) {
        sidebar.setAttribute("role", "dialog");
        sidebar.setAttribute("aria-modal", "true");
        closeSidebarBtn.focus();
      } else {
        sidebar.removeAttribute("role");
        sidebar.removeAttribute("aria-modal");
        if (wasOpen && restoreFocus) {
          if (mobileLayout.matches) mobileMenuBtn.focus();
          else sidebar.querySelector('a[aria-current="page"]')?.focus();
        }
      }
    }

    mobileMenuBtn.addEventListener("click", () => setSidebarOpen(!document.body.classList.contains("sidebar-open")));
    closeSidebarBtn.addEventListener("click", () => setSidebarOpen(false));
    sidebarScrim.addEventListener("click", () => setSidebarOpen(false));
    mobileLayout.addEventListener("change", () => setSidebarOpen(false));
    setSidebarOpen(false);

    function toggleCmdk(force) {
      const next = typeof force === "boolean" ? force : !backdrop.open;
      if (next === backdrop.open) return;
      openBtn.setAttribute("aria-expanded", String(next));
      if (next) {
        setSidebarOpen(false);
        paletteReturnFocus = document.activeElement;
        inputEl.value = "";
        filterCmdkItems("");
        backdrop.showModal();
        inputEl.focus();
      } else {
        backdrop.close();
      }
    }

    function visibleCmdkItems() {
      return cmdkItems.filter((item) => !item.closest("li").hidden && !item.disabled);
    }

    function filterCmdkItems(query) {
      const q = String(query || "").trim().toLowerCase();
      let firstVisible = null;
      let count = 0;
      for (const item of cmdkItems) {
        const row = item.closest("li");
        const kw = row.getAttribute("data-cmdk-keywords") || item.textContent.toLowerCase();
        const visible = !q || kw.includes(q);
        row.hidden = !visible;
        item.classList.remove("selected");
        if (visible) {
          count += 1;
          if (!firstVisible) firstVisible = item;
        }
      }
      firstVisible?.classList.add("selected");
      cmdkStatus.textContent = count ? count + " commands. Use arrow keys to browse or Tab to move between controls." : "No matching commands. Try Orders, Catalog, or Settings.";
    }

    function selectCmdkItem(item) {
      cmdkItems.forEach((candidate) => candidate.classList.toggle("selected", candidate === item));
    }

    openBtn.addEventListener("click", () => toggleCmdk(true));
    document.getElementById("btn-close-cmdk").addEventListener("click", () => toggleCmdk(false));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) toggleCmdk(false);
    });
    backdrop.addEventListener("cancel", (e) => {
      e.preventDefault();
      toggleCmdk(false);
    });
    backdrop.addEventListener("close", () => {
      if (backdrop.open) return;
      openBtn.setAttribute("aria-expanded", "false");
      const target = paletteReturnFocus;
      paletteReturnFocus = null;
      if (target?.isConnected && !target.closest("[inert]")) target.focus();
    });

    inputEl.addEventListener("input", () => filterCmdkItems(inputEl.value));
    cmdkList.addEventListener("focusin", (e) => {
      const item = e.target.closest(".cmdk-item");
      if (item) selectCmdkItem(item);
    });
    backdrop.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      const visibleItems = visibleCmdkItems();
      const currentIdx = visibleItems.indexOf(document.activeElement);
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (e.target === inputEl || currentIdx >= 0)) {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        const nextIdx = currentIdx < 0 ? (step > 0 ? 0 : visibleItems.length - 1) : (currentIdx + step + visibleItems.length) % visibleItems.length;
        const chosen = visibleItems[nextIdx];
        if (chosen) {
          selectCmdkItem(chosen);
          chosen.focus();
          chosen.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "Enter" && e.target === inputEl) {
        e.preventDefault();
        visibleItems.find((item) => item.classList.contains("selected"))?.click();
      }
    });

    window.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k" && !e.repeat) {
        e.preventDefault();
        toggleCmdk();
      } else if (e.key === "Escape") {
        if (backdrop.open) {
          e.preventDefault();
          toggleCmdk(false);
        } else if (document.body.classList.contains("sidebar-open")) {
          e.preventDefault();
          setSidebarOpen(false);
        }
      } else if (e.key === "Tab" && document.body.classList.contains("sidebar-open")) {
        const controls = Array.from(sidebar.querySelectorAll('a[href], button:not([disabled])'));
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    });

    cmdkList.addEventListener("click", async (e) => {
      const item = e.target.closest(".cmdk-item");
      if (item?.id !== "cmd-trigger-checkout" || item.disabled) return;
      item.disabled = true;
      cmdkStatus.textContent = "Executing sample checkout…";
      try {
        const response = await fetch("/api/demo/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelSlug: "us-retail", scenario: "healthy_5step_saga" }),
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        window.location.reload();
      } catch {
        cmdkStatus.textContent = "Checkout failed. Check your connection and permissions, then try again.";
      } finally {
        item.disabled = false;
      }
    });

    document.getElementById("btn-admin-logout")?.addEventListener("click", async () => {
      await fetch("/api/admin/logout", { method: "POST" });
      window.location.href = "/admin/login";
    });

    const sseBadge = document.getElementById("sse-conn-badge");
    const sidebarSsePill = document.getElementById("sidebar-sse-pill");
    const sseTbody = document.getElementById("sse-events-tbody");
    window.__adminSsePaused = false;
    let sseSource = null;

    function escapeDom(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function renderSseRowHtml(evt) {
      const sevClass =
        evt.severity === "OK"
          ? "accent-green"
          : evt.severity === "WARN"
          ? "accent-amber"
          : "accent-blue";
      const timeOnly = String(evt.timestampIso || "").replace(/^.*T/, "");
      return (
        "<tr>" +
        '<td class="mono accent-blue" style="white-space: nowrap;">' + escapeDom(evt.eventId) + "</td>" +
        '<td class="mono ' + sevClass + '" style="white-space: nowrap;">' + escapeDom(evt.channel) + "</td>" +
        '<td style="font-weight: 600;">' + escapeDom(evt.summary) + "</td>" +
        '<td class="mono" style="color: var(--text-secondary); max-width: 280px; word-break: break-word;">' + escapeDom(evt.detail || "-") + "</td>" +
        '<td class="mono num" style="white-space: nowrap; color: var(--text-muted);">' + escapeDom(timeOnly) + "</td>" +
        "</tr>"
      );
    }

    function setSseBadgeState(text, cls) {
      if (sseBadge) {
        sseBadge.textContent = text;
        sseBadge.className = "mono " + cls;
      }
      if (sidebarSsePill) {
        sidebarSsePill.textContent = text.startsWith("SSE LIVE") ? "LIVE" : text.startsWith("SSE PAUSED") ? "PAUSED" : "RECONNECT";
        sidebarSsePill.className = "mono " + cls;
      }
    }

    function connectSseStream() {
      if (typeof EventSource === "undefined") return;
      if (sseSource) sseSource.close();
      sseSource = new EventSource("/api/admin/events");
      sseSource.addEventListener("open", () => {
        setSseBadgeState("SSE LIVE (/api/admin/events)", "accent-green");
      });
      sseSource.addEventListener("snapshot", (msg) => {
        if (window.__adminSsePaused || !sseTbody) return;
        try {
          const payload = JSON.parse(msg.data);
          if (Array.isArray(payload.events) && payload.events.length > 0) {
            sseTbody.innerHTML = payload.events.slice(0, 12).map(renderSseRowHtml).join("");
          }
        } catch {
          // ignore
        }
      });
      sseSource.addEventListener("telemetry", (msg) => {
        if (window.__adminSsePaused || !sseTbody) return;
        try {
          const evt = JSON.parse(msg.data);
          const emptyRow = sseTbody.querySelector(".empty-cell");
          if (emptyRow) sseTbody.innerHTML = "";
          sseTbody.insertAdjacentHTML("afterbegin", renderSseRowHtml(evt));
          while (sseTbody.children.length > 12) {
            sseTbody.lastElementChild?.remove();
          }
        } catch {
          // ignore
        }
      });
      sseSource.addEventListener("error", () => {
        if (!window.__adminSsePaused) {
          setSseBadgeState("SSE RECONNECTING...", "accent-amber");
        }
      });
    }

    connectSseStream();

    document.getElementById("btn-sse-toggle")?.addEventListener("click", () => {
      window.__adminSsePaused = !window.__adminSsePaused;
      const btn = document.getElementById("btn-sse-toggle");
      if (btn) btn.textContent = window.__adminSsePaused ? "Resume Stream" : "Pause Stream";
      setSseBadgeState(
        window.__adminSsePaused ? "SSE PAUSED" : "SSE LIVE (/api/admin/events)",
        window.__adminSsePaused ? "accent-amber" : "accent-green"
      );
    });

    document.getElementById("btn-sse-clear")?.addEventListener("click", () => {
      if (sseTbody) {
        sseTbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Stream buffer cleared. Waiting for next live telemetry frame...</td></tr>';
      }
    });

    document.getElementById("btn-sse-ping")?.addEventListener("click", async () => {
      await fetch("/api/admin/events/ping", { method: "POST" });
    });
  </script>
  ${extraScriptHtml ?? ""}
</body>
</html>`;
}
