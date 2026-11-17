import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { SEEDED_ADMIN_ACCOUNTS, type OrderRecord } from "@super-ecommerce/core";
import { calculateCart } from "@super-ecommerce/kernel";
import {
  ADMIN_ROUTES,
  renderAdminDashboardHtml,
  renderAdminLoginHtml,
  type AdminDashboardRenderInput,
  type AdminRouteId,
} from "./index.ts";

const channel: NonNullable<AdminDashboardRenderInput["channels"]>[number] = {
  id: "ch-us",
  slug: "us-retail",
  name: "US Flagship",
  currencyCode: "USD",
  defaultCountry: "US",
  taxInclusionMode: "TAX_EXCLUSIVE",
  stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
  allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
  reservationTtlSeconds: 900,
  isActive: true,
};

const order: OrderRecord = {
  orderId: "ord_admin_fixture",
  checkoutId: "chk_admin_fixture",
  channelSlug: channel.slug,
  currencyCode: "USD",
  pricing: calculateCart({
    currencyCode: "USD",
    taxMode: "TAX_EXCLUSIVE",
    shippingBaseAmount: 0n,
    shippingTaxRateBps: 0,
    lines: [{ lineId: "L-ADMIN-1", variantId: "KR-DAC-BLK", quantity: 3, baseUnitPrice: 1000n, taxRateBps: 0 }],
    candidateOrderDiscounts: [{ discountId: "voucher-fixture", name: "$20 voucher", kind: "ORDER_VOUCHER", value: { type: "FIXED", amount: 2000n } }],
  }),
  shipments: [{ warehouseId: "US-CENTRAL", variantId: "KR-DAC-BLK", lineId: "L-ADMIN-1", quantityAllocated: 3 }],
  paymentStatus: "CAPTURED",
  paymentTransactionId: "stripe_admin_fixture",
  paymentCapturedAmount: 1000n,
  createdAt: "2026-11-16T00:00:00.000Z",
};

const baseInput: AdminDashboardRenderInput = {
  activePrincipal: SEEDED_ADMIN_ACCOUNTS[0]!,
  channels: [channel],
  stockSlots: [{
    warehouseId: "US-CENTRAL",
    priorityRank: 2,
    linkedToChannel: true,
    supportsShippingZone: true,
    variantId: "KR-DAC-BLK",
    quantityOnHand: 25,
    quantityReserved: 1,
    quantityAllocated: 3,
  }],
  orders: [order],
  pendingOutboxEvents: [],
  configDiffPlan: {
    totalChanges: 1,
    entries: [{ stage: "warehouses", operation: "CREATE", slug: "us-central", summary: "Create warehouse 'us-central'" }],
  },
  mcpToolsCount: 4,
};

function renderRoute(activeRoute: AdminRouteId, extra: Partial<AdminDashboardRenderInput> = {}): string {
  return renderAdminDashboardHtml({ ...baseInput, activeRoute, ...extra });
}

function mainContent(html: string): string {
  const match = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/);
  assert.ok(match, "Each route must render its content inside a main landmark");
  return match[1]!;
}

function assertNoLongDashes(html: string): void {
  assert.doesNotMatch(html, /[–—]/, "Rendered HTML must contain zero em-dashes or en-dashes");
}

const routeCases: readonly { id: AdminRouteId; content: RegExp; selectedHref: string }[] = [
  { id: "overview", content: /Quick Operational Workflows/, selectedHref: "/admin" },
  { id: "orders", content: /Committed Orders Ledger/, selectedHref: "/admin/orders" },
  { id: "order_detail", content: /Two-Pass Hare-Niemeyer Price Waterfall/, selectedHref: "/admin/orders" },
  { id: "catalog", content: /Product &amp; Variant SKU Matrix/, selectedHref: "/admin/catalog" },
  { id: "discounts", content: /Active Vouchers &amp; Promotion Registry/, selectedHref: "/admin/discounts" },
  { id: "inventory", content: /MSI 3-Tier Inventory Matrix/, selectedHref: "/admin/inventory" },
  { id: "b2b", content: /B2B Enterprise Organizations, Net-30 Credit Pool &amp; PO Approval Engine/, selectedHref: "/admin/b2b" },
  { id: "configurator", content: /Sales Channel Settings &amp; Stock Availability Mode Editor/, selectedHref: "/admin/configurator" },
  { id: "settings", content: /Enterprise Admin Session Auth/, selectedHref: "/admin/settings" },
  { id: "lab", content: /WebAssembly Plugin Sandbox Stress/, selectedHref: "/admin/lab" },
];

type ClientEvent = {
  target: ClientNode;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
};

// Exercise the emitted scripts without a browser dependency. Native dialog focus
// containment is covered by its semantic markup; browser verification stays separate.
class ClientNode {
  attributes = new Map<string, string>();
  classes = new Set<string>();
  handlers = new Map<string, ((event: ClientEvent) => unknown)[]>();
  queries = new Map<string, ClientNode[]>();
  parent: ClientNode | null = null;
  tagName = "DIV";
  id = "";
  value = "";
  textContent = "";
  style: Record<string, string> = {};
  hidden = false;
  disabled = false;
  inert = false;
  open = false;
  matches = false;
  isConnected = true;
  clicks = 0;
  modalCalls = 0;
  onFocus: (node: ClientNode) => void = () => {};
  classList = {
    contains: (name: string) => this.classes.has(name),
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, force = !this.classes.has(name)) => {
      if (force) this.classes.add(name);
      else this.classes.delete(name);
      return force;
    },
  };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(type: string, handler: (event: ClientEvent) => unknown) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  dispatch(type: string, init: Partial<ClientEvent> = {}) {
    const event: ClientEvent = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    const done = Promise.all((this.handlers.get(type) ?? []).map((handler) => handler(event)));
    return { event, done };
  }
  querySelectorAll(selector: string) { return this.queries.get(selector) ?? []; }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): ClientNode | null {
    if ((selector === "li" && this.tagName === "LI") || (selector === ".cmdk-item" && this.classes.has("cmdk-item")) || (selector === "[inert]" && this.inert) || (selector === "button[data-fill-email]" && this.attributes.has("data-fill-email"))) return this;
    return this.parent?.closest(selector) ?? null;
  }
  focus() { this.onFocus(this); }
  click() { this.clicks += 1; this.dispatch("click"); }
  scrollIntoView() {}
  showModal() { this.open = true; this.modalCalls += 1; }
  close() { this.open = false; this.dispatch("close"); }
}

function clientHarness(html: string, options: { mobile?: boolean; fetch?: (path: string, init?: { body?: string }) => Promise<unknown> } = {}) {
  const elements = new Map<string, ClientNode>();
  const body = new ClientNode();
  const docEvents = new ClientNode();
  const workspace = new ClientNode();
  const windowEvents = new ClientNode();
  const media = new ClientNode();
  media.matches = options.mobile ?? false;
  const controls: ClientNode[] = [];
  const document = {
    body,
    activeElement: body,
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: () => workspace,
    querySelectorAll: () => controls,
    addEventListener: docEvents.addEventListener.bind(docEvents),
  };
  function node(tag: string, attributes = "") {
    const result = new ClientNode();
    result.tagName = tag.toUpperCase();
    result.onFocus = (focused) => { document.activeElement = focused; };
    result.parent = workspace;
    for (const attr of attributes.matchAll(/([\w:-]+)="([^"]*)"/g)) result.setAttribute(attr[1]!, attr[2]!);
    result.id = result.getAttribute("id") ?? "";
    result.value = result.getAttribute("value") ?? "";
    for (const name of (result.getAttribute("class") ?? "").split(/\s+/)) result.classes.add(name);
    if (result.id) elements.set(result.id, result);
    return result;
  }
  for (const tag of html.matchAll(/<([a-z]+)\b([^>]*\bid="[^"]+"[^>]*)>/g)) node(tag[1]!, tag[2]!);
  const paletteItems: ClientNode[] = [];
  const list = elements.get("cmdk-list");
  for (const match of html.matchAll(/<li data-cmdk-keywords="([^"]*)">\s*<(a|button)\b([^>]*)>/g)) {
    const row = node("li");
    row.setAttribute("data-cmdk-keywords", match[1]!);
    row.parent = list ?? null;
    const item = node(match[2]!, match[3]!);
    item.parent = row;
    paletteItems.push(item);
  }
  list?.queries.set(".cmdk-item", paletteItems);
  const sidebar = elements.get("admin-sidebar");
  const sidebarControls = [elements.get("btn-close-sidebar")!];
  for (const match of (html.match(/<aside\b[^>]*>([\s\S]*?)<\/aside>/)?.[1] ?? "").matchAll(/<a\b([^>]*)>/g)) {
    const link = node("a", match[1]!);
    link.parent = sidebar ?? null;
    sidebarControls.push(link);
    if (link.getAttribute("aria-current") === "page") sidebar?.queries.set('a[aria-current="page"]', [link]);
  }
  if (sidebar) {
    sidebarControls.push(elements.get("btn-admin-logout")!);
    sidebarControls[0]!.parent = sidebar;
    sidebar.queries.set('a[href], button:not([disabled])', sidebarControls);
  }
  for (const id of ["login-email", "login-password", "btn-login-submit"]) {
    const element = elements.get(id);
    if (element) controls.push(element);
  }
  for (const preset of html.matchAll(/<button\b([^>]*data-fill-email="[^"]+"[^>]*)>/g)) controls.push(node("button", preset[1]!));
  const submit = elements.get("btn-login-submit");
  if (submit) submit.textContent = "Sign In to Merchant Backoffice";
  const location = { href: "", reload() {} };
  const script = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)][0]?.[1];
  assert.ok(script, "Expected an emitted client module");
  runInNewContext(script, {
    document,
    window: { location, matchMedia: () => media, addEventListener: windowEvents.addEventListener.bind(windowEvents) },
    fetch: options.fetch ?? (async () => { throw new Error("Unexpected network request"); }),
  });
  const get = (id: string) => { const element = elements.get(id); assert.ok(element, `Missing ${id}`); return element; };
  return { get, document, docEvents, workspace, windowEvents, media, controls, paletteItems, sidebarControls, location };
}

describe("@super-ecommerce/admin multi-route backoffice", () => {
  for (const route of routeCases) {
    it(`renders ${route.id} with shared navigation and its own content`, () => {
      const html = renderRoute(route.id, { selectedOrder: order });
      assert.match(mainContent(html), route.content);
      assert.match(html, /aria-label="Commerce Navigation"/);
      assert.match(html, /aria-label="Platform Navigation"/);
      assert.match(html, /id="btn-open-cmdk"/);
      assert.match(html, /Cmd\+K/);
      assert.match(html, /new EventSource\("\/api\/admin\/events"\)/);
      for (const destination of ADMIN_ROUTES) {
        assert.ok(html.includes(`href="${destination.href}"`), `Missing navigation to ${destination.href}`);
        assert.ok(html.includes(`data-cmdk-href="${destination.href}"`), `Missing command palette destination ${destination.href}`);
      }
      const activeLinks = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)];
      assert.equal(activeLinks.length, 1, "Exactly one sidebar link must be active");
      assert.ok(activeLinks[0]![0].includes(`href="${route.selectedHref}"`));
      assertNoLongDashes(html);
    });
  }

  it("keeps the default overview focused on operations and live events", () => {
    const html = renderAdminDashboardHtml(baseInput);
    const main = mainContent(html);
    assert.match(main, /Live Server-Sent Events \(SSE\) Telemetry Stream/);
    assert.match(main, /href="\/admin\/orders\/ord_admin_fixture"/);
    assert.doesNotMatch(main, /id="catalog-create-form"|id="cfg-editor-textarea"|id="btn-wasm-stress"|id="btn-pg-stress"/);
  });

  it("filters the orders ledger by query and payment status", () => {
    const refunded: OrderRecord = { ...order, orderId: "ord_refunded", checkoutId: "chk_refunded", paymentStatus: "REFUNDED" };
    const matching = mainContent(renderRoute("orders", { orders: [order, refunded], ordersFilterQuery: "REFUNDED", ordersFilterStatus: "REFUNDED" }));
    assert.match(matching, /Showing 1 of 2 committed order\(s\)/);
    assert.match(matching, /href="\/admin\/orders\/ord_refunded"/);
    assert.doesNotMatch(matching, /href="\/admin\/orders\/ord_admin_fixture"/);
    const empty = mainContent(renderRoute("orders", { ordersFilterQuery: "no-such-order" }));
    assert.match(empty, /No matching orders found/);
  });

  it("renders keyset pagination controls with cursor links on admin orders route", () => {
    const html = mainContent(
      renderRoute("orders", {
        orders: [order],
        ordersFilterQuery: "admin",
        ordersFilterStatus: "CAPTURED",
        ordersPagination: {
          limit: 1,
          hasMore: true,
          hasPrev: true,
          nextCursor: "adm_next_cursor_123",
          prevCursor: "adm_prev_cursor_456",
          totalMatchingCount: 7,
        },
      })
    );
    assert.match(html, /Showing 1 of 7 committed order\(s\)/);
    assert.match(html, /adm_next_cursor_123/);
    assert.match(html, /adm_prev_cursor_456/);
    assert.match(html, /direction=next/);
    assert.match(html, /direction=prev/);
    assert.match(html, /q=admin/);
    assert.match(html, /status=CAPTURED/);
    assertNoLongDashes(html);
  });

  it("renders order pricing, warehouse allocation, and the Admin RMA request contract", () => {
    const html = renderRoute("order_detail", { selectedOrder: order, warehousePriorityById: { "US-CENTRAL": 2 } });
    const main = mainContent(html);
    assert.match(main, /L-ADMIN-1/);
    assert.match(main, /3 \(0 ret \/ 3 left\)/);
    assert.match(main, /\$10\.00/);
    assert.match(main, /\$20\.00/);
    assert.match(main, /US-CENTRAL/);
    assert.match(main, /#2/);
    assert.doesNotMatch(main, /#undefined|NaN/);
    assert.match(main, /id="admin-order-rma-form"[^>]*data-order-id="ord_admin_fixture"/);
    assert.match(main, /value="L-ADMIN-1" data-max="3"/);
    assert.match(html, /"\/api\/admin\/orders\/" \+ encodeURIComponent\(orderId\) \+ "\/rma"/);
    assert.match(html, /\{ lineId, quantity, condition, restockingFeeBps \}/);
  });

  it("renders an actionable missing order state without an RMA form", () => {
    const main = mainContent(renderRoute("order_detail"));
    assert.match(main, /Order Not Found/);
    assert.match(main, /href="\/admin\/orders"/);
    assert.doesNotMatch(main, /id="admin-order-rma-form"/);
  });

  it("renders catalog mutation fields and escapes merchant content", () => {
    const html = renderRoute("catalog", {
      catalogVariants: [{
        variantId: "var-fixture",
        sku: "KR-FIXTURE",
        name: "Standard",
        productId: "prod-fixture",
        productSlug: "fixture-hardware",
        productName: "Hardware <script> & tools",
        priceAmountCents: "29900",
        isPublished: false,
        availableQuantity: 12,
        attributes: { chassis: 'aluminum "silver"' },
      }],
    });
    assert.match(html, /Hardware &lt;script&gt; &amp; tools/);
    assert.doesNotMatch(html, /Hardware <script>/);
    assert.match(html, /value="aluminum &quot;silver&quot;"/);
    assert.match(html, /data-save-variant="var-fixture" data-product-id="prod-fixture"/);
    assert.match(html, /<option value="false" selected>Unpublished<\/option>/);
    assert.match(html, /\/api\/admin\/catalog\/product-create/);
    assert.match(html, /\/api\/admin\/catalog\/save/);
    assert.match(html, /priceAmountCents:/);
    assert.match(html, /initialOnHandQty:/);
    assert.match(mainContent(html), /href="\/products\/fixture-hardware\?channel=us-retail"/);
  });

  it("renders voucher value, activation, and redemption controls", () => {
    const html = renderRoute("discounts", {
      vouchers: [{ code: "SPRING20", discountId: "voucher-spring", name: "Spring <20%>", kind: "ORDER_VOUCHER", valueType: "PERCENTAGE", valueAmountCents: "0", valueBps: 2000, isActive: false, usageCount: 7, description: "Seasonal offer" }],
    });
    const main = mainContent(html);
    assert.match(main, /Spring &lt;20%&gt;/);
    assert.match(main, /20\.00% off subtotal/);
    assert.match(main, /7x/);
    assert.match(main, /PAUSED/);
    assert.match(main, /data-toggle-voucher="SPRING20"/);
    assert.match(html, /\/api\/admin\/discounts\/upsert/);
    assert.match(html, /\/api\/admin\/discounts\/toggle/);
  });

  it("renders stock adjustment controls and the actual channel availability mode", () => {
    const html = renderRoute("inventory", { channels: [{ ...channel, stockAvailabilityMode: "SHIPPING_ZONE_INTERSECTION" }] });
    const main = mainContent(html);
    assert.match(main, /SHIPPING_ZONE_INTERSECTION/);
    assert.match(main, /value="25" data-stock-onhand/);
    assert.match(main, /data-warehouse-id="US-CENTRAL" data-variant-id="KR-DAC-BLK"/);
    assert.match(html, /\/api\/admin\/inventory\/adjust/);
    assert.match(html, /quantityOnHand,[\s\S]*linkedToChannel,[\s\S]*supportsShippingZone/);
  });

  it("renders channel settings and online YAML configuration on the configurator route", () => {
    const html = renderRoute("configurator");
    const main = mainContent(html);
    assert.match(main, /data-save-channel="us-retail"/);
    assert.match(main, /value="DIRECT_CHANNEL_WAREHOUSES" selected/);
    assert.match(main, /value="TAX_EXCLUSIVE" selected/);
    assert.match(main, /value="900" data-ch-field="reservationTtlSeconds"/);
    assert.match(main, /Interactive Online YAML \/ JSON Configurator Diff &amp; Deploy Editor/);
    assert.match(main, /us-central/);
    assert.match(html, /\/api\/admin\/channels\/update/);
    assert.match(html, /\{ slug, stockAvailabilityMode, taxInclusionMode, reservationTtlSeconds \}/);
    assert.match(html, /preview_custom_text/);
    assert.match(html, /deploy_custom_text/);
  });

  for (const role of ["MERCHANT_OPS", "FINANCE_AUDITOR"] as const) {
    it(`denies Developer Lab controls to ${role}`, () => {
      const principal = SEEDED_ADMIN_ACCOUNTS.find((account) => account.role === role)!;
      const html = renderRoute("lab", { activePrincipal: principal });
      const main = mainContent(html);
      assert.match(main, /HTTP 403 Forbidden/);
      assert.match(main, /chaos:inject_faults/);
      assert.ok(main.includes(principal.email));
      assert.doesNotMatch(main, /id="btn-wasm-stress"|id="btn-pg-stress"|id="btn-gw-depth"/);
      assertNoLongDashes(html);
    });
  }

  it("exposes engineering controls to an explicitly signed-in SUPER_ADMIN", () => {
    const html = renderRoute("lab", { activePrincipal: SEEDED_ADMIN_ACCOUNTS[0]! });
    const main = mainContent(html);
    assert.match(main, /id="btn-wasm-stress"/);
    assert.match(main, /id="btn-pg-stress"/);
    assert.match(main, /id="btn-gw-depth"/);
    assert.match(main, /id="btn-mcp-doctor"/);
    assert.doesNotMatch(main, /HTTP 403 Forbidden/);
  });

  it("renders Hybrid Search results, reservation holds, and TTL reaper history on inventory", () => {
    const html = renderRoute("inventory", {
      hybridSearchReport: {
        channelSlug: "us-retail",
        queryText: "quiet mechanical typing",
        rrfK: 60,
        candidatePoolCount: 3,
        bm25MatchedCount: 0,
        vectorMatchedCount: 1,
        totalReturned: 1,
        latencyUs: 42.5,
        pgHybridRrfSql: "SELECT 1;",
        hits: [{
          projection: {
            channelSlug: "us-retail", productId: "p-1", productSlug: "kronos-field-75", productName: "Kronos Field 75 CNC Keyboard", currencyCode: "USD", minEffectivePrice: 35100n, maxEffectivePrice: 35100n, isInStock: true, totalAvailableQty: 30, mergedAttributes: { switch: ["linear"] }, variantsSnapshot: [],
          },
          rrfScore: 0.016393, bm25Score: 0, bm25Rank: null, vectorSimilarity: 0.612, vectorRank: 1, matchedBy: "VECTOR_SEMANTIC",
        }],
      },
      stockReservations: [{ reservationId: "rsv_1", holderId: "po_ttl_1", warehouseId: "US-CENTRAL", variantId: "KR-KB75-TI", lineId: "L-1", quantity: 6, status: "EXPIRED", ttlSeconds: 60, expiresAt: "2026-11-16T00:00:00.000Z", createdAt: "2026-11-15T23:59:00.000Z" }],
      reaperAuditHistory: [{ sweepId: "reap_001", executedAtIso: "2026-11-16T00:01:00.000Z", reapedReservationsCount: 1, totalUnitsReleased: 6, expiredPoNumbers: ["PO-TTL-1001"], releasedCreditMinorUnits: 273600n, latencyUs: 38.2, pgReapSql: "UPDATE stock_reservations SET status = 'EXPIRED';" }],
      phase7Banner: "REAPED 1 EXPIRED RESERVATION (6u Released -> Available)",
    });
    const main = mainContent(html);
    for (const text of ["kronos-field-75", "VECTOR_SEMANTIC", "rsv_1", "reap_001", "PO-TTL-1001", "USD 351.00", "0.016393"]) {
      assert.ok(main.includes(text), `Inventory must show ${text}`);
    }
    assertNoLongDashes(html);
  });

  it("provides keyboard landmarks, focus styles, native modal commands, and dark native controls", () => {
    const html = renderRoute("overview");
    assert.match(html, /<body>\s*<a href="#admin-main" class="skip-link"/);
    assert.match(html, /<main[^>]*id="admin-main"[^>]*tabindex="-1"/);
    assert.match(html, /:focus-visible\s*\{[^}]*outline: 2px solid/);
    assert.doesNotMatch(html, /outline:\s*none/);
    assert.match(html, /<dialog[^>]*id="cmdk-backdrop"[^>]*aria-label="Command Palette"/);
    assert.match(html, /<label for="cmdk-input"/);
    assert.match(html, /<button[^>]*id="cmd-trigger-checkout"/);
    assert.match(html, /<a[^>]*id="cmd-go-storefront"[^>]*href="\/"/);
    assert.match(html, /\.cmdk-backdrop, \.cmdk-backdrop \* \{ animation: none; transition: none; \}/);
    assert.match(html, /id="btn-mobile-sidebar"[^>]*aria-expanded="false"[^>]*aria-controls="admin-sidebar"/);
    assert.match(html, /visibility: hidden/);
    for (const page of [html, renderAdminLoginHtml()]) {
      assert.match(page, /color-scheme: dark/);
      assert.match(page, /<meta name="theme-color" content="#090A0F"/);
    }
  });

  it("opens modal commands with Cmd/Ctrl+K, filters and activates results, and restores focus", () => {
    const client = clientHarness(renderRoute("overview"));
    const trigger = client.get("btn-open-cmdk");
    const dialog = client.get("cmdk-backdrop");
    const input = client.get("cmdk-input");
    const origin = client.get("btn-mobile-sidebar");
    origin.focus();
    client.windowEvents.dispatch("keydown", { key: "k", metaKey: true });
    assert.equal(dialog.modalCalls, 1, "showModal must provide native focus containment");
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(client.document.activeElement, input);
    dialog.dispatch("keydown", { key: "ArrowDown", target: input });
    assert.equal(client.document.activeElement, client.paletteItems[0]);
    dialog.dispatch("keydown", { key: "ArrowUp", target: client.paletteItems[0] });
    assert.equal(client.document.activeElement, client.paletteItems.at(-1));
    input.focus();
    input.value = "catalog";
    input.dispatch("input");
    const catalog = client.paletteItems.find((item) => item.getAttribute("href") === "/admin/catalog")!;
    assert.equal(client.paletteItems.filter((item) => !item.parent!.hidden).length, 1);
    dialog.dispatch("keydown", { key: "Enter", target: input });
    assert.equal(catalog.clicks, 1);
    input.value = "no-such-command";
    input.dispatch("input");
    dialog.dispatch("keydown", { key: "Enter", target: input });
    assert.match(client.get("cmdk-status").textContent, /No matching commands/);
    assert.equal(catalog.clicks, 1);
    client.windowEvents.dispatch("keydown", { key: "Escape" });
    assert.equal(dialog.open, false);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(client.document.activeElement, origin);
    client.windowEvents.dispatch("keydown", { key: "K", ctrlKey: true });
    assert.equal(dialog.open, true);
    dialog.dispatch("cancel");
    assert.equal(dialog.open, false);
    assert.equal(client.document.activeElement, origin);
  });

  it("contains mobile menu focus, restores its trigger, and resets safely on desktop", () => {
    const client = clientHarness(renderRoute("overview"), { mobile: true });
    const sidebar = client.get("admin-sidebar");
    const menu = client.get("btn-mobile-sidebar");
    const close = client.get("btn-close-sidebar");
    assert.equal(sidebar.inert, true);
    menu.dispatch("click");
    assert.equal(menu.getAttribute("aria-expanded"), "true");
    assert.equal(sidebar.getAttribute("aria-modal"), "true");
    assert.equal(sidebar.inert, false);
    assert.equal(client.workspace.inert, true);
    assert.equal(client.get("admin-skip-link").inert, true);
    assert.equal(client.document.activeElement, close);
    client.windowEvents.dispatch("keydown", { key: "Tab", shiftKey: true });
    assert.equal(client.document.activeElement, client.sidebarControls.at(-1));
    client.windowEvents.dispatch("keydown", { key: "Tab" });
    assert.equal(client.document.activeElement, close);
    client.windowEvents.dispatch("keydown", { key: "Escape" });
    assert.equal(menu.getAttribute("aria-expanded"), "false");
    assert.equal(client.workspace.inert, false);
    assert.equal(sidebar.inert, true);
    assert.equal(client.document.activeElement, menu);
    menu.dispatch("click");
    client.media.matches = false;
    client.media.dispatch("change");
    assert.equal(sidebar.inert, false);
    assert.equal(sidebar.getAttribute("aria-modal"), null);
    assert.equal(client.workspace.inert, false);
    assert.equal(menu.getAttribute("aria-expanded"), "false");
    assert.equal(client.document.activeElement.getAttribute("aria-current"), "page");
  });

  it("retains actual admin destinations and rejects lookalikes, traversal, and browser URL normalization escapes", () => {
    const html = renderAdminLoginHtml({ nextPath: "/admin/orders/ord_admin_fixture?tab=returns", currentPrincipal: SEEDED_ADMIN_ACCOUNTS[1]! });
    assert.match(html, /const NEXT_TARGET = "\/admin\/orders\/ord_admin_fixture\?tab=returns"/);
    assert.match(html, /Currently signed in as ops@kronos\.io/);
    assertNoLongDashes(html);
    for (const nextPath of ["/admin", "/admin?view=orders", "/admin#orders", "/admin/orders/ord_admin_fixture"]) {
      assert.ok(renderAdminLoginHtml({ nextPath }).includes(`const NEXT_TARGET = ${JSON.stringify(nextPath)};`));
    }
    for (const nextPath of [undefined, "https://example.com", "//example.com/admin", "/checkout", "/administrator", "/admin-evil", "/admin.example.com", "/admin/../checkout", "/admin/%2e%2e/checkout", "/admin/..\\checkout", "/admin\n/../checkout", "/admin\u0000/orders"]) {
      const login = renderAdminLoginHtml({ nextPath });
      assert.match(login, /const NEXT_TARGET = "\/admin";/, `Unsafe destination: ${JSON.stringify(nextPath)}`);
      assertNoLongDashes(login);
    }
  });

  it("escapes script-closing tags and JavaScript line separators in the inline login destination", () => {
    const nextPath = '/admin/orders?ref=</script><script>alert("x")</script>&note=' + String.fromCodePoint(0x2028, 0x2029);
    const html = renderAdminLoginHtml({ nextPath });
    const modules = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
    assert.equal(modules.length, 1);
    const literal = modules[0]![1]!.match(/const NEXT_TARGET = (.+);/)?.[1];
    assert.ok(literal);
    assert.doesNotMatch(literal, /[<>&]/);
    assert.ok(!literal.includes(String.fromCharCode(0x2028)) && !literal.includes(String.fromCharCode(0x2029)));
    assert.equal(JSON.parse(literal), nextPath);
    assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
  });

  it("labels auth fields for password managers and announces login status", () => {
    const html = renderAdminLoginHtml();
    assert.match(html, /id="login-email"[^>]*autocomplete="username"[^>]*spellcheck="false"/);
    assert.match(html, /id="login-password"[^>]*autocomplete="current-password"/);
    assert.match(html, /id="login-status-banner"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /:focus-visible\s*\{[^}]*outline: 2px solid/);
    assert.doesNotMatch(html, /outline:\s*none/);
    assert.match(html, /prefers-reduced-motion: reduce/);
  });

  it("disables and deduplicates login requests, reports HTTP errors, and restores controls", async () => {
    let finish!: (response: unknown) => void;
    const requests: { path: string; body: string | undefined }[] = [];
    const client = clientHarness(renderAdminLoginHtml(), {
      fetch: (path, init) => {
        requests.push({ path, body: init?.body });
        return new Promise((resolve) => { finish = resolve; });
      },
    });
    const form = client.get("admin-login-form");
    const request = form.dispatch("submit");
    assert.equal(request.event.defaultPrevented, true);
    assert.equal(form.getAttribute("aria-busy"), "true");
    assert.ok(client.controls.every((control) => control.disabled));
    assert.match(client.get("btn-login-submit").textContent, /Signing In/);
    assert.match(client.get("login-status-banner").textContent, /Authenticating/);
    await form.dispatch("submit").done;
    await client.docEvents.dispatch("click", { target: client.controls.at(-1) }).done;
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.path, "/api/admin/login");
    assert.deepEqual(JSON.parse(requests[0]!.body!), { email: "admin@kronos.io", password: "Kronos!Admin2026" });
    finish({ ok: false, status: 401, json: async () => ({ ok: false, error: "Invalid credentials" }) });
    await request.done;
    assert.match(client.get("login-status-banner").textContent, /HTTP 401.*Invalid credentials/);
    assert.equal(form.getAttribute("aria-busy"), "false");
    assert.ok(client.controls.every((control) => !control.disabled));
    assert.equal(client.get("btn-login-submit").textContent, "Sign In to Merchant Backoffice");
  });

  for (const failure of ["network", "invalid JSON"] as const) {
    it(`recovers from login ${failure} failures`, async () => {
      const client = clientHarness(renderAdminLoginHtml(), {
        fetch: async () => {
          if (failure === "network") throw new Error("offline");
          return { ok: false, status: 502, json: async () => { throw new SyntaxError("not JSON"); } };
        },
      });
      await client.get("admin-login-form").dispatch("submit").done;
      assert.match(client.get("login-status-banner").textContent, /try again/i);
      assert.ok(client.controls.every((control) => !control.disabled));
      assert.equal(client.get("admin-login-form").getAttribute("aria-busy"), "false");
      assert.equal(client.location.href, "");
    });
  }

  it("redirects successful login to its validated Admin destination", async () => {
    const client = clientHarness(renderAdminLoginHtml({ nextPath: "/admin/orders?status=CAPTURED" }), {
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    });
    await client.get("admin-login-form").dispatch("submit").done;
    assert.equal(client.location.href, "/admin/orders?status=CAPTURED");
  });
});
