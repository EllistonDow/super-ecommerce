/**
 * `@super-ecommerce/admin`
 *
 * Saleor / Vendure-style Multi-Route Merchant Backoffice & Engineering Lab.
 * Architecture: Fixed 248px left sidebar (responsive drawer <960px), 56px top utility bar
 * with instant Cmd+K cross-route command palette, live SSE telemetry bus, and 10 routes:
 * - `/admin` (`overview`)
 * - `/admin/orders` (`orders`)
 * - `/admin/orders/:id` (`order_detail`)
 * - `/admin/catalog` (`catalog`)
 * - `/admin/discounts` (`discounts`)
 * - `/admin/inventory` (`inventory`)
 * - `/admin/b2b` (`b2b`)
 * - `/admin/configurator` (`configurator`)
 * - `/admin/settings` (`settings`)
 * - `/admin/lab` (`lab` - RBAC gated to `chaos:inject_faults`)
 */

import { SEEDED_ADMIN_ACCOUNTS, type AdminPrincipal } from "@super-ecommerce/core";
import {
  escapeHtml,
  renderAdminShellHtml,
} from "./shell.ts";
import {
  renderB2bRoute,
  renderCatalogRoute,
  renderDiscountsRoute,
  renderInventoryRoute,
  renderOrderDetailRoute,
  renderOrdersRoute,
  renderOverviewRoute,
} from "./routes-commerce.ts";
import {
  renderConfiguratorRoute,
  renderLabRoute,
  renderSettingsRoute,
} from "./routes-platform.ts";
import type {
  AdminDashboardRenderInput,
  AdminRouteId,
} from "./types.ts";

export type {
  AdminCatalogVariantView,
  AdminDashboardRenderInput,
  AdminNavBadgeCounts,
  AdminRouteId,
  AdminTelemetryEventView,
  AdminVoucherRuleView,
  SagaAuditMetricsView,
} from "./types.ts";

export { ADMIN_ROUTES, computeNavBadges } from "./shell.ts";
export { GUEST_ADMIN_PRINCIPAL } from "./types.ts";

export function renderAdminDashboardHtml(input: AdminDashboardRenderInput): string {
  const activeRoute: AdminRouteId = input.activeRoute ?? "overview";

  let routeContent: {
    readonly bodyHtml: string;
    readonly extraScriptHtml: string;
  };
  let pageTitle: string | undefined;
  let pageSubtitle: string | undefined;

  switch (activeRoute) {
    case "orders":
      routeContent = renderOrdersRoute(input);
      break;
    case "order_detail":
      routeContent = renderOrderDetailRoute(input);
      pageTitle = input.selectedOrder
        ? `Order ${input.selectedOrder.orderId}`
        : "Order Detail";
      pageSubtitle = input.selectedOrder
        ? `Channel ${input.selectedOrder.channelSlug} | Status ${input.selectedOrder.paymentStatus ?? "CAPTURED"} | Two-Pass Hare-Niemeyer Attribution & RMA Refund Console`
        : "Inspect order details, price waterfall, and partial RMA returns";
      break;
    case "catalog":
      routeContent = renderCatalogRoute(input);
      break;
    case "discounts":
      routeContent = renderDiscountsRoute(input);
      break;
    case "inventory":
      routeContent = renderInventoryRoute(input);
      break;
    case "b2b":
      routeContent = renderB2bRoute(input);
      break;
    case "configurator":
      routeContent = renderConfiguratorRoute(input);
      break;
    case "settings":
      routeContent = renderSettingsRoute(input);
      break;
    case "lab":
      routeContent = renderLabRoute(input);
      break;
    case "overview":
    default:
      routeContent = renderOverviewRoute(input);
      break;
  }

  return renderAdminShellHtml({
    input,
    activeRoute,
    pageTitle,
    pageSubtitle,
    bodyHtml: routeContent.bodyHtml,
    extraScriptHtml: routeContent.extraScriptHtml,
  });
}

function sanitizeSafeAdminNextPath(raw?: string): string {
  if (!raw || !/^\/admin(?:[/?#]|$)/.test(raw) || /[\\\u0000-\u001f\u007f]/.test(raw)) return "/admin";
  try {
    const target = new URL(raw, "https://admin.invalid");
    if (target.origin !== "https://admin.invalid" || !/^\/admin(?:\/|$)/.test(target.pathname)) return "/admin";
    return raw;
  } catch {
    return "/admin";
  }
}

export function renderAdminLoginHtml(options?: {
  readonly errorMessage?: string;
  readonly currentPrincipal?: AdminPrincipal;
  readonly nextPath?: string;
  readonly showDemoCredentials?: boolean;
}): string {
  const showDemo =
    options?.showDemoCredentials ??
    (process.env["NODE_ENV"] !== "production" ||
      process.env["SUPER_SHOW_DEMO_CREDENTIALS"] === "1");
  const safeNext = sanitizeSafeAdminNextPath(options?.nextPath);
  const nextTargetJson = JSON.stringify(safeNext)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
  const accountCardsHtml = showDemo
    ? SEEDED_ADMIN_ACCOUNTS.map((acc) => {
        const badgeColor =
          acc.role === "SUPER_ADMIN"
            ? "var(--accent-green)"
            : acc.role === "MERCHANT_OPS"
            ? "var(--accent-blue)"
            : "var(--accent-amber)";
        return `
      <div class="account-card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; gap: 8px;">
          <strong class="mono" style="color: ${badgeColor}; font-size: 12px;">${escapeHtml(acc.role)} (${acc.permissions.length}/7 PERMS)</strong>
          <button type="button" class="cmdk-trigger" data-fill-email="${escapeHtml(acc.email)}" data-fill-pwd="${escapeHtml(acc.demoPasswordPlain)}" style="color: ${badgeColor};">
            1-Click Sign In
          </button>
        </div>
        <div class="mono" style="font-size: 12px; color: var(--text-main); margin-bottom: 4px;">
          Email: <strong>${escapeHtml(acc.email)}</strong> | Password: <strong>${escapeHtml(acc.demoPasswordPlain)}</strong>
        </div>
        <div style="font-size: 11px; color: var(--text-dim);">
          ${escapeHtml(acc.displayName)} // ${escapeHtml(acc.scopeSummary)}
        </div>
      </div>`;
      }).join("")
    : `<div class="account-card"><div class="mono" style="font-size: 11px; color: var(--text-dim);">Production mode active: demo credential quick-fill is disabled. Sign in with provisioned RBAC credentials.</div></div>`;

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#090A0F" />
  <title>SUPER ECOMMERCE // Admin RBAC Sign In</title>
  <style>
    :root {
      color-scheme: dark;
      --bg-cockpit: #090A0F;
      --bg-panel: #10121A;
      --bg-hover: #171A26;
      --text-main: #F1F5F9;
      --text-dim: #94A3B8;
      --text-muted: #8A99B0;
      --line: rgba(255, 255, 255, 0.08);
      --accent-blue: #60A5FA;
      --button-primary: #2563EB;
      --accent-green: #10B981;
      --accent-amber: #F59E0B;
      --ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    :focus-visible {
      outline: 2px solid var(--accent-blue);
      outline-offset: 3px;
    }

    button:disabled { cursor: wait; }

    body {
      font-family: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background-color: var(--bg-cockpit);
      color: var(--text-main);
      font-size: 13px;
      line-height: 1.45;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 24px;
      -webkit-font-smoothing: antialiased;
    }

    .mono {
      font-family: "Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
      font-variant-numeric: tabular-nums;
    }

    .login-shell {
      width: 100%;
      max-width: 580px;
      background: var(--bg-panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }

    .login-header {
      padding: 18px 20px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .login-body {
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .field-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .field-input {
      width: 100%;
      background: var(--bg-cockpit);
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--text-main);
      padding: 10px 12px;
      font-size: 13px;
    }

    .field-input:focus {
      border-color: var(--accent-blue);
    }

    .cmdk-trigger {
      background: var(--bg-cockpit);
      border: 1px solid var(--line);
      color: var(--text-main);
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: transform 140ms var(--ease-out-strong), border-color 140ms ease-out;
    }

    .cmdk-trigger:active {
      transform: scale(0.97);
    }

    .account-card {
      background: var(--bg-cockpit);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
    }

    @media (prefers-reduced-motion: reduce) {
      .cmdk-trigger { transition: none; }
      .cmdk-trigger:active { transform: none; }
    }
  </style>
</head>
<body>
  <div class="login-shell">
    <div class="login-header">
      <div>
        <div style="font-weight: 700; font-size: 14px;">SUPER ECOMMERCE // ADMIN RBAC GATE</div>
        <div class="mono" style="font-size: 11px; color: var(--text-dim);">
          Constant-Time HMAC-SHA256 Digest Auth &amp; HttpOnly Session Cookie
        </div>
      </div>
      <a href="${escapeHtml(safeNext)}" class="cmdk-trigger" style="text-decoration: none; color: var(--accent-blue);">
        Back to Backoffice
      </a>
    </div>
    <div class="login-body">
      <div id="login-status-banner" class="mono" role="status" aria-live="polite" aria-atomic="true" style="padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; color: ${options?.errorMessage ? "var(--accent-amber)" : "var(--text-dim)"};">
        ${escapeHtml(options?.errorMessage ?? (options?.currentPrincipal ? `Currently signed in as ${options.currentPrincipal.email} (${options.currentPrincipal.role})` : "Select a preset RBAC account below or enter credentials manually"))}
      </div>

      <form id="admin-login-form" style="display: flex; flex-direction: column; gap: 12px;">
        <div>
          <label class="field-label" for="login-email">Admin Email</label>
          <input id="login-email" name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" class="field-input mono" value="admin@kronos.io" required />
        </div>
        <div>
          <label class="field-label" for="login-password">Password</label>
          <input id="login-password" name="password" type="password" autocomplete="current-password" class="field-input mono" value="Kronos!Admin2026" required />
        </div>
        <button type="submit" id="btn-login-submit" class="cmdk-trigger" style="background: var(--button-primary); border-color: var(--button-primary); color: #fff; padding: 10px 16px;">
          Sign In to Merchant Backoffice
        </button>
      </form>

      <div style="border-top: 1px solid var(--line); padding-top: 12px; display: flex; flex-direction: column; gap: 8px;">
        <div class="field-label">Seeded RBAC Accounts (Click to Sign In Immediately)</div>
        ${accountCardsHtml}
      </div>
    </div>
  </div>

  <script type="module">
    const NEXT_TARGET = ${nextTargetJson};
    const form = document.getElementById("admin-login-form");
    const emailInput = document.getElementById("login-email");
    const pwdInput = document.getElementById("login-password");
    const banner = document.getElementById("login-status-banner");
    const submitButton = document.getElementById("btn-login-submit");
    const submitLabel = submitButton.textContent.trim();
    const loginControls = Array.from(document.querySelectorAll("#admin-login-form input, #admin-login-form button, button[data-fill-email]"));
    let loginPending = false;

    function showLoginStatus(message, tone) {
      banner.textContent = message;
      banner.style.color = "var(--" + tone + ")";
    }

    async function submitLogin(email, password) {
      if (loginPending) return;
      loginPending = true;
      loginControls.forEach((control) => { control.disabled = true; });
      form.setAttribute("aria-busy", "true");
      submitButton.textContent = "Signing In…";
      showLoginStatus("Authenticating " + email + "…", "accent-blue");
      try {
        const res = await fetch("/api/admin/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.ok) {
          window.location.href = NEXT_TARGET;
        } else {
          const detail = typeof data?.error === "string" ? data.error : "Sign in failed. Check your credentials and try again.";
          showLoginStatus("HTTP " + res.status + " // " + detail, "accent-amber");
        }
      } catch {
        showLoginStatus("Unable to reach the sign in service. Check your connection and try again.", "accent-amber");
      } finally {
        loginPending = false;
        loginControls.forEach((control) => { control.disabled = false; });
        form.setAttribute("aria-busy", "false");
        submitButton.textContent = submitLabel;
      }
    }

    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      await submitLogin(emailInput.value, pwdInput.value);
    });

    document.addEventListener("click", async (e) => {
      const btn = e.target.closest?.("button[data-fill-email]");
      if (!btn || loginPending) return;
      const email = btn.getAttribute("data-fill-email");
      const pwd = btn.getAttribute("data-fill-pwd");
      if (!email || !pwd) return;
      emailInput.value = email;
      pwdInput.value = pwd;
      await submitLogin(email, pwd);
    });
  </script>
</body>
</html>`;
}
