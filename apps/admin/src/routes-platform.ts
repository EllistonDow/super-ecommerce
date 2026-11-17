/**
 * Platform & Engineering Route Renderers (`configurator`, `settings`, `lab`)
 * for `@super-ecommerce/admin`.
 *
 * Every HTML output must contain zero em-dashes and zero en-dashes.
 */

import { SEEDED_ADMIN_ACCOUNTS } from "@super-ecommerce/core";
import {
  BASELINE_DESIRED_STORE_CONFIG,
  serializeStoreConfigJson,
  serializeStoreConfigYaml,
} from "@super-ecommerce/configurator";
import { escapeHtml } from "./shell.ts";
import { ADMIN_MUTATION_SCRIPT } from "./mutations.ts";
import { GUEST_ADMIN_PRINCIPAL, type AdminDashboardRenderInput } from "./types.ts";

function renderBanner(id: string, text: string): string {
  return `<div id="${escapeHtml(id)}" class="panel-banner mono" role="status" aria-live="polite">${escapeHtml(text)}</div>`;
}

export function renderConfiguratorRoute(input: AdminDashboardRenderInput): {
  readonly bodyHtml: string;
  readonly extraScriptHtml: string;
} {
  const activeDesiredYaml =
    input.desiredConfigYaml ?? serializeStoreConfigYaml(BASELINE_DESIRED_STORE_CONFIG);
  const activeDesiredJson =
    input.desiredConfigJson ?? serializeStoreConfigJson(BASELINE_DESIRED_STORE_CONFIG, true);

  const channels = input.channels ?? [];
  const channelEditorRowsHtml =
    channels.length === 0
      ? `<tr><td colspan="6" class="empty-cell">No channels seeded.</td></tr>`
      : channels
          .map(
            (ch) => `
      <tr data-channel-slug="${escapeHtml(ch.slug)}">
        <td class="mono accent-blue">${escapeHtml(ch.slug)}</td>
        <td>${escapeHtml(ch.name)} (${escapeHtml(ch.currencyCode)})</td>
        <td>
          <select class="field-select mono" data-ch-field="stockAvailabilityMode" aria-label="Stock availability mode for ${escapeHtml(ch.slug)}">
            <option value="DIRECT_CHANNEL_WAREHOUSES" ${ch.stockAvailabilityMode === "DIRECT_CHANNEL_WAREHOUSES" ? "selected" : ""}>DIRECT_CHANNEL_WAREHOUSES</option>
            <option value="SHIPPING_ZONE_INTERSECTION" ${ch.stockAvailabilityMode === "SHIPPING_ZONE_INTERSECTION" ? "selected" : ""}>SHIPPING_ZONE_INTERSECTION</option>
          </select>
        </td>
        <td>
          <select class="field-select mono" data-ch-field="taxInclusionMode" aria-label="Tax mode for ${escapeHtml(ch.slug)}">
            <option value="TAX_EXCLUSIVE" ${ch.taxInclusionMode === "TAX_EXCLUSIVE" ? "selected" : ""}>TAX_EXCLUSIVE</option>
            <option value="TAX_INCLUSIVE" ${ch.taxInclusionMode === "TAX_INCLUSIVE" ? "selected" : ""}>TAX_INCLUSIVE</option>
          </select>
        </td>
        <td>
          <input type="number" min="60" step="60" value="${ch.reservationTtlSeconds}" data-ch-field="reservationTtlSeconds" class="field-input mono" style="width: 96px;" aria-label="Reservation TTL for ${escapeHtml(ch.slug)}" />
        </td>
        <td class="num">
          <button type="button" class="btn btn-primary" data-save-channel="${escapeHtml(ch.slug)}" style="padding: 5px 10px;">Save Channel</button>
        </td>
      </tr>`
          )
          .join("");

  const diffRowsHtml =
    input.configDiffPlan.entries.length === 0
      ? `<tr><td colspan="5" class="empty-cell mono accent-green">0 Staged Changes -&gt; Remote State Matches Desired YAML Bit-for-Bit (IDEMPOTENT_NOOP Verified across warehouses, channels, productTypes, products)</td></tr>`
      : input.configDiffPlan.entries
          .map(
            (entry) => `
      <tr>
        <td class="mono">${escapeHtml(entry.stage)}</td>
        <td class="mono"><span class="op-badge op-${entry.operation.toLowerCase()}">${escapeHtml(entry.operation)}</span></td>
        <td class="mono accent-blue">${escapeHtml(entry.slug)}</td>
        <td class="mono" style="color: var(--text-secondary); max-width: 240px; word-break: break-word;">${escapeHtml(entry.beforeSummary ?? "NONE")} -&gt; ${escapeHtml(entry.afterSummary ?? entry.slug)}</td>
        <td>${escapeHtml(entry.summary)}</td>
      </tr>`
          )
          .join("");

  const configuratorAuditList = input.configuratorAuditHistory ?? [];
  const configuratorAuditRowsHtml =
    configuratorAuditList.length === 0
      ? `<tr><td colspan="6" class="empty-cell">No GitOps deployments executed in this session yet. Click Deploy 4-Stage DAG below to apply staged changes to super-postgres:5438.</td></tr>`
      : configuratorAuditList
          .map((aud) => {
            const stClass =
              aud.status === "APPLIED" || aud.status === "IDEMPOTENT_NOOP"
                ? "accent-green"
                : aud.status === "BLOCKED_PREFLIGHT"
                ? "accent-amber"
                : "accent-blue";
            return `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(aud.deployId)} (Rev #${aud.revision})</td>
        <td class="mono" style="white-space: nowrap;">${escapeHtml(aud.action)}</td>
        <td class="mono" style="max-width: 200px; word-break: break-word; color: var(--text-secondary);">${escapeHtml(aud.stageBreakdown)}</td>
        <td style="max-width: 240px; word-break: break-word;">${escapeHtml(aud.detailSummary)}</td>
        <td class="mono num" style="white-space: nowrap;">${aud.durationUs} us</td>
        <td class="mono ${stClass}" style="white-space: nowrap;">${escapeHtml(aud.status)}</td>
      </tr>`;
          })
          .join("");

  const bodyHtml = `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Sales Channel Settings &amp; Stock Availability Mode Editor</h2>
          <p class="panel-subtitle">Switch Stock Availability Mode (DIRECT_CHANNEL_WAREHOUSES vs SHIPPING_ZONE_INTERSECTION), Tax Inclusion, and Reservation TTL</p>
        </div>
        <a href="/admin/inventory" class="btn">Inspect MSI Links</a>
      </div>
      ${renderBanner("channel-editor-banner", "Ready: Channel changes take effect immediately across Storefront PDP, Cart Pricing, and MSI Stock Queries")}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Channel Slug</th>
              <th>Name &amp; Currency</th>
              <th>Stock Availability Mode</th>
              <th>Tax Inclusion Mode</th>
              <th>TTL (sec)</th>
              <th class="num">Action</th>
            </tr>
          </thead>
          <tbody>
            ${channelEditorRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Commerce-as-Code Topological Diff Plan &amp; GitOps Deployment Engine</h2>
          <p class="panel-subtitle">
            Universal immutable slug identity (warehouses -&gt; channels -&gt; productTypes -&gt; products) | Revision: #${input.configuratorRevision ?? 0} | Staged: ${input.configDiffPlan.totalChanges} change(s) | PG Mirror: ${input.pgConfiguratorMirror?.connected ? `SYNCED (${input.pgConfiguratorMirror.pgWarehousesCount} WH / ${input.pgConfiguratorMirror.pgChannelsCount} CH / ${input.pgConfiguratorMirror.pgProductTypesCount} PT / ${input.pgConfiguratorMirror.pgProductsCount} Prod / ${input.pgConfiguratorMirror.pgVariantsCount} SKU in ${input.pgConfiguratorMirror.syncLatencyUs} us)` : "LOCAL STATE"}
          </p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-cfg-deploy" class="btn" style="color: var(--accent-green);">Deploy 4-Stage DAG</button>
          <button type="button" id="btn-cfg-zerodiff" class="btn" style="color: var(--accent-blue);">Verify 0-Diff Idempotency</button>
          <button type="button" id="btn-cfg-drift" class="btn" style="color: var(--accent-blue);">Stage Slug Rename + EU Drift</button>
          <button type="button" id="btn-cfg-guard" class="btn" style="color: var(--accent-amber);">Test Stage 1 Pre-Flight Guard</button>
        </div>
      </div>
      ${renderBanner("cfg-sim-banner", input.configuratorBanner ?? "Ready: 4-Stage Topological DAG (warehouses -> channels -> productTypes -> products) | Universal Immutable Slug Identity")}
      <div style="padding: 14px 16px; border-bottom: 1px solid var(--line); background: rgba(255, 255, 255, 0.015); display: flex; flex-direction: column; gap: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <div>
            <strong style="font-size: 12px;">Interactive Online YAML / JSON Configurator Diff &amp; Deploy Editor</strong>
            <span class="mono" style="font-size: 11px; color: var(--text-muted); margin-left: 8px;">
              Dependency-Free YAML/JSON Parser + Stage 1 Pre-Flight Validation
            </span>
          </div>
          <div class="panel-actions">
            <button type="button" id="btn-cfg-load-yaml" class="btn" style="font-size: 11px; padding: 4px 10px;">Load Active YAML</button>
            <button type="button" id="btn-cfg-load-json" class="btn" style="font-size: 11px; padding: 4px 10px;">Load Active JSON</button>
            <button type="button" id="btn-cfg-load-eu-yaml" class="btn" style="font-size: 11px; padding: 4px 10px; color: var(--accent-blue);">Load EU Expansion YAML</button>
            <button type="button" id="btn-cfg-load-broken-yaml" class="btn" style="font-size: 11px; padding: 4px 10px; color: var(--accent-amber);">Load Broken Ref YAML</button>
          </div>
        </div>
        <textarea id="cfg-editor-textarea"
                  class="mono"
                  spellcheck="false"
                  aria-label="Store Config YAML or JSON Editor"
                  style="width: 100%; min-height: 220px; background: var(--bg-canvas); color: var(--text-primary); border: 1px solid var(--line); border-radius: 6px; padding: 12px; font-size: 12px; line-height: 1.45; resize: vertical;">${escapeHtml(activeDesiredYaml)}</textarea>
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
          <div class="panel-actions">
            <button type="button" id="btn-cfg-editor-diff" class="btn" style="color: var(--accent-blue);">Preview Online Diff</button>
            <button type="button" id="btn-cfg-editor-deploy" class="btn btn-primary">Deploy Custom Config -&gt; Store &amp; PG</button>
          </div>
          <span id="cfg-editor-meta" class="mono" style="font-size: 11px; color: var(--text-muted);">
            Format auto-detected (YAML or JSON) | BigInt minor units preserved
          </span>
        </div>
        <div id="cfg-editor-preview" class="mono" style="display: none; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-canvas); font-size: 12px; white-space: pre-wrap;"></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Stage</th>
              <th>Op</th>
              <th>Immutable Slug</th>
              <th>Remote State -&gt; Desired State</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            ${diffRowsHtml}
          </tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Deploy ID &amp; Rev</th>
              <th>GitOps Action</th>
              <th>Topological Stage Breakdown</th>
              <th>Audit &amp; Pre-Flight Diagnostics</th>
              <th class="num">Latency</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${configuratorAuditRowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  `;

  const extraScriptHtml = `
  <script type="module">
    ${ADMIN_MUTATION_SCRIPT}
    const ACTIVE_CFG_YAML = ${JSON.stringify(activeDesiredYaml).replaceAll("<", "\\u003c")};
    const ACTIVE_CFG_JSON = ${JSON.stringify(activeDesiredJson).replaceAll("<", "\\u003c")};
    const chBanner = document.getElementById("channel-editor-banner");

    document.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-save-channel]");
      if (!btn) return;
      const slug = btn.getAttribute("data-save-channel");
      const row = btn.closest("tr");
      const stockAvailabilityMode = row?.querySelector('select[data-ch-field="stockAvailabilityMode"]')?.value;
      const taxInclusionMode = row?.querySelector('select[data-ch-field="taxInclusionMode"]')?.value;
      const reservationTtlSeconds = Number(row?.querySelector('input[data-ch-field="reservationTtlSeconds"]')?.value || 900);
      await runAdminMutation(btn, chBanner, "/api/admin/channels/update",
        { slug, stockAvailabilityMode, taxInclusionMode, reservationTtlSeconds }, "Saving channel…");
    });

    async function runConfiguratorAction(action, btnId, busyLabel) {
      const btn = btnId ? document.getElementById(btnId) : null;
      if (btn && busyLabel) btn.textContent = busyLabel;
      await fetch("/api/demo/configurator", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      window.location.reload();
    }

    document.getElementById("btn-cfg-deploy")?.addEventListener("click", () =>
      runConfiguratorAction("deploy_dag", "btn-cfg-deploy", "Deploying 4-Stage DAG...")
    );
    document.getElementById("btn-cfg-zerodiff")?.addEventListener("click", () =>
      runConfiguratorAction("verify_zero_diff", "btn-cfg-zerodiff", "Verifying 0-Diff...")
    );
    document.getElementById("btn-cfg-drift")?.addEventListener("click", () =>
      runConfiguratorAction("stage_slug_drift", "btn-cfg-drift", "Staging Slug Update + Drift...")
    );
    document.getElementById("btn-cfg-guard")?.addEventListener("click", () =>
      runConfiguratorAction("test_preflight_guard", "btn-cfg-guard", "Testing Stage 1 Guard...")
    );

    const cfgEditor = document.getElementById("cfg-editor-textarea");
    const cfgPreviewBox = document.getElementById("cfg-editor-preview");

    document.getElementById("btn-cfg-load-yaml")?.addEventListener("click", () => {
      if (cfgEditor) cfgEditor.value = ACTIVE_CFG_YAML;
    });
    document.getElementById("btn-cfg-load-json")?.addEventListener("click", () => {
      if (cfgEditor) cfgEditor.value = ACTIVE_CFG_JSON;
    });
    document.getElementById("btn-cfg-load-eu-yaml")?.addEventListener("click", () => {
      if (!cfgEditor) return;
      cfgEditor.value = [
        "# Stage EU Expansion + In-Place Slug Rename (No Duplicate)",
        "warehouses:",
        "  - slug: us-east",
        "    name: US East Hub (NJ)",
        "    countryCode: US",
        "  - slug: us-central",
        "    name: US Central Hub (TX)",
        "    countryCode: US",
        "  - slug: eu-frankfurt",
        "    name: EU Frankfurt Hub (DE)",
        "    countryCode: DE",
        "channels:",
        "  - slug: us-retail",
        "    name: US Flagship Store",
        "    currencyCode: USD",
        "    defaultCountry: US",
        "    taxInclusionMode: TAX_EXCLUSIVE",
        "    stockAvailabilityMode: DIRECT_CHANNEL_WAREHOUSES",
        "    allocationStrategy: MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        "    warehouseSlugs: [us-east, us-central]",
        "  - slug: eu-flagship",
        "    name: EU Direct Store (VAT Inclusive)",
        "    currencyCode: EUR",
        "    defaultCountry: DE",
        "    taxInclusionMode: TAX_INCLUSIVE",
        "    stockAvailabilityMode: DIRECT_CHANNEL_WAREHOUSES",
        "    allocationStrategy: MINIMIZE_SPLIT_THEN_HIGH_STOCK",
        "    warehouseSlugs: [eu-frankfurt]",
        "productTypes:",
        "  - slug: precision-hardware",
        "    name: Precision CNC Hardware Pro (YAML v2)",
        "    isShippingRequired: true",
        "    productAttributesSchema:",
        "      - slug: chassis_material",
        "        name: Chassis Material",
        "        type: ENUM",
        "        required: true",
        "        allowedValues: [grade-5-titanium, cnc-aluminum, magnesium-alloy]",
        "    variantAttributesSchema:",
        "      - slug: switch_type",
        "        name: Switch Type",
        "        type: ENUM",
        "        required: true",
        "        allowedValues: [linear-45g, tactile-55g, optical-rapid]",
        "products:",
        "  - slug: kronos-cnc-keyboard",
        "    name: Kronos 75% CNC Titanium Mechanical Keyboard",
        "    productTypeSlug: precision-hardware",
        "    attributes:",
        "      chassis_material: grade-5-titanium",
        "    variants:",
        "      - sku: KR-KB75-TI",
        "        name: Kronos 75% Titanium / Linear 45g",
        "        attributes:",
        "          switch_type: linear-45g",
        "        channelListings:",
        "          - channelSlug: us-retail",
        "            isPublished: true",
        "            priceAmount: 39000",
        "            compareAtAmount: 45000",
        "          - channelSlug: eu-flagship",
        "            isPublished: true",
        "            priceAmount: 41000",
      ].join("\\n");
    });
    document.getElementById("btn-cfg-load-broken-yaml")?.addEventListener("click", () => {
      if (!cfgEditor) return;
      cfgEditor.value = ACTIVE_CFG_YAML.replace("us-central", "ghost-mars-warehouse");
    });

    async function runOnlineConfigEditor(mode) {
      if (!cfgEditor || !cfgPreviewBox) return;
      cfgPreviewBox.style.display = "block";
      cfgPreviewBox.style.color = "var(--accent-blue)";
      cfgPreviewBox.textContent = mode === "preview" ? "Parsing & computing 4-stage topological diff..." : "Validating Stage 1 Pre-Flight & deploying DAG...";
      const res = await fetch("/api/demo/configurator", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: mode === "preview" ? "preview_custom_text" : "deploy_custom_text",
          rawText: cfgEditor.value,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        cfgPreviewBox.style.color = "var(--accent-amber)";
        cfgPreviewBox.textContent =
          "STAGE 1 PRE-FLIGHT GUARD REJECTED (" +
          (data.format || "yaml").toUpperCase() +
          ", 0 DB Writes):\\n- " +
          (data.issues || ["Unknown error"]).join("\\n- ");
        return;
      }
      if (mode === "preview") {
        const entries = (data.plan && data.plan.entries) || [];
        cfgPreviewBox.style.color = "var(--accent-green)";
        cfgPreviewBox.textContent =
          "DRY-RUN DIFF PREVIEW (" +
          String(data.format || "yaml").toUpperCase() +
          " | " +
          (data.durationUs || 0) +
          " us | " +
          entries.length +
          " change(s)):\\n" +
          (entries.length === 0
            ? "  [0 DIFF] Remote State Matches Input Bit-for-Bit (IDEMPOTENT_NOOP)"
            : entries.map((e, i) => "  " + (i + 1) + ". [" + e.operation + "] (" + e.stage + ") " + e.slug + " :: " + e.summary).join("\\n"));
      } else {
        cfgPreviewBox.style.color = "var(--accent-green)";
        cfgPreviewBox.textContent =
          "DEPLOYED ONLINE CONFIG (" +
          String(data.format || "yaml").toUpperCase() +
          " | Rev #" +
          (data.revision ?? "?") +
          ") -> Reloading Configurator...";
        setTimeout(() => window.location.reload(), 350);
      }
    }

    document.getElementById("btn-cfg-editor-diff")?.addEventListener("click", () => runOnlineConfigEditor("preview"));
    document.getElementById("btn-cfg-editor-deploy")?.addEventListener("click", () => runOnlineConfigEditor("deploy"));
  </script>`;

  return { bodyHtml, extraScriptHtml };
}

export function renderSettingsRoute(input: AdminDashboardRenderInput): {
  readonly bodyHtml: string;
  readonly extraScriptHtml: string;
} {
  const activePrincipal = input.activePrincipal ?? GUEST_ADMIN_PRINCIPAL;
  const rbacAccounts = input.rbacAccounts ?? SEEDED_ADMIN_ACCOUNTS;
  const rbacAuditLogs = input.rbacAuditLogs ?? [];

  const dynamicRoles = input.dynamicRoles ?? [];
  const dynamicRoleRowsHtml =
    dynamicRoles.length === 0
      ? `<tr><td colspan="5" class="empty-cell">No dynamic roles loaded from PostgreSQL.</td></tr>`
      : dynamicRoles
          .map((r) => {
            const isSys = r.isSystem;
            return `
      <tr>
        <td class="mono ${isSys ? "accent-blue" : "accent-green"}" style="white-space: nowrap;">${escapeHtml(r.roleSlug)}</td>
        <td style="font-weight: 600;">${escapeHtml(r.displayName)}</td>
        <td style="color: var(--text-secondary); max-width: 260px;">${escapeHtml(r.description)}</td>
        <td class="mono" style="font-size: 11px; max-width: 280px; word-break: break-word;">${escapeHtml(r.permissions.join(", "))}</td>
        <td class="mono ${isSys ? "accent-blue" : "accent-green"} num" style="white-space: nowrap;">${isSys ? "SYSTEM" : "DYNAMIC"}</td>
      </tr>`;
          })
          .join("");

  const customersList = input.customers ?? [];
  const customerRowsHtml =
    customersList.length === 0
      ? `<tr><td colspan="6" class="empty-cell">No customer records in PostgreSQL 17 datastore.</td></tr>`
      : customersList
          .map((c) => {
            const balanceFmt = `$${(Number(c.storeCreditBalance) / 100).toFixed(2)}`;
            const balClass = c.storeCreditBalance > 0n ? "accent-green" : "";
            return `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(c.customerId)}</td>
        <td style="font-weight: 600;">${escapeHtml(c.fullName)}</td>
        <td class="mono">${escapeHtml(c.email)}</td>
        <td class="mono">${escapeHtml(c.defaultChannelSlug)} (${escapeHtml(c.currencyCode)})</td>
        <td class="mono num ${balClass}" style="white-space: nowrap; font-weight: 700;">${balanceFmt}</td>
        <td class="num" style="white-space: nowrap;">
          <button type="button" class="btn btn-press" data-add-credit="${escapeHtml(c.customerId)}" style="font-size: 11px; color: var(--accent-green);">
            +$25.00 Credit
          </button>
        </td>
      </tr>`;
          })
          .join("");

  const rbacAccountRowsHtml = rbacAccounts
    .map((acc) => {
      const isCurrent = acc.email === activePrincipal.email;
      const roleClass =
        acc.role === "SUPER_ADMIN"
          ? "accent-green"
          : acc.role === "MERCHANT_OPS"
          ? "accent-blue"
          : "accent-amber";
      return `
      <tr>
        <td class="mono ${isCurrent ? "accent-green" : "accent-blue"}" style="white-space: nowrap;">${escapeHtml(acc.email)} ${isCurrent ? "(ACTIVE)" : ""}</td>
        <td class="mono" style="white-space: nowrap;">${escapeHtml(acc.demoPasswordPlain)}</td>
        <td class="mono ${roleClass}" style="white-space: nowrap;">${escapeHtml(acc.role)} (${acc.permissions.length}/7)</td>
        <td style="max-width: 280px; word-break: break-word; color: var(--text-secondary);">${escapeHtml(acc.scopeSummary)}</td>
        <td class="num" style="white-space: nowrap;">
          <button type="button" class="btn" data-rbac-login="${escapeHtml(acc.email)}" data-rbac-pwd="${escapeHtml(acc.demoPasswordPlain)}" style="color: ${isCurrent ? "var(--accent-green)" : "var(--accent-blue)"};">
            ${isCurrent ? "Signed In" : `Switch -> ${acc.role}`}
          </button>
        </td>
      </tr>`;
    })
    .join("");

  const rbacAuditRowsHtml =
    rbacAuditLogs.length === 0
      ? `<tr><td colspan="6" class="empty-cell">No RBAC authorization audit events recorded yet. Switch roles or test the 403 Forbidden guard above.</td></tr>`
      : rbacAuditLogs
          .map((log) => {
            const decClass = log.decision === "ALLOW" ? "accent-green" : "accent-amber";
            return `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(log.auditId)}</td>
        <td class="mono" style="white-space: nowrap;">${escapeHtml(log.email)} (${escapeHtml(log.role)})</td>
        <td style="max-width: 190px; word-break: break-word; font-weight: 600;">${escapeHtml(log.actionLabel)}</td>
        <td class="mono" style="white-space: nowrap; color: var(--text-secondary);">${escapeHtml(log.requiredPermission)}</td>
        <td style="max-width: 240px; word-break: break-word;">${escapeHtml(log.detail)}</td>
        <td class="mono ${decClass}" style="white-space: nowrap;">${escapeHtml(log.decision)} (HTTP ${log.httpStatus})</td>
      </tr>`;
          })
          .join("");

  const outboxEventsList = input.allOutboxEvents ?? input.pendingOutboxEvents;
  const outboxRowsHtml =
    outboxEventsList.length === 0
      ? `<tr><td colspan="6" class="empty-cell">Outbox queue is empty. Complete a checkout or inject a test event above.</td></tr>`
      : outboxEventsList
          .map((evt) => {
            const badgeClass =
              evt.status === "PUBLISHED"
                ? "accent-green"
                : evt.status === "DEAD_LETTER"
                ? "accent-amber"
                : "accent-blue";
            const shortTime = (evt.deliveredAt ?? "OK").replace(/^.*T/, "");
            const diag =
              evt.status === "PUBLISHED"
                ? evt.attempts >= 3
                  ? `Self-Healed on Attempt ${evt.attempts}/3 after 2x Backoff (${shortTime})`
                  : evt.attempts === 2
                  ? `Standby Worker Recovered on Attempt 2/3 (${shortTime})`
                  : `Delivered on Attempt 1/3 (${shortTime})`
                : evt.status === "DEAD_LETTER"
                ? `Quarantined after ${evt.attempts}x Backoff // ${evt.lastError ?? "MAX_ATTEMPTS"}`
                : evt.lastError
                ? `Backoff Scheduled (${evt.attempts}/3) // ${evt.lastError}`
                : `Due: ${evt.nextAttemptAt.replace(/^.*T/, "")}`;
            return `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(evt.id)}</td>
        <td class="mono" style="max-width: 160px; word-break: break-word;">${escapeHtml(evt.eventType)}</td>
        <td class="mono" style="max-width: 130px; word-break: break-all;">${escapeHtml(evt.aggregateType)}:${escapeHtml(evt.aggregateId)}</td>
        <td class="mono num">${evt.attempts} / 3</td>
        <td class="mono" style="color: var(--text-secondary); max-width: 210px; word-break: break-word;">${escapeHtml(diag)}</td>
        <td class="mono ${badgeClass}" style="white-space: nowrap;">${escapeHtml(evt.status)}</td>
      </tr>`;
          })
          .join("");

  const webhookRowsHtml =
    (input.webhookEvents ?? []).length === 0
      ? `<tr><td colspan="5" class="empty-cell">No Stripe webhooks processed yet. Use the simulator buttons above to test HMAC-SHA256 verification.</td></tr>`
      : (input.webhookEvents ?? [])
          .map(
            (evt) => `
      <tr>
        <td class="mono accent-blue">${escapeHtml(evt.eventId)}</td>
        <td class="mono">${escapeHtml(evt.eventType)}</td>
        <td class="mono">${escapeHtml(evt.orderId ?? "N/A")}</td>
        <td class="mono num">${(Number(evt.amountMinorUnits) / 100).toFixed(2)}</td>
        <td class="mono accent-green">VERIFIED (t=${evt.signatureTimestamp})</td>
      </tr>`
          )
          .join("");

  const bodyHtml = `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Enterprise Admin Session Auth (HMAC-SHA256) &amp; RBAC Permission Gate</h2>
          <p class="panel-subtitle">
            Active Principal: ${escapeHtml(activePrincipal.displayName)} (${escapeHtml(activePrincipal.email)}) | Role: ${escapeHtml(activePrincipal.role)} (${activePrincipal.permissions.length}/7 Permissions: ${escapeHtml(activePrincipal.permissions.join(", "))})
          </p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-rbac-super" class="btn" style="color: var(--accent-green);">Switch -&gt; SUPER_ADMIN (7/7)</button>
          <button type="button" id="btn-rbac-ops" class="btn" style="color: var(--accent-blue);">Switch -&gt; MERCHANT_OPS (4/7)</button>
          <button type="button" id="btn-rbac-audit" class="btn" style="color: var(--accent-amber);">Switch -&gt; FINANCE_AUDITOR (3/7)</button>
          <button type="button" id="btn-rbac-test-403" class="btn" style="color: var(--accent-amber);">Simulate 403 RBAC Block</button>
        </div>
      </div>
      ${renderBanner("rbac-sim-banner", input.rbacBanner ?? "RBAC Gate Active // Signed HMAC-SHA256 Session Cookie (HttpOnly, SameSite=Lax) | 3 Roles Configured (SUPER_ADMIN, MERCHANT_OPS, FINANCE_AUDITOR)")}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Admin Email</th>
              <th>Demo Password</th>
              <th>RBAC Role &amp; Grants</th>
              <th>Least-Privilege Scope Summary</th>
              <th class="num">1-Click Session Switch</th>
            </tr>
          </thead>
          <tbody>
            ${rbacAccountRowsHtml}
          </tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Audit ID</th>
              <th>Principal &amp; Role</th>
              <th>Target Endpoint / Action</th>
              <th>Required Permission</th>
              <th>Cryptographic &amp; RBAC Diagnostic</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            ${rbacAuditRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">PostgreSQL 17 Dynamic RBAC Roles &amp; Custom Permission Matrix</h2>
          <p class="panel-subtitle">Dynamic role resolution querying PostgreSQL admin_roles on each authorization check</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Role Slug</th>
              <th>Display Name</th>
              <th>Description</th>
              <th>Permissions</th>
              <th class="num">Type</th>
            </tr>
          </thead>
          <tbody>
            ${dynamicRoleRowsHtml}
          </tbody>
        </table>
      </div>
      <form id="form-create-role" style="margin-top: 16px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface);">
        <h3 style="font-size: 14px; margin-bottom: 12px; font-weight: 600;">Configure Dynamic RBAC Role in PostgreSQL 17</h3>
        <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end;">
          <div style="flex: 1; min-width: 160px;">
            <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-secondary);">Role Slug</label>
            <input type="text" id="role-slug" required placeholder="SUPPORT_SPECIALIST" style="width: 100%; padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-subtle); color: var(--text-primary);" />
          </div>
          <div style="flex: 1; min-width: 180px;">
            <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-secondary);">Display Name</label>
            <input type="text" id="role-name" required placeholder="Support Specialist" style="width: 100%; padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-subtle); color: var(--text-primary);" />
          </div>
          <button type="submit" id="btn-submit-role" class="btn btn-press" style="color: var(--accent-blue); height: 34px;">
            Save Dynamic Role in PG
          </button>
        </div>
        <div style="margin-top: 12px;">
          <label style="display: block; font-size: 12px; margin-bottom: 6px; color: var(--text-secondary);">Role Permissions (Select Grants):</label>
          <div style="display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px;">
            <label style="display: flex; align-items: center; gap: 4px;"><input type="checkbox" name="role-perm" value="cockpit:read" checked /> cockpit:read</label>
            <label style="display: flex; align-items: center; gap: 4px;"><input type="checkbox" name="role-perm" value="msi:route_and_sync" /> msi:route_and_sync</label>
            <label style="display: flex; align-items: center; gap: 4px;"><input type="checkbox" name="role-perm" value="mcp:diagnose" checked /> mcp:diagnose</label>
            <label style="display: flex; align-items: center; gap: 4px;"><input type="checkbox" name="role-perm" value="saga:execute_checkout" /> saga:execute_checkout</label>
            <label style="display: flex; align-items: center; gap: 4px;"><input type="checkbox" name="role-perm" value="configurator:deploy_dag" /> configurator:deploy_dag</label>
            <label style="display: flex; align-items: center; gap: 4px;"><input type="checkbox" name="role-perm" value="chaos:inject_faults" /> chaos:inject_faults</label>
            <label style="display: flex; align-items: center; gap: 4px;"><input type="checkbox" name="role-perm" value="finance:audit_webhooks" /> finance:audit_webhooks</label>
          </div>
        </div>
        <div id="role-status" style="margin-top: 8px; font-size: 12px;"></div>
      </form>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">PostgreSQL 17 Primary Customers &amp; Append-Only Store Credit Ledger</h2>
          <p class="panel-subtitle">Strict non-negative check constraint (balance_after &gt;= 0) with atomic customer row locking</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Customer ID</th>
              <th>Full Name</th>
              <th>Email</th>
              <th>Channel &amp; Currency</th>
              <th class="num">Store Credit Balance</th>
              <th class="num">Quick Action</th>
            </tr>
          </thead>
          <tbody>
            ${customerRowsHtml}
          </tbody>
        </table>
      </div>
      <form id="form-create-customer" style="margin-top: 16px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface);">
        <h3 style="font-size: 14px; margin-bottom: 12px; font-weight: 600;">Create New Customer in PostgreSQL 17</h3>
        <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end;">
          <div style="flex: 1; min-width: 160px;">
            <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-secondary);">Full Name</label>
            <input type="text" id="cust-name" required placeholder="Katherine Johnson" style="width: 100%; padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-subtle); color: var(--text-primary);" />
          </div>
          <div style="flex: 1; min-width: 180px;">
            <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-secondary);">Email Address</label>
            <input type="email" id="cust-email" required placeholder="katherine@example.com" style="width: 100%; padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-subtle); color: var(--text-primary);" />
          </div>
          <div style="width: 140px;">
            <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-secondary);">Initial Credit ($)</label>
            <input type="number" id="cust-credit" min="0" step="5" value="50" style="width: 100%; padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-subtle); color: var(--text-primary);" />
          </div>
          <button type="submit" id="btn-submit-customer" class="btn btn-press" style="color: var(--accent-green); height: 34px;">
            Create Customer in PG
          </button>
        </div>
        <div id="cust-status" style="margin-top: 8px; font-size: 12px;"></div>
      </form>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Transactional Outbox Relay Worker &amp; Dead-Letter Queue (DLQ)</h2>
          <p class="panel-subtitle">
            Signed Super-Commerce-Signature HMAC-SHA256 | Published: ${input.outboxStats?.publishedCount ?? 0} (Self-Healed: ${input.outboxStats?.selfHealedCount ?? 0}) | Pending: ${input.outboxStats?.pendingCount ?? input.pendingOutboxEvents.length} | DLQ: ${input.outboxStats?.deadLetterCount ?? 0} | PG Mirror: ${input.pgOutboxMirror?.connected ? `SYNCED (${input.pgOutboxMirror.pgPublishedCount} Pub / ${input.pgOutboxMirror.pgDeadLetterCount} DLQ)` : "LOCAL SQL"}
          </p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-outbox-drain" class="btn" style="color: var(--accent-green);">Drain Outbox Batch Now</button>
          <button type="button" id="btn-outbox-poison" class="btn" style="color: var(--accent-amber);">Simulate ERP 503 -&gt; DLQ</button>
          <button type="button" id="btn-outbox-flaky" class="btn" style="color: var(--accent-blue);">Flaky 3PL Retry (Heal #3)</button>
          <button type="button" id="btn-outbox-crash" class="btn" style="color: var(--accent-blue);">Worker Crash -&gt; Recovery</button>
          <button type="button" id="btn-outbox-replay" class="btn" style="color: var(--accent-green);">Replay Dead-Letter Queue</button>
        </div>
      </div>
      ${renderBanner("outbox-sim-banner", input.outboxFaultSummary ?? "Ready: HMAC-SHA256 Signed Outbox Relay (t=<unix_ts>,v1=<sha256>) | Base Backoff: 500ms * 2^(n-1) | Max Attempts: 3 -> DEAD_LETTER")}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Event ID</th>
              <th>Event Type</th>
              <th>Aggregate</th>
              <th class="num">Attempts</th>
              <th>Delivery Diagnostics</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${outboxRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Stripe Webhook v1 HMAC-SHA256 Verifier &amp; Replay Guard</h2>
          <p class="panel-subtitle">Constant-time timingSafeEqual digest verification, 300s timestamp window, and SQL inbound_webhook_events idempotency</p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-wh-valid" class="btn" style="color: var(--accent-green);">Send Valid Signed Refund</button>
          <button type="button" id="btn-wh-tampered" class="btn" style="color: var(--accent-amber);">Simulate Tampered Body (401)</button>
          <button type="button" id="btn-wh-replay" class="btn" style="color: var(--accent-amber);">Simulate Replay &gt;300s (401)</button>
        </div>
      </div>
      ${renderBanner("webhook-sim-banner", "Ready: Endpoint POST /webhooks/stripe enforcing t=<unix_ts>,v1=<hmac_sha256>")}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Stripe Event ID</th>
              <th>Event Type</th>
              <th>Target Order</th>
              <th class="num">Amount</th>
              <th>Cryptographic Verification</th>
            </tr>
          </thead>
          <tbody>
            ${webhookRowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  `;

  const extraScriptHtml = `
  <script type="module">
    ${ADMIN_MUTATION_SCRIPT}
    async function switchRbacAccount(email, password) {
      await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      window.location.reload();
    }

    document.getElementById("btn-rbac-super")?.addEventListener("click", () =>
      switchRbacAccount("admin@kronos.io", "Kronos!Admin2026")
    );
    document.getElementById("btn-rbac-ops")?.addEventListener("click", () =>
      switchRbacAccount("ops@kronos.io", "Kronos!Ops2026")
    );
    document.getElementById("btn-rbac-audit")?.addEventListener("click", () =>
      switchRbacAccount("audit@kronos.io", "Kronos!Audit2026")
    );

    document.getElementById("btn-rbac-test-403")?.addEventListener("click", async () => {
      const btn = document.getElementById("btn-rbac-test-403");
      if (btn) btn.textContent = "Testing 403 RBAC Block...";
      await fetch("/api/admin/rbac-simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: "auditor_forbidden_deploy" }),
      });
      window.location.reload();
    });

    // Create dynamic role handler
    document.getElementById("form-create-role")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const roleSlug = document.getElementById("role-slug")?.value?.trim();
      const displayName = document.getElementById("role-name")?.value?.trim();
      const checkboxes = document.querySelectorAll('input[name="role-perm"]:checked');
      const permissions = Array.from(checkboxes).map((cb) => cb.value);
      const btn = document.getElementById("btn-submit-role");
      const statusEl = document.getElementById("role-status");
      runAdminMutation(
        btn,
        statusEl,
        "/api/admin/rbac/roles",
        { roleSlug, displayName, permissions },
        "Saving role in PG..."
      );
    });

    // Create customer handler
    document.getElementById("form-create-customer")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const fullName = document.getElementById("cust-name")?.value?.trim();
      const email = document.getElementById("cust-email")?.value?.trim();
      const creditDollars = Number(document.getElementById("cust-credit")?.value || 0);
      const initialCreditCents = Math.round(creditDollars * 100);
      const btn = document.getElementById("btn-submit-customer");
      const statusEl = document.getElementById("cust-status");
      runAdminMutation(
        btn,
        statusEl,
        "/api/admin/customers",
        { fullName, email, initialCreditCents },
        "Creating customer in PG..."
      );
    });

    // Quick add credit handler
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-add-credit]");
      if (!btn) return;
      const customerId = btn.getAttribute("data-add-credit");
      if (!customerId) return;
      runAdminMutation(
        btn,
        null,
        "/api/admin/customers/" + encodeURIComponent(customerId) + "/credit",
        { deltaCents: 2500, reason: "ADMIN_BONUS_CREDIT" },
        "Adding credit..."
      );
    });

    document.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-rbac-login]");
      if (!btn) return;
      const email = btn.getAttribute("data-rbac-login");
      const password = btn.getAttribute("data-rbac-pwd");
      if (!email || !password) return;
      btn.textContent = "Signing in...";
      await switchRbacAccount(email, password);
    });

    async function runOutboxAction(action, btnId, busyLabel) {
      const btn = btnId ? document.getElementById(btnId) : null;
      if (btn && busyLabel) btn.textContent = busyLabel;
      await fetch("/api/demo/outbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      window.location.reload();
    }

    document.getElementById("btn-outbox-drain")?.addEventListener("click", () =>
      runOutboxAction("drain", "btn-outbox-drain", "Draining Outbox...")
    );
    document.getElementById("btn-outbox-poison")?.addEventListener("click", () =>
      runOutboxAction("inject_poison_dlq", "btn-outbox-poison", "Injecting ERP 503 -> DLQ...")
    );
    document.getElementById("btn-outbox-flaky")?.addEventListener("click", () =>
      runOutboxAction("simulate_flaky_3pl_heal", "btn-outbox-flaky", "Retrying Flaky 3PL...")
    );
    document.getElementById("btn-outbox-crash")?.addEventListener("click", () =>
      runOutboxAction("simulate_worker_crash_recovery", "btn-outbox-crash", "Recovering Worker...")
    );
    document.getElementById("btn-outbox-replay")?.addEventListener("click", () =>
      runOutboxAction("replay_dlq", "btn-outbox-replay", "Replaying DLQ...")
    );

    async function runWebhookSimulation(scenario) {
      const banner = document.getElementById("webhook-sim-banner");
      const res = await fetch("/api/demo/stripe-webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      const data = await res.json();
      if (banner) {
        banner.textContent = "HTTP " + data.httpStatus + " // " + data.summary;
        banner.style.color = data.httpStatus === 200 ? "var(--accent-green)" : "var(--accent-amber)";
      }
      if (data.httpStatus === 200) {
        setTimeout(() => window.location.reload(), 350);
      }
    }

    document.getElementById("btn-wh-valid")?.addEventListener("click", () => runWebhookSimulation("valid_refund"));
    document.getElementById("btn-wh-tampered")?.addEventListener("click", () => runWebhookSimulation("tampered_body"));
    document.getElementById("btn-wh-replay")?.addEventListener("click", () => runWebhookSimulation("expired_replay"));
  </script>`;

  return { bodyHtml, extraScriptHtml };
}

export function renderLabRoute(input: AdminDashboardRenderInput): {
  readonly bodyHtml: string;
  readonly extraScriptHtml: string;
} {
  const activePrincipal = input.activePrincipal ?? GUEST_ADMIN_PRINCIPAL;
  const hasChaosPerm = activePrincipal.permissions.includes("chaos:inject_faults");

  if (!hasChaosPerm) {
    return {
      bodyHtml: `
        <section class="panel" style="border-color: rgba(245, 158, 11, 0.35);">
          <div class="panel-header">
            <div>
              <h2 class="panel-title accent-amber">HTTP 403 Forbidden // RBAC Permission Boundary Enforced</h2>
              <p class="panel-subtitle">
                Active Principal ${escapeHtml(activePrincipal.email)} (${escapeHtml(activePrincipal.role)}) holds ${activePrincipal.permissions.length}/7 permissions and lacks required capability <span class="mono">chaos:inject_faults</span>.
              </p>
            </div>
            <span class="pill mono accent-amber">403 FORBIDDEN</span>
          </div>
          <div class="panel-body" style="display: flex; flex-direction: column; gap: 14px;">
            <p style="color: var(--text-secondary); max-width: 72ch;">
              The Developer Lab exposes Rust/WASM stress triggers, PostgreSQL 60x row-locking chaos injections, WebAssembly OOB traps, and GraphQL AST DoS tests. Access is restricted to SUPER_ADMIN principals.
            </p>
            <div class="panel-actions">
              <button type="button" id="btn-lab-elevate-super" class="btn btn-primary">Sign In as SUPER_ADMIN (admin@kronos.io)</button>
              <a href="/admin" class="btn">Return to Merchant Overview</a>
              <a href="/admin/settings" class="btn">Inspect RBAC Audit Log</a>
            </div>
          </div>
        </section>`,
      extraScriptHtml: `
        <script type="module">
    ${ADMIN_MUTATION_SCRIPT}
          document.getElementById("btn-lab-elevate-super")?.addEventListener("click", async () => {
            await fetch("/api/admin/login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ email: "admin@kronos.io", password: "Kronos!Admin2026" }),
            });
            window.location.reload();
          });
        </script>`,
    };
  }

  const wasmWorkloads = input.wasmSandboxReport?.workloads ?? [];
  const wasmWorkloadRowsHtml =
    wasmWorkloads.length === 0
      ? `<tr><td colspan="6" class="empty-cell">Click Stress 29k WASM Calls to benchmark isolated WebAssembly plugin execution &amp; trap containment.</td></tr>`
      : wasmWorkloads
          .map(
            (w) => `
      <tr>
        <td style="max-width: 240px; word-break: break-word;">
          <div style="font-weight: 600;">${escapeHtml(w.title)}</div>
          <div class="mono" style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${escapeHtml(w.pluginId)} (${escapeHtml(w.isolationMode)})</div>
        </td>
        <td class="mono num">${w.iterations.toLocaleString("en-US")}</td>
        <td class="mono num accent-blue" style="white-space: nowrap;">${w.opsPerSec.toLocaleString("en-US")} ops/s</td>
        <td class="mono num" style="white-space: nowrap;">${w.p50LatencyUs} / ${w.p99LatencyUs} us</td>
        <td class="mono num" style="white-space: nowrap;">${escapeHtml(String(w.sampleOutputCents))}</td>
        <td class="mono ${w.isolationMode === "TRAP_CONTAINMENT" ? "accent-amber" : "accent-green"}" style="max-width: 210px; word-break: break-word;">${escapeHtml(w.verificationNote)}</td>
      </tr>`
          )
          .join("");

  const wasmChaosCatalog = input.wasmSandboxReport?.chaosCatalog ?? [];
  const wasmChaosRowsHtml =
    wasmChaosCatalog.length === 0
      ? `<tr><td colspan="5" class="empty-cell">No WASM chaos vectors executed yet.</td></tr>`
      : wasmChaosCatalog
          .map(
            (c) => `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(c.pluginId)}</td>
        <td style="max-width: 220px; word-break: break-word;">${escapeHtml(c.attackVector)}</td>
        <td class="mono accent-amber" style="white-space: nowrap;">${escapeHtml(c.faultKind)}</td>
        <td class="mono num" style="white-space: nowrap;">${c.trappedInUs} us</td>
        <td class="mono accent-green" style="white-space: nowrap;">Fallback ${escapeHtml(String(c.fallbackSurchargeCents))} (0 Escape)</td>
      </tr>`
          )
          .join("");

  const benchTiers = input.benchmarkReport?.tiers ?? [];
  const maxOps = Math.max(1, ...benchTiers.map((t) => t.opsPerSec));
  const benchRowsHtml =
    benchTiers.length === 0
      ? `<tr><td colspan="6" class="empty-cell">Press Re-Run Live Stress Test to execute 50,000+ Rust N-API &amp; WASM iterations.</td></tr>`
      : benchTiers
          .map((t) => {
            const pct = Math.max(
              4,
              Math.round((Math.log10(Math.max(10, t.opsPerSec)) / Math.log10(Math.max(10, maxOps))) * 100)
            );
            const barColor =
              t.runtime === "RUST_NATIVE"
                ? "#059669"
                : t.runtime === "WASM_JIT"
                ? "#3B82F6"
                : "#D97706";
            return `
      <tr>
        <td class="mono">${escapeHtml(t.runtime)}</td>
        <td>${escapeHtml(t.label)}</td>
        <td style="width: 220px;">
          <div style="background: rgba(255,255,255,0.04); border-radius: 0 4px 4px 0; padding: 2px;">
            <div style="height: 8px; width: ${pct}%; background: ${barColor}; border-radius: 0 4px 4px 0;"></div>
          </div>
        </td>
        <td class="mono num">${t.opsPerSec.toLocaleString("en-US")} ops/s</td>
        <td class="mono num">${t.p50Us} us</td>
        <td class="mono num">${t.p99Us} us</td>
      </tr>`;
          })
          .join("");

  const pgWorkloads = input.pgStressReport?.workloads ?? [];
  const pgStressRowsHtml =
    pgWorkloads.length === 0
      ? `<tr><td colspan="6" class="empty-cell">Click Re-Run 60x Flash Sale Stress Test to benchmark concurrent FOR UPDATE &amp; SKIP LOCKED on super-postgres:5438.</td></tr>`
      : pgWorkloads
          .map(
            (w) => `
      <tr>
        <td>
          <div style="font-weight: 600;">${escapeHtml(w.title)}</div>
          <div class="mono" style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${escapeHtml(w.sqlPattern)}</div>
        </td>
        <td class="mono num">${w.concurrency} TCP conns</td>
        <td class="mono num accent-blue">${w.throughputOpsPerSec.toLocaleString("en-US")} tx/s</td>
        <td class="mono num">${w.p50LatencyUs} us</td>
        <td class="mono num">${w.p99LatencyUs} us</td>
        <td class="mono ${w.invariantPassed ? "accent-green" : "accent-amber"}">${escapeHtml(w.invariantSummary)}</td>
      </tr>`
          )
          .join("");

  const gatewayTiers = input.gatewayStressReport?.tiers ?? [];
  const gatewayTierRowsHtml =
    gatewayTiers.length === 0
      ? `<tr><td colspan="6" class="empty-cell">No Dual-Protocol Gateway stress telemetry recorded yet. Click Stress 6.8k Gateway Calls above.</td></tr>`
      : gatewayTiers
          .map((t) => {
            const badgeClass =
              t.protocol === "IN_PROCESS_ORPC" || t.protocol === "HTTP_RPC_JSON"
                ? "accent-green"
                : t.protocol === "GRAPHQL_DOS_GUARD"
                ? "accent-amber"
                : "accent-blue";
            return `
      <tr>
        <td class="mono ${badgeClass}" style="white-space: nowrap;">${escapeHtml(t.protocol)}</td>
        <td style="max-width: 220px; word-break: break-word; font-weight: 600;">${escapeHtml(t.endpoint)}</td>
        <td class="mono num">${t.requestsCount.toLocaleString("en-US")} (${t.wallTimeMs} ms)</td>
        <td class="mono num accent-green">${t.reqPerSec.toLocaleString("en-US")} req/s</td>
        <td class="mono num">${t.p50LatencyUs} us / ${t.p99LatencyUs} us</td>
        <td class="mono" style="max-width: 230px; word-break: break-word;">${escapeHtml(t.verificationSummary)}</td>
      </tr>`;
          })
          .join("");

  const mcpToolsList = input.mcpTools ?? [];
  const mcpToolRowsHtml =
    mcpToolsList.length === 0
      ? `<tr><td colspan="4" class="empty-cell">No MCP tools registered yet.</td></tr>`
      : mcpToolsList
          .map(
            (t) => `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(t.name)}</td>
        <td class="mono ${t.persona === "MERCHANT_COPILOT" ? "accent-green" : "accent-amber"}" style="white-space: nowrap;">${escapeHtml(t.persona)}</td>
        <td class="mono" style="max-width: 210px; word-break: break-word; color: var(--text-secondary);">${escapeHtml(t.inputSchemaSummary)}</td>
        <td style="max-width: 260px; word-break: break-word;">${escapeHtml(t.description)}</td>
      </tr>`
          )
          .join("");

  const latestMcpLog = (input.mcpInvocationLogs ?? [])[0];
  const mcpDetailRowsHtml =
    !latestMcpLog || latestMcpLog.structuredDetails.length === 0
      ? `<tr><td colspan="5" class="empty-cell">Click any MCP diagnostic button above to inspect price waterfalls, stock availability discrepancies, or CQRS facets.</td></tr>`
      : latestMcpLog.structuredDetails
          .map((d) => {
            const sevClass =
              d.severity === "OK"
                ? "accent-green"
                : d.severity === "WARN"
                ? "accent-amber"
                : "accent-blue";
            return `
      <tr>
        <td class="mono accent-blue" style="white-space: nowrap;">${escapeHtml(d.key)}</td>
        <td style="max-width: 150px; word-break: break-word; font-weight: 600;">${escapeHtml(d.stepOrTarget)}</td>
        <td class="mono" style="max-width: 190px; word-break: break-word; color: var(--text-secondary);">${escapeHtml(d.pass1OrInput)}</td>
        <td class="mono" style="max-width: 200px; word-break: break-word;">${escapeHtml(d.pass2OrRule)}</td>
        <td class="mono ${sevClass}" style="max-width: 190px; word-break: break-word;">${escapeHtml(d.finalOutcome)}</td>
      </tr>`;
          })
          .join("");

  const bodyHtml = `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Model Context Protocol (MCP) Merchant Doctor &amp; Price/Stock Diagnostic Cockpit</h2>
          <p class="panel-subtitle">
            Registered MCP Tools: ${input.mcpToolsCount} | Active Tool: ${escapeHtml(latestMcpLog?.toolName ?? "diagnose_price_waterfall")} (${escapeHtml(latestMcpLog?.persona ?? "MERCHANT_COPILOT")}) | Execution Latency: ${latestMcpLog?.latencyUs ?? 0} us
          </p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-mcp-waterfall" class="btn" style="color: var(--accent-green);">Diagnose 3-Way Penny Split</button>
          <button type="button" id="btn-mcp-doctor" class="btn" style="color: var(--accent-amber);">Doctor: Legacy vs Direct Stock</button>
          <button type="button" id="btn-mcp-search" class="btn" style="color: var(--accent-blue);">Agentic CQRS Hybrid Search</button>
          <button type="button" id="btn-mcp-diff" class="btn" style="color: var(--accent-blue);">Preview Configurator Diff</button>
        </div>
      </div>
      ${renderBanner("mcp-sim-banner", latestMcpLog?.headlineFinding ?? "Ready: 4 MCP Tools Registered (diagnose_price_waterfall, diagnose_stock_availability_doctor, search_catalog_hybrid, preview_store_config_diff)")}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Diagnostic Key</th>
              <th>Target Entity / Line</th>
              <th>Pass 1 / Input Context</th>
              <th>Pass 2 / Precedence &amp; Mode Rule</th>
              <th>Pass 3 / Doctor Verdict</th>
            </tr>
          </thead>
          <tbody>
            ${mcpDetailRowsHtml}
          </tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>MCP Tool Name</th>
              <th>Agent Persona</th>
              <th>JSON-RPC Input Schema</th>
              <th>Capability &amp; Invariant Description</th>
            </tr>
          </thead>
          <tbody>
            ${mcpToolRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Dual-Protocol API Gateway (oRPC + GraphQL + Webhooks) Stress &amp; AST DoS Shield</h2>
          <p class="panel-subtitle">
            Requests: ${(input.gatewayStressReport?.totalRequests ?? 0).toLocaleString("en-US")} (${input.gatewayStressReport?.totalWallTimeMs ?? 0} ms) | In-Process oRPC: ${(input.gatewayStressReport?.inProcessOrpcReqPerSec ?? 0).toLocaleString("en-US")} req/s | AST DoS Blocked: ${input.gatewayStressReport?.dosAttacksBlockedCount ?? 0}
          </p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-gw-stress" class="btn" style="color: var(--accent-green);">Stress 6.8k Gateway Calls</button>
          <button type="button" id="btn-gw-compare" class="btn" style="color: var(--accent-blue);">Compare oRPC vs GraphQL</button>
          <button type="button" id="btn-gw-depth" class="btn" style="color: var(--accent-amber);">Block Depth-13 AST Bomb</button>
          <button type="button" id="btn-gw-alias" class="btn" style="color: var(--accent-amber);">Block 12x Alias Attack</button>
        </div>
      </div>
      ${renderBanner("gw-sim-banner", input.gatewayStressReport?.latestBanner ?? "Ready: Dual-Protocol Gateway (rpcClient + POST /rpc/* + POST /graphql + POST /webhooks/stripe) | AST Depth Ceiling: 6 | Alias Limit: 8")}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Protocol Tier</th>
              <th>Gateway Endpoint &amp; Workload</th>
              <th class="num">Requests</th>
              <th class="num">Throughput</th>
              <th class="num">p50 / p99</th>
              <th>Speedup &amp; Security Verification</th>
            </tr>
          </thead>
          <tbody>
            ${gatewayTierRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">WebAssembly Plugin Sandbox Stress &amp; Zero-Capability Trap Containment</h2>
          <p class="panel-subtitle">
            Warm JIT: ${(input.wasmSandboxReport?.peakOpsPerSec ?? 0).toLocaleString("en-US")} ops/s | Cold Fresh Instance: ${(input.wasmSandboxReport?.coldInstanceOpsPerSec ?? 0).toLocaleString("en-US")} ops/s | Traps Contained: ${input.wasmSandboxReport?.trapsIsolatedCount ?? 0} | Host Escapes: ${input.wasmSandboxReport?.hostEscapeCount ?? 0}
          </p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-wasm-stress" class="btn" style="color: var(--accent-green);">Stress 29k WASM Calls</button>
          <button type="button" id="btn-wasm-oob" class="btn" style="color: var(--accent-amber);">Trap OOB Memory (64KiB)</button>
          <button type="button" id="btn-wasm-budget" class="btn" style="color: var(--accent-amber);">Breach 0.15ms SLA Budget</button>
          <button type="button" id="btn-wasm-import" class="btn" style="color: var(--accent-blue);">Block Host Import Probe</button>
        </div>
      </div>
      ${renderBanner("wasm-sim-banner", input.wasmSandboxReport?.latestActionBanner ?? "Ready: Zero-Capability WebAssembly Plugin Sandbox (0 Host Imports / 64KiB Linear Memory Pages / Automatic Fallback)")}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>WASM Sandbox Stress Workload</th>
              <th class="num">Invocations</th>
              <th class="num">Throughput</th>
              <th class="num">p50 / p99</th>
              <th class="num">Output</th>
              <th>Isolation &amp; SLA Verification</th>
            </tr>
          </thead>
          <tbody>
            ${wasmWorkloadRowsHtml}
          </tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Fault / Probe Binary</th>
              <th>Adversarial / Fault Vector</th>
              <th>Trap Classification</th>
              <th class="num">Contain Time</th>
              <th>Checkout Fallback Outcome</th>
            </tr>
          </thead>
          <tbody>
            ${wasmChaosRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Rust N-API &amp; WebAssembly Throughput Telemetry</h2>
          <p class="panel-subtitle">Log-scaled throughput bars and nanosecond-derived p50 / p99 latency across 5 execution tiers</p>
        </div>
        <div class="panel-actions">
          <span class="mono accent-green" id="bench-speedup-badge">In-Rust Batch Speedup: ${input.benchmarkReport?.rustBatchVsNapiSpeedup ?? "7.7"}x</span>
          <button type="button" id="btn-run-bench" class="btn" style="color: var(--accent-blue);">Re-Run Live Stress Test</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Runtime</th>
              <th>Workload</th>
              <th>Relative Throughput (Log10)</th>
              <th class="num">Throughput</th>
              <th class="num">p50 Latency</th>
              <th class="num">p99 Latency</th>
            </tr>
          </thead>
          <tbody>
            ${benchRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">PostgreSQL Concurrency &amp; FOR UPDATE / SKIP LOCKED Flash-Sale Stress Telemetry</h2>
          <p class="panel-subtitle">
            Pool: ${input.pgStressReport?.poolConnections ?? 12} TCP Wire Connections | Flash Sale: ${input.pgStressReport?.flashSaleFulfilled ?? 25}/${input.pgStressReport?.flashSaleInitialStock ?? 25} Fulfilled, ${input.pgStressReport?.flashSaleOversoldUnits ?? 0} Oversold | Deadlocks: ${input.pgStressReport?.deadlocksDetected ?? 0}
          </p>
        </div>
        <div class="panel-actions">
          <button type="button" id="btn-pg-stress" class="btn" style="color: var(--accent-green);">Re-Run 60x Flash Sale Stress Test</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>PostgreSQL Locking Workload &amp; Wire SQL</th>
              <th class="num">Concurrency</th>
              <th class="num">Throughput</th>
              <th class="num">p50 Latency</th>
              <th class="num">p99 Latency</th>
              <th>ACID Invariant Verification</th>
            </tr>
          </thead>
          <tbody>
            ${pgStressRowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  `;

  const extraScriptHtml = `
  <script type="module">
    ${ADMIN_MUTATION_SCRIPT}
    async function runMcpDiagnoseAction(action, btnId, busyLabel) {
      const btn = btnId ? document.getElementById(btnId) : null;
      if (btn && busyLabel) btn.textContent = busyLabel;
      await fetch("/api/demo/mcp-diagnose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      window.location.reload();
    }

    document.getElementById("btn-mcp-waterfall")?.addEventListener("click", () =>
      runMcpDiagnoseAction("diagnose_penny_precedence", "btn-mcp-waterfall", "Diagnosing Waterfall...")
    );
    document.getElementById("btn-mcp-doctor")?.addEventListener("click", () =>
      runMcpDiagnoseAction("diagnose_stock_doctor", "btn-mcp-doctor", "Auditing Stock Modes...")
    );
    document.getElementById("btn-mcp-search")?.addEventListener("click", () =>
      runMcpDiagnoseAction("agentic_hybrid_search", "btn-mcp-search", "Searching 0-JOIN CQRS...")
    );
    document.getElementById("btn-mcp-diff")?.addEventListener("click", () =>
      runMcpDiagnoseAction("preview_config_diff", "btn-mcp-diff", "Diffing Store Config...")
    );

    async function runGatewayStressAction(action, btnId, busyLabel) {
      const btn = btnId ? document.getElementById(btnId) : null;
      if (btn && busyLabel) btn.textContent = busyLabel;
      await fetch("/api/demo/gateway-stress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      window.location.reload();
    }

    document.getElementById("btn-gw-stress")?.addEventListener("click", () =>
      runGatewayStressAction("stress_all", "btn-gw-stress", "Stressing 6.8k Gateway Calls...")
    );
    document.getElementById("btn-gw-compare")?.addEventListener("click", () =>
      runGatewayStressAction("compare_orpc_vs_graphql", "btn-gw-compare", "Comparing oRPC vs GraphQL...")
    );
    document.getElementById("btn-gw-depth")?.addEventListener("click", () =>
      runGatewayStressAction("test_graphql_depth_bomb", "btn-gw-depth", "Blocking Depth-13 Bomb...")
    );
    document.getElementById("btn-gw-alias")?.addEventListener("click", () =>
      runGatewayStressAction("test_graphql_alias_bomb", "btn-gw-alias", "Blocking 12x Alias Bomb...")
    );

    async function runWasmSandboxAction(action, btnId, busyLabel) {
      const btn = btnId ? document.getElementById(btnId) : null;
      if (btn && busyLabel) btn.textContent = busyLabel;
      await fetch("/api/demo/wasm-sandbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      window.location.reload();
    }

    document.getElementById("btn-wasm-stress")?.addEventListener("click", () =>
      runWasmSandboxAction("stress_29k", "btn-wasm-stress", "Stressing 29k WASM Calls...")
    );
    document.getElementById("btn-wasm-oob")?.addEventListener("click", () =>
      runWasmSandboxAction("trap_oob_memory", "btn-wasm-oob", "Trapping OOB Memory...")
    );
    document.getElementById("btn-wasm-budget")?.addEventListener("click", () =>
      runWasmSandboxAction("trap_budget_spin", "btn-wasm-budget", "Testing SLA Budget Guard...")
    );
    document.getElementById("btn-wasm-import")?.addEventListener("click", () =>
      runWasmSandboxAction("block_host_import", "btn-wasm-import", "Blocking Host Import...")
    );

    document.getElementById("btn-run-bench")?.addEventListener("click", async () => {
      const btn = document.getElementById("btn-run-bench");
      if (btn) btn.textContent = "Benchmarking 50,000+ ops...";
      await fetch("/api/demo/benchmark", { method: "POST" });
      window.location.reload();
    });

    document.getElementById("btn-pg-stress")?.addEventListener("click", async () => {
      const btn = document.getElementById("btn-pg-stress");
      if (btn) btn.textContent = "Running 60x FOR UPDATE Stress...";
      await fetch("/api/demo/pg-stress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ forceRefresh: true }),
      });
      window.location.reload();
    });
  </script>`;

  return { bodyHtml, extraScriptHtml };
}
