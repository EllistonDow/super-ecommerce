/**
 * Phase 8 Storefront Multi-Route SSR Views (`@super-ecommerce/storefront`):
 * - `/products/:slug` : Product Detail Page (variant matrix, B2B tier pricing, live MSI warehouse stock)
 * - `/checkout`       : Dedicated Two-Pass Kernel Checkout & 5-Step Durable Saga Workbench
 * - `/orders`         : Committed Orders & RMA Ledger
 * - `/orders/:id`     : Order Detail & Self-Service RMA Return Estimator (Rust N-API `calculateReturnRefund`)
 *
 * Strict compliance:
 * - Cold Luxury palette (#F8FAFC / #FFFFFF / #090D16 / #2563EB), 68px sticky nav, tabular monospace
 * - Tactile `btn-press` (`cubic-bezier(0.23, 1, 0.32, 1)`, `scale(0.97)`) + `prefers-reduced-motion: reduce`
 * - Zero em-dashes or en-dashes anywhere in rendered HTML
 */

import type {
  OrderRecord,
  OrderReturnRecord,
  WarehouseStockState,
} from "@super-ecommerce/core";
import type {
  CatalogChannelProjectionRecord,
  ChannelRecord,
  VariantProjectionSnapshot,
} from "@super-ecommerce/db";
import type {
  CartCalculationResult,
  PriceTier,
  RefundCalculationResult,
} from "@super-ecommerce/kernel";

export interface ProductDetailRenderInput {
  readonly activeChannel: ChannelRecord;
  readonly channels: readonly ChannelRecord[];
  readonly projection: CatalogChannelProjectionRecord;
  readonly selectedVariantSku?: string;
  readonly tierPricesBySku?: Readonly<Record<string, readonly PriceTier[]>>;
  readonly warehouseStocksBySku: Readonly<Record<string, readonly WarehouseStockState[]>>;
  readonly relatedProducts?: readonly CatalogChannelProjectionRecord[];
}

export interface CheckoutCatalogItemOption {
  readonly sku: string;
  readonly name: string;
  readonly unitPriceCents: string;
}

export interface CheckoutPageRenderInput {
  readonly activeChannel: ChannelRecord;
  readonly channels: readonly ChannelRecord[];
  readonly initialCartPricing: CartCalculationResult;
  readonly availableStoreCreditCents?: bigint;
  readonly customerId?: string;
  readonly catalogItems?: readonly CheckoutCatalogItemOption[];
}

export interface OrdersPaginationInfo {
  readonly limit: number;
  readonly hasMore: boolean;
  readonly hasPrev: boolean;
  readonly nextCursor: string | null;
  readonly prevCursor: string | null;
  readonly totalMatchingCount: number;
}

export interface OrdersListRenderInput {
  readonly activeChannel: ChannelRecord;
  readonly channels: readonly ChannelRecord[];
  readonly orders: readonly OrderRecord[];
  readonly returnsByOrderId: Readonly<Record<string, readonly OrderReturnRecord[]>>;
  readonly pagination?: OrdersPaginationInfo;
}

export interface OrderDetailRmaRenderInput {
  readonly activeChannel: ChannelRecord;
  readonly channels: readonly ChannelRecord[];
  readonly order: OrderRecord;
  readonly priorReturns: readonly OrderReturnRecord[];
  readonly initialRmaPreview?: RefundCalculationResult;
  readonly warehousePriorityById?: Readonly<Record<string, number>>;
}

export function formatMoney(
  minorUnits: bigint | number | string,
  currencyCode: string
): string {
  const num = Number(minorUnits) / 100;
  const symbol = currencyCode === "EUR" ? "€" : "$";
  return `${symbol}${num.toFixed(2)}`;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const STOREFRONT_ESCAPE_HTML_SCRIPT = `
    function escapeHtml(value) {
      return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }
`;

export const STOREFRONT_SHARED_CSS = `
  :root {
    --bg-primary: #F8FAFC;
    --bg-elevated: #FFFFFF;
    --bg-subtle: #F1F5F9;
    --text-primary: #090D16;
    --text-secondary: #475569;
    --text-muted: #64748B;
    --border-hairline: #E2E8F0;
    --accent: #2563EB;
    --accent-hover: #1D4ED8;
    --accent-soft: #EFF6FF;
    --success: #059669;
    --success-soft: #ECFDF5;
    --warn: #D97706;
    --warn-soft: #FFFBEB;
    --ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1);
    --radius-card: 12px;
    --radius-btn: 8px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  html, body {
    overflow-x: clip;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Geist", "Segoe UI", sans-serif;
    background-color: var(--bg-primary);
    color: var(--text-primary);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  .mono-meta, .product-sku, .product-price, .cart-line-total, .waterfall-num, .num {
    font-family: "Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
    font-variant-numeric: tabular-nums;
  }

  .num { text-align: right; white-space: nowrap; }

  .top-nav {
    min-height: 68px;
    border-bottom: 1px solid var(--border-hairline);
    background: rgba(248, 250, 252, 0.88);
    backdrop-filter: blur(16px);
    position: sticky;
    top: 0;
    z-index: 30;
  }

  .nav-inner {
    max-width: 1360px;
    min-height: 68px;
    margin: 0 auto;
    padding: 10px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px 14px;
    flex-wrap: wrap;
  }

  .brand-mark {
    font-weight: 700;
    font-size: 1.02rem;
    letter-spacing: -0.03em;
    color: var(--text-primary);
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 10px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .channel-switcher {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .channel-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: var(--radius-btn);
    border: 1px solid var(--border-hairline);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
    flex-shrink: 0;
    transition: transform 160ms var(--ease-out-strong), border-color 160ms ease-out;
  }

  .channel-pill.active {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }

  .nav-links {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .btn-press {
    transition: transform 160ms var(--ease-out-strong), background-color 160ms ease-out, border-color 160ms ease-out;
    cursor: pointer;
  }

  .btn-press:active {
    transform: scale(0.97);
  }

  .btn-primary {
    background: var(--accent);
    color: #FFFFFF;
    border: none;
    padding: 10px 18px;
    border-radius: var(--radius-btn);
    font-weight: 600;
    font-size: 0.875rem;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    white-space: nowrap;
  }

  .btn-primary:hover {
    background: var(--accent-hover);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--bg-elevated);
    color: var(--text-primary);
    border: 1px solid var(--border-hairline);
    padding: 10px 14px;
    border-radius: var(--radius-btn);
    font-weight: 600;
    font-size: 0.84rem;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    white-space: nowrap;
  }

  .btn-secondary:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .btn-secondary.active-link {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }

  .page-shell {
    max-width: 1360px;
    margin: 0 auto;
    padding: 28px 24px 80px;
  }

  .breadcrumb-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-bottom: 20px;
    flex-wrap: wrap;
  }

  .breadcrumb-bar a {
    color: var(--text-secondary);
    text-decoration: none;
  }

  .breadcrumb-bar a:hover {
    color: var(--accent);
  }

  .surface-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border-hairline);
    border-radius: var(--radius-card);
    padding: 22px;
    min-width: 0;
  }

  .surface-card-tight {
    background: var(--bg-elevated);
    border: 1px solid var(--border-hairline);
    border-radius: var(--radius-card);
    overflow-x: auto;
    min-width: 0;
  }

  .badge-pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 9px;
    border-radius: 6px;
    font-size: 0.72rem;
    font-weight: 700;
    white-space: nowrap;
  }

  .badge-blue {
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid rgba(37, 99, 235, 0.22);
  }

  .badge-green {
    background: var(--success-soft);
    color: var(--success);
    border: 1px solid rgba(5, 150, 105, 0.25);
  }

  .badge-warn {
    background: var(--warn-soft);
    color: var(--warn);
    border: 1px solid rgba(217, 119, 6, 0.25);
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.83rem;
  }

  .data-table th, .data-table td {
    padding: 10px 14px;
    text-align: left;
    border-bottom: 1px solid var(--border-hairline);
  }

  .data-table th {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    background: var(--bg-subtle);
  }

  .data-table tr:last-child td {
    border-bottom: none;
  }

  .split-2col {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
    gap: 28px;
    align-items: start;
  }

  .split-2col > * {
    min-width: 0;
  }

  .rma-inputs-grid {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 8px;
    align-items: end;
  }

  .rma-inputs-grid .rma-fee-col {
    grid-column: 1 / -1;
  }

  .field-input, .field-select {
    width: 100%;
    padding: 8px 11px;
    border-radius: var(--radius-btn);
    border: 1px solid var(--border-hairline);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.84rem;
    outline: none;
  }

  .field-input:focus, .field-select:focus {
    border-color: var(--accent);
  }

  .variant-matrix-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 10px;
    margin-top: 10px;
  }

  .variant-option-card {
    text-align: left;
    padding: 12px 14px;
    border-radius: var(--radius-btn);
    border: 1px solid var(--border-hairline);
    background: var(--bg-primary);
    color: var(--text-primary);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: transform 160ms var(--ease-out-strong), border-color 160ms ease-out, background-color 160ms ease-out;
  }

  .variant-option-card:active {
    transform: scale(0.97);
  }

  .variant-option-card.selected {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .variant-option-card.oos {
    opacity: 0.55;
    text-decoration: line-through;
  }

  .inline-toast {
    padding: 12px 14px;
    border-radius: var(--radius-btn);
    background: var(--accent-soft);
    border: 1px solid rgba(37, 99, 235, 0.25);
    font-size: 0.82rem;
    color: var(--text-primary);
    display: none;
  }

  .inline-toast.visible {
    display: block;
  }

  @media (max-width: 1100px) {
    .split-2col {
      grid-template-columns: minmax(0, 1fr);
    }
    .split-2col > aside {
      position: static !important;
    }
  }

  @media (max-width: 768px) {
    .page-shell {
      padding: 20px 16px 64px;
    }
    .nav-inner {
      padding: 10px 16px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .btn-press, .channel-pill, .variant-option-card {
      transition: none !important;
    }
  }
`;

function renderTopNav(params: {
  activeChannel: ChannelRecord;
  channels: readonly ChannelRecord[];
  basePath: string;
  activeRoute: "catalog" | "pdp" | "checkout" | "orders";
  extraQuery?: string;
}): string {
  const { activeChannel, channels, basePath, activeRoute, extraQuery } = params;
  const suffix = extraQuery ? `&${extraQuery}` : "";
  const channelOptionsHtml = channels
    .map(
      (ch) => `
      <a href="${basePath}?channel=${encodeURIComponent(ch.slug)}${suffix}"
         class="channel-pill ${ch.slug === activeChannel.slug ? "active" : ""}">
        <span>${escapeHtml(ch.slug.toUpperCase())}</span>
        <span class="mono-meta">${escapeHtml(ch.currencyCode)} / ${ch.taxInclusionMode === "TAX_INCLUSIVE" ? "VAT Incl." : "Tax Excl."}</span>
      </a>`
    )
    .join("");

  return `
  <header class="top-nav">
    <div class="nav-inner">
      <a href="/?channel=${encodeURIComponent(activeChannel.slug)}" class="brand-mark">
        <span>KRONOS // HARDWARE</span>
      </a>
      <nav class="channel-switcher" aria-label="Channel Switcher">
        ${channelOptionsHtml}
      </nav>
      <div class="nav-links">
        <a href="/?channel=${encodeURIComponent(activeChannel.slug)}" class="btn-secondary btn-press ${activeRoute === "catalog" ? "active-link" : ""}">Catalog</a>
        <a href="/checkout?channel=${encodeURIComponent(activeChannel.slug)}" class="btn-secondary btn-press ${activeRoute === "checkout" ? "active-link" : ""}">Checkout (<span id="nav-cart-count">0</span>)</a>
        <a href="/orders?channel=${encodeURIComponent(activeChannel.slug)}" class="btn-secondary btn-press ${activeRoute === "orders" ? "active-link" : ""}">Orders &amp; RMA</a>
        <a href="/admin" class="btn-primary btn-press">Open Linear Admin</a>
      </div>
    </div>
  </header>`;
}

export function renderProductDetailHtml(input: ProductDetailRenderInput): string {
  const {
    activeChannel,
    channels,
    projection,
    selectedVariantSku,
    tierPricesBySku = {},
    warehouseStocksBySku,
    relatedProducts = [],
  } = input;

  const variants: readonly VariantProjectionSnapshot[] =
    projection.variantsSnapshot.length > 0
      ? projection.variantsSnapshot
      : [
          {
            variantId: projection.productId,
            sku: projection.productSlug.toUpperCase(),
            name: "Standard Edition",
            effectivePrice: projection.minEffectivePrice,
            availableQuantity: projection.totalAvailableQty,
            isInStock: projection.isInStock,
            attributes: {},
          },
        ];

  const activeVariant =
    variants.find(
      (v) =>
        selectedVariantSku &&
        v.sku.toLowerCase() === selectedVariantSku.toLowerCase()
    ) ?? variants[0]!;

  const serializedVariantsPayload = variants.map((v) => {
    const tiers = tierPricesBySku[v.sku] ?? [];
    const slots = warehouseStocksBySku[v.sku] ?? [];
    return {
      variantId: v.variantId,
      sku: v.sku,
      name: v.name,
      effectivePriceCents: Number(v.effectivePrice),
      effectivePriceFormatted: formatMoney(v.effectivePrice, projection.currencyCode),
      compareAtFormatted:
        v.compareAtAmount && v.compareAtAmount > v.effectivePrice
          ? formatMoney(v.compareAtAmount, projection.currencyCode)
          : "",
      availableQuantity: v.availableQuantity,
      isInStock: v.isInStock,
      attributes: v.attributes,
      tiers: tiers.map((t) => ({
        minQuantity: t.minQuantity,
        unitAmountCents: Number(t.unitAmount),
        unitAmountFormatted: formatMoney(t.unitAmount, projection.currencyCode),
      })),
      warehouses: slots.map((s) => {
        const avail = Math.max(
          0,
          s.quantityOnHand - s.quantityReserved - s.quantityAllocated
        );
        return {
          warehouseId: s.warehouseId,
          priorityRank: s.priorityRank,
          linkedToChannel: s.linkedToChannel,
          supportsShippingZone: s.supportsShippingZone,
          quantityOnHand: s.quantityOnHand,
          quantityReserved: s.quantityReserved,
          quantityAllocated: s.quantityAllocated,
          availableQuantity: avail,
        };
      }),
    };
  });

  const activePayload =
    serializedVariantsPayload.find((v) => v.sku === activeVariant.sku) ??
    serializedVariantsPayload[0]!;

  const nonSelectionSpecs = Object.entries(projection.mergedAttributes)
    .map(
      ([k, vals]) => `
      <div style="padding: 10px 12px; border: 1px solid var(--border-hairline); border-radius: 8px; background: var(--bg-primary);">
        <div class="mono-meta" style="font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase;">${escapeHtml(k)}</div>
        <div style="font-size: 0.84rem; font-weight: 600; margin-top: 2px;">${escapeHtml(vals.map(String).join(", "))}</div>
      </div>`
    )
    .join("");

  const variantCardsHtml = serializedVariantsPayload
    .map((v) => {
      const attrsStr = Object.entries(v.attributes)
        .map(([k, val]) => `${k}: ${String(val)}`)
        .join(" / ");
      return `
      <button type="button"
              class="variant-option-card ${v.sku === activePayload.sku ? "selected" : ""} ${v.availableQuantity <= 0 ? "oos" : ""}"
              data-select-sku="${escapeHtml(v.sku)}">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px;">
          <span class="mono-meta" style="font-size: 0.75rem; font-weight: 700;">${escapeHtml(v.sku)}</span>
          <span class="mono-meta" style="font-size: 0.78rem; font-weight: 700; color: var(--accent);">${v.effectivePriceFormatted}</span>
        </div>
        <div style="font-size: 0.84rem; font-weight: 600;">${escapeHtml(v.name)}</div>
        <div class="mono-meta" style="font-size: 0.72rem; color: var(--text-muted);">
          ${attrsStr ? escapeHtml(attrsStr) + " | " : ""}${v.availableQuantity} avail
        </div>
      </button>`;
    })
    .join("");

  const initialTiersRowsHtml =
    activePayload.tiers.length === 0
      ? `<tr>
           <td class="mono-meta">1+ units</td>
           <td class="mono-meta num">${activePayload.effectivePriceFormatted}</td>
           <td class="mono-meta num">Standard Channel Rate</td>
         </tr>`
      : [
          `<tr>
             <td class="mono-meta">1 to ${activePayload.tiers[0]!.minQuantity - 1} units</td>
             <td class="mono-meta num">${activePayload.effectivePriceFormatted}</td>
             <td class="mono-meta num">Base Promo Rate</td>
           </tr>`,
          ...activePayload.tiers.map((t) => {
            const pct =
              activePayload.effectivePriceCents > 0
                ? Math.max(
                    0,
                    Math.round(
                      ((activePayload.effectivePriceCents - t.unitAmountCents) /
                        activePayload.effectivePriceCents) *
                        100
                    )
                  )
                : 0;
            return `
            <tr data-tier-min="${t.minQuantity}">
              <td class="mono-meta">${t.minQuantity}+ units</td>
              <td class="mono-meta num" style="color: var(--accent); font-weight: 700;">${t.unitAmountFormatted}</td>
              <td class="mono-meta num" style="color: var(--success);">Save ${pct}%</td>
            </tr>`;
          }),
        ].join("");

  const initialWarehouseRowsHtml =
    activePayload.warehouses.length === 0
      ? `<tr><td colspan="6" class="mono-meta" style="text-align: center; color: var(--text-muted);">Channel Warehouse Slot Pending Sync</td></tr>`
      : activePayload.warehouses
          .map(
            (w) => `
      <tr>
        <td class="mono-meta" style="font-weight: 700;">${escapeHtml(w.warehouseId)} (#${w.priorityRank})</td>
        <td class="mono-meta">${w.linkedToChannel ? "Channel Linked" : "Unlinked"} / ${w.supportsShippingZone ? "Zone OK" : "No Zone"}</td>
        <td class="num">${w.quantityOnHand}</td>
        <td class="num">${w.quantityReserved}</td>
        <td class="num">${w.quantityAllocated}</td>
        <td class="num" style="font-weight: 700; color: ${w.availableQuantity > 0 ? "var(--success)" : "var(--warn)"};">${w.availableQuantity}</td>
      </tr>`
          )
          .join("");

  const relatedHtml =
    relatedProducts.length === 0
      ? ""
      : `
      <section style="margin-top: 40px;">
        <h2 style="font-size: 1.15rem; font-weight: 700; margin-bottom: 14px;">Channel Hardware Siblings (${escapeHtml(activeChannel.name)})</h2>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px;">
          ${relatedProducts
            .slice(0, 3)
            .map(
              (rp) => `
            <a href="/products/${encodeURIComponent(rp.productSlug)}?channel=${encodeURIComponent(activeChannel.slug)}"
               class="surface-card btn-press"
               style="text-decoration: none; color: inherit; padding: 16px; display: flex; flex-direction: column; gap: 6px;">
              <div style="font-weight: 650;">${escapeHtml(rp.productName)}</div>
              <div class="mono-meta" style="font-size: 0.78rem; color: var(--text-muted);">
                ${formatMoney(rp.minEffectivePrice, rp.currencyCode)} | ${rp.totalAvailableQty} avail
              </div>
            </a>`
            )
            .join("")}
        </div>
      </section>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(projection.productName)} (${escapeHtml(activePayload.sku)}) - KRONOS HARDWARE</title>
  <style>${STOREFRONT_SHARED_CSS}</style>
</head>
<body>
  ${renderTopNav({
    activeChannel,
    channels,
    basePath: `/products/${encodeURIComponent(projection.productSlug)}`,
    activeRoute: "pdp",
    extraQuery: `variant=${encodeURIComponent(activePayload.sku)}`,
  })}

  <main class="page-shell">
    <nav class="breadcrumb-bar mono-meta" aria-label="Breadcrumb">
      <a href="/?channel=${encodeURIComponent(activeChannel.slug)}">Catalog</a>
      <span>/</span>
      <span>${escapeHtml(projection.productName)}</span>
      <span>/</span>
      <span id="pdp-breadcrumb-sku" style="color: var(--accent); font-weight: 700;">${escapeHtml(activePayload.sku)}</span>
    </nav>

    <div class="split-2col">
      <div style="display: flex; flex-direction: column; gap: 20px;">
        <div class="surface-card-tight">
          <img id="pdp-hero-img"
               src="https://picsum.photos/seed/kronos-hw-${encodeURIComponent(projection.productSlug)}/960/640"
               alt="${escapeHtml(projection.productName)}"
               style="width: 100%; height: 380px; object-fit: cover; display: block; background: var(--bg-subtle);" />
        </div>

        <section class="surface-card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 10px; flex-wrap: wrap;">
            <div>
              <h2 style="font-size: 1rem; font-weight: 700;">Live Multi-Source Inventory (MSI) Warehouse Allocation</h2>
              <p class="mono-meta" style="font-size: 0.74rem; color: var(--text-muted);">
                Mode: ${escapeHtml(activeChannel.stockAvailabilityMode)} | Strategy: ${escapeHtml(activeChannel.allocationStrategy)}
              </p>
            </div>
            <span class="badge-pill badge-blue mono-meta">Available = OnHand - Reserved - Allocated</span>
          </div>
          <div class="surface-card-tight">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Warehouse</th>
                  <th>Channel / Shipping Zone</th>
                  <th class="num">On Hand</th>
                  <th class="num">Reserved</th>
                  <th class="num">Allocated</th>
                  <th class="num">Available</th>
                </tr>
              </thead>
              <tbody id="pdp-warehouse-tbody">
                ${initialWarehouseRowsHtml}
              </tbody>
            </table>
          </div>
        </section>

        <section class="surface-card">
          <h2 style="font-size: 1rem; font-weight: 700; margin-bottom: 10px;">Non-Selection Hardware Specifications</h2>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px;">
            ${nonSelectionSpecs}
          </div>
        </section>
      </div>

      <aside style="display: flex; flex-direction: column; gap: 18px; position: sticky; top: 88px;">
        <div class="surface-card" style="display: flex; flex-direction: column; gap: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;">
            <div>
              <div class="mono-meta" style="font-size: 0.72rem; color: var(--accent); font-weight: 700; letter-spacing: 0.08em;">
                CHANNEL: ${escapeHtml(activeChannel.slug.toUpperCase())} (${escapeHtml(activeChannel.currencyCode)})
              </div>
              <h1 style="font-size: 1.75rem; line-height: 1.15; letter-spacing: -0.025em; font-weight: 750; margin-top: 4px;">
                ${escapeHtml(projection.productName)}
              </h1>
              <div class="mono-meta" style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">
                Active Variant SKU: <strong id="pdp-sku-label" style="color: var(--text-primary);">${escapeHtml(activePayload.sku)}</strong>
              </div>
            </div>
            <span id="pdp-avail-badge" class="badge-pill ${activePayload.availableQuantity > 0 ? "badge-green" : "badge-warn"} mono-meta">
              ${activePayload.availableQuantity > 0 ? `In Stock (${activePayload.availableQuantity})` : "Out of Stock"}
            </span>
          </div>

          <div style="display: flex; align-items: baseline; gap: 12px; padding: 12px 0; border-top: 1px solid var(--border-hairline); border-bottom: 1px solid var(--border-hairline);">
            <span id="pdp-price-display" class="mono-meta" style="font-size: 1.85rem; font-weight: 750;">${activePayload.effectivePriceFormatted}</span>
            <span id="pdp-compare-display" class="mono-meta" style="font-size: 0.9rem; color: var(--text-muted); text-decoration: line-through;">${activePayload.compareAtFormatted}</span>
            <span class="badge-pill badge-blue mono-meta">${activeChannel.taxInclusionMode === "TAX_INCLUSIVE" ? "20% VAT Included" : "Tax Exclusive"}</span>
          </div>

          <div>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span class="mono-meta" style="font-size: 0.74rem; font-weight: 700; color: var(--text-secondary);">
                VARIANT SELECTION MATRIX (URL SYNCED)
              </span>
              <span class="mono-meta" style="font-size: 0.72rem; color: var(--text-muted);">${variants.length} SKU(s)</span>
            </div>
            <div class="variant-matrix-grid" id="pdp-variant-matrix">
              ${variantCardsHtml}
            </div>
          </div>

          <div>
            <div class="mono-meta" style="font-size: 0.74rem; font-weight: 700; color: var(--text-secondary); margin-bottom: 8px;">
              B2B &amp; VOLUME TIER PRICING
            </div>
            <div class="surface-card-tight">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Quantity Break</th>
                    <th class="num">Unit Price</th>
                    <th class="num">Savings</th>
                  </tr>
                </thead>
                <tbody id="pdp-tier-tbody">
                  ${initialTiersRowsHtml}
                </tbody>
              </table>
            </div>
          </div>

          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-subtle); padding: 12px; border-radius: var(--radius-btn);">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="mono-meta" style="font-size: 0.78rem; font-weight: 700;">Qty</span>
              <button type="button" id="btn-pdp-qty-dec" class="btn-secondary btn-press" style="padding: 4px 10px;">-1</button>
              <input type="number" id="pdp-qty-input" class="field-input mono-meta" value="1" min="1" max="500" style="width: 72px; text-align: center;" />
              <button type="button" id="btn-pdp-qty-inc" class="btn-secondary btn-press" style="padding: 4px 10px;">+1</button>
            </div>
            <div style="text-align: right;">
              <div class="mono-meta" style="font-size: 0.7rem; color: var(--text-muted);">Effective Line Subtotal</div>
              <div id="pdp-line-subtotal" class="mono-meta" style="font-size: 1.05rem; font-weight: 700;">${activePayload.effectivePriceFormatted}</div>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px;">
            <button type="button" id="btn-pdp-add-cart" class="btn-primary btn-press" ${activePayload.availableQuantity <= 0 ? "disabled" : ""}>
              Add Variant to Cart
            </button>
            <button type="button" id="btn-pdp-buy-now" class="btn-secondary btn-press" ${activePayload.availableQuantity <= 0 ? "disabled" : ""}>
              Instant Checkout
            </button>
          </div>

          <div id="pdp-toast" class="inline-toast mono-meta" role="status"></div>
        </div>
      </aside>
    </div>

    ${relatedHtml}
  </main>

  <script type="module">
    const CURRENCY = ${JSON.stringify(projection.currencyCode)};
    const CHANNEL_SLUG = ${JSON.stringify(activeChannel.slug)};
    const VARIANTS = ${JSON.stringify(serializedVariantsPayload).replaceAll("<", "\\u003c")};
    const CART_KEY = "kronos_cart_v1";

    let currentSku = ${JSON.stringify(activePayload.sku).replaceAll("<", "\\u003c")};
    const qtyInput = document.getElementById("pdp-qty-input");
    const toastEl = document.getElementById("pdp-toast");

    function fmtCents(cents) {
      const sym = CURRENCY === "EUR" ? "€" : "$";
      return sym + (Number(cents) / 100).toFixed(2);
    }

    function readCart() {
      try {
        const raw = localStorage.getItem(CART_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function writeCart(lines) {
      try {
        localStorage.setItem(CART_KEY, JSON.stringify(lines));
      } catch {
        // ignore storage errors
      }
      const badge = document.getElementById("nav-cart-count");
      if (badge) {
        badge.textContent = String(lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0));
      }
    }

    function resolveUnitPriceForQty(variant, qty) {
      let best = variant.effectivePriceCents;
      for (const t of variant.tiers || []) {
        if (qty >= t.minQuantity && t.unitAmountCents < best) {
          best = t.unitAmountCents;
        }
      }
      return best;
    }

    function refreshView() {
      const v = VARIANTS.find((x) => x.sku === currentSku) || VARIANTS[0];
      if (!v) return;
      const qty = Math.max(1, Number(qtyInput?.value || "1") || 1);
      const unitCents = resolveUnitPriceForQty(v, qty);

      document.getElementById("pdp-breadcrumb-sku").textContent = v.sku;
      document.getElementById("pdp-sku-label").textContent = v.sku;
      document.getElementById("pdp-price-display").textContent = fmtCents(unitCents);
      document.getElementById("pdp-compare-display").textContent = v.compareAtFormatted || "";
      document.getElementById("pdp-line-subtotal").textContent = fmtCents(unitCents * qty);

      const badge = document.getElementById("pdp-avail-badge");
      if (badge) {
        badge.textContent = v.availableQuantity > 0 ? "In Stock (" + v.availableQuantity + ")" : "Out of Stock";
        badge.className = "badge-pill mono-meta " + (v.availableQuantity > 0 ? "badge-green" : "badge-warn");
      }

      document.querySelectorAll("[data-select-sku]").forEach((btn) => {
        btn.classList.toggle("selected", btn.getAttribute("data-select-sku") === v.sku);
      });

      const addBtn = document.getElementById("btn-pdp-add-cart");
      const buyBtn = document.getElementById("btn-pdp-buy-now");
      if (addBtn) addBtn.disabled = v.availableQuantity <= 0;
      if (buyBtn) buyBtn.disabled = v.availableQuantity <= 0;

      const tierTbody = document.getElementById("pdp-tier-tbody");
      if (tierTbody) {
        if (!v.tiers || v.tiers.length === 0) {
          tierTbody.innerHTML =
            '<tr><td class="mono-meta">1+ units</td><td class="mono-meta num">' +
            v.effectivePriceFormatted +
            '</td><td class="mono-meta num">Standard Channel Rate</td></tr>';
        } else {
          const rows = [
            '<tr><td class="mono-meta">1 to ' +
              (v.tiers[0].minQuantity - 1) +
              ' units</td><td class="mono-meta num">' +
              v.effectivePriceFormatted +
              '</td><td class="mono-meta num">Base Promo Rate</td></tr>',
          ];
          for (const t of v.tiers) {
            const pct =
              v.effectivePriceCents > 0
                ? Math.max(0, Math.round(((v.effectivePriceCents - t.unitAmountCents) / v.effectivePriceCents) * 100))
                : 0;
            const activeStyle = qty >= t.minQuantity ? ' style="background: var(--accent-soft);"' : "";
            rows.push(
              "<tr" +
                activeStyle +
                '><td class="mono-meta">' +
                t.minQuantity +
                '+ units</td><td class="mono-meta num" style="color: var(--accent); font-weight: 700;">' +
                t.unitAmountFormatted +
                '</td><td class="mono-meta num" style="color: var(--success);">Save ' +
                pct +
                "%</td></tr>"
            );
          }
          tierTbody.innerHTML = rows.join("");
        }
      }

      const whTbody = document.getElementById("pdp-warehouse-tbody");
      if (whTbody) {
        if (!v.warehouses || v.warehouses.length === 0) {
          whTbody.innerHTML =
            '<tr><td colspan="6" class="mono-meta" style="text-align: center; color: var(--text-muted);">Channel Warehouse Slot Pending Sync</td></tr>';
        } else {
          whTbody.innerHTML = v.warehouses
            .map(
              (w) =>
                '<tr><td class="mono-meta" style="font-weight: 700;">' +
                w.warehouseId +
                " (#" +
                w.priorityRank +
                ')</td><td class="mono-meta">' +
                (w.linkedToChannel ? "Channel Linked" : "Unlinked") +
                " / " +
                (w.supportsShippingZone ? "Zone OK" : "No Zone") +
                '</td><td class="num">' +
                w.quantityOnHand +
                '</td><td class="num">' +
                w.quantityReserved +
                '</td><td class="num">' +
                w.quantityAllocated +
                '</td><td class="num" style="font-weight: 700; color: ' +
                (w.availableQuantity > 0 ? "var(--success)" : "var(--warn)") +
                ';">' +
                w.availableQuantity +
                "</td></tr>"
            )
            .join("");
        }
      }

      const url = new URL(window.location.href);
      url.searchParams.set("channel", CHANNEL_SLUG);
      url.searchParams.set("variant", v.sku);
      window.history.replaceState({}, "", url.toString());
    }

    function addCurrentVariantToCart(redirectToCheckout) {
      const v = VARIANTS.find((x) => x.sku === currentSku) || VARIANTS[0];
      if (!v) return;
      const qty = Math.max(1, Number(qtyInput?.value || "1") || 1);
      const unitCents = resolveUnitPriceForQty(v, qty);
      const lines = readCart();
      const existing = lines.find((l) => l.variantId === v.sku && !l.isGift);
      if (existing) {
        existing.quantity += qty;
        existing.baseUnitPrice = resolveUnitPriceForQty(v, existing.quantity);
      } else {
        lines.push({
          variantId: v.sku,
          quantity: qty,
          baseUnitPrice: unitCents,
          isGift: false,
        });
      }
      writeCart(lines);
      if (redirectToCheckout) {
        window.location.href = "/checkout?channel=" + encodeURIComponent(CHANNEL_SLUG);
        return;
      }
      if (toastEl) {
        toastEl.classList.add("visible");
        toastEl.innerHTML =
          "Added <strong>" +
          qty +
          "x " +
          v.sku +
          "</strong> @ " +
          fmtCents(unitCents) +
          ' to Cart. <a href="/checkout?channel=' +
          encodeURIComponent(CHANNEL_SLUG) +
          '" style="color: var(--accent); font-weight: 700;">Proceed to Checkout -&gt;</a>';
      }
    }

    document.getElementById("pdp-variant-matrix")?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-select-sku]");
      if (!btn) return;
      currentSku = btn.getAttribute("data-select-sku") || currentSku;
      refreshView();
    });

    document.getElementById("btn-pdp-qty-dec")?.addEventListener("click", () => {
      if (!qtyInput) return;
      qtyInput.value = String(Math.max(1, (Number(qtyInput.value) || 1) - 1));
      refreshView();
    });
    document.getElementById("btn-pdp-qty-inc")?.addEventListener("click", () => {
      if (!qtyInput) return;
      qtyInput.value = String(Math.min(500, (Number(qtyInput.value) || 1) + 1));
      refreshView();
    });
    qtyInput?.addEventListener("input", refreshView);
    document.getElementById("btn-pdp-add-cart")?.addEventListener("click", () => addCurrentVariantToCart(false));
    document.getElementById("btn-pdp-buy-now")?.addEventListener("click", () => addCurrentVariantToCart(true));

    writeCart(readCart());
  </script>
</body>
</html>`;
}

export function renderCheckoutPageHtml(input: CheckoutPageRenderInput): string {
  const {
    activeChannel,
    channels,
    initialCartPricing,
    availableStoreCreditCents = 50_000n,
    customerId = "cust_vip_01",
    catalogItems = [],
  } = input;

  const catalogOptionsHtml = catalogItems
    .map(
      (item) =>
        `<option value="${escapeHtml(item.sku)}" data-price="${escapeHtml(item.unitPriceCents)}">${escapeHtml(item.sku)} (${escapeHtml(item.name)} - ${formatMoney(item.unitPriceCents, activeChannel.currencyCode)})</option>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dedicated Saga Checkout (${escapeHtml(activeChannel.slug)}) - KRONOS HARDWARE</title>
  <style>${STOREFRONT_SHARED_CSS}</style>
</head>
<body>
  ${renderTopNav({
    activeChannel,
    channels,
    basePath: "/checkout",
    activeRoute: "checkout",
  })}

  <main class="page-shell">
    <nav class="breadcrumb-bar mono-meta" aria-label="Breadcrumb">
      <a href="/?channel=${encodeURIComponent(activeChannel.slug)}">Catalog</a>
      <span>/</span>
      <span>Dedicated 5-Step Saga Checkout</span>
    </nav>

    <div style="margin-bottom: 20px;">
      <h1 style="font-size: 1.8rem; font-weight: 750; letter-spacing: -0.025em;">
        Durable Checkout &amp; Two-Pass Kernel Workbench
      </h1>
      <p style="font-size: 0.92rem; color: var(--text-secondary);">
        Channel: <strong>${escapeHtml(activeChannel.name)}</strong> (${escapeHtml(activeChannel.stockAvailabilityMode)}) | Live Rust Hare-Niemeyer attribution + MSI warehouse allocation.
      </p>
    </div>

    <div class="split-2col">
      <div style="display: flex; flex-direction: column; gap: 18px;">
        <section class="surface-card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 10px; flex-wrap: wrap;">
            <h2 style="font-size: 1.05rem; font-weight: 700;">1. Cart Line Items</h2>
            <button type="button" id="btn-chk-reset-demo" class="btn-secondary btn-press" style="padding: 6px 12px; font-size: 0.76rem;">
              Reset to 3-SKU Penny Demo
            </button>
          </div>
          <div id="chk-lines-container"></div>

          ${
            catalogItems.length > 0
              ? `
          <div style="display: flex; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border-hairline);">
            <select id="chk-add-sku-select" class="field-select mono-meta" aria-label="Add Hardware SKU">
              ${catalogOptionsHtml}
            </select>
            <button type="button" id="btn-chk-add-sku" class="btn-secondary btn-press">Add SKU</button>
          </div>`
              : ""
          }
        </section>

        <section class="surface-card" style="display: flex; flex-direction: column; gap: 12px;">
          <h2 style="font-size: 1.05rem; font-weight: 700;">2. Discount Precedence &amp; Split Tender</h2>
          <div class="mono-meta" style="font-size: 0.75rem; color: var(--text-muted);">
            Strict Precedence: Manual Override &gt; Order Voucher &gt; Order Promotion
          </div>

          <label style="display: flex; align-items: center; gap: 8px; font-size: 0.85rem; font-weight: 600; cursor: pointer;">
            <input type="checkbox" id="chk-promo" checked />
            <span>Order Promotion (10% Off Subtotal)</span>
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 0.85rem; font-weight: 600; cursor: pointer;">
            <input type="checkbox" id="chk-voucher" checked />
            <span>Order Voucher (-10.00, suppresses Order Promotion)</span>
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 0.85rem; font-weight: 600; cursor: pointer;">
            <input type="checkbox" id="chk-manual" />
            <span>Manual Agent Override (-25.00, wins all precedence)</span>
          </label>

          <div style="display: flex; gap: 8px;">
            <input type="text" id="chk-voucher-code" class="field-input mono-meta" placeholder="Voucher code (SUPER10 / VIP25 / B2B15)" />
            <button type="button" id="btn-chk-apply-voucher" class="btn-secondary btn-press">Apply Code</button>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; padding-top: 8px; border-top: 1px solid var(--border-hairline);">
            <div>
              <label for="chk-store-credit" class="mono-meta" style="display: block; font-size: 0.72rem; color: var(--text-muted); margin-bottom: 4px;">
                STORE CREDIT LEDGER (${escapeHtml(customerId)}: ${formatMoney(availableStoreCreditCents, "USD")} avail)
              </label>
              <select id="chk-store-credit" class="field-select mono-meta">
                <option value="0">$0.00 (100% Card Capture)</option>
                <option value="2500">$25.00 Store Credit + Card</option>
                <option value="5000" selected>$50.00 Store Credit + Card</option>
              </select>
            </div>
            <div>
              <label class="mono-meta" style="display: block; font-size: 0.72rem; color: var(--text-muted); margin-bottom: 4px;">
                GATEWAY SIMULATION MODE
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-size: 0.82rem; padding-top: 6px; cursor: pointer;">
                <input type="checkbox" id="chk-fail-payment" />
                <span>Simulate Step 4 Card Decline (LIFO Rollback)</span>
              </label>
            </div>
          </div>
        </section>
      </div>

      <aside class="surface-card" style="position: sticky; top: 88px; display: flex; flex-direction: column; gap: 14px;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-hairline); padding-bottom: 10px;">
          <div>
            <h2 style="font-size: 1.05rem; font-weight: 700;">Two-Pass Kernel Receipt</h2>
            <div class="mono-meta" style="font-size: 0.74rem; color: var(--text-muted);">Rust N-API Zero-Float Minor Units</div>
          </div>
          <span class="badge-pill badge-blue mono-meta">${escapeHtml(initialCartPricing.currencyCode)}</span>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px; font-size: 0.86rem;">
          <div style="display: flex; justify-content: space-between; color: var(--text-secondary);">
            <span>Winning Order Discount</span>
            <span id="chk-winning-discount" class="mono-meta" style="font-weight: 700;">
              ${escapeHtml(initialCartPricing.appliedOrderDiscounts[0]?.name ?? "None")}
            </span>
          </div>
          <div style="display: flex; justify-content: space-between; color: var(--text-secondary);">
            <span>Total Net</span>
            <span id="chk-total-net" class="mono-meta">${formatMoney(initialCartPricing.totalNetAmount, initialCartPricing.currencyCode)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; color: var(--text-secondary);">
            <span>Total Tax</span>
            <span id="chk-total-tax" class="mono-meta">${formatMoney(initialCartPricing.totalTaxAmount, initialCartPricing.currencyCode)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 1.15rem; font-weight: 750; padding-top: 8px; border-top: 1px solid var(--border-hairline);">
            <span>Total Gross</span>
            <span id="chk-total-gross" class="mono-meta">${formatMoney(initialCartPricing.totalGrossAmount, initialCartPricing.currencyCode)}</span>
          </div>
        </div>

        <button type="button" id="btn-chk-submit" class="btn-primary btn-press" style="width: 100%; padding: 12px 18px;">
          Authorize &amp; Complete 5-Step Saga
        </button>

        <div id="chk-saga-result" class="inline-toast mono-meta" role="status"></div>
      </aside>
    </div>
  </main>

  <script type="module">
    const CHANNEL_SLUG = ${JSON.stringify(activeChannel.slug)};
    const CART_KEY = "kronos_cart_v1";
    const DEFAULT_LINES = [
      { variantId: "KR-KB75-TI", quantity: 1, baseUnitPrice: 10000, isGift: false },
      { variantId: "KR-DAC-BLK", quantity: 1, baseUnitPrice: 10000, isGift: false },
      { variantId: "KR-MG8K-SLV", quantity: 1, baseUnitPrice: 10000, isGift: false },
      { variantId: "KR-CABLE-GIFT", quantity: 1, baseUnitPrice: 2900, isGift: true },
    ];

    function loadCart() {
      try {
        const raw = localStorage.getItem(CART_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {
        // ignore
      }
      return DEFAULT_LINES.map((x) => ({ ...x }));
    }

    let cartLines = loadCart();

    ${STOREFRONT_ESCAPE_HTML_SCRIPT}

    function saveCart() {
      try {
        localStorage.setItem(CART_KEY, JSON.stringify(cartLines));
      } catch {
        // ignore
      }
      const badge = document.getElementById("nav-cart-count");
      if (badge) {
        badge.textContent = String(cartLines.reduce((s, l) => s + (Number(l.quantity) || 0), 0));
      }
    }

    function renderLinesHtml(lines) {
      return lines
        .map(
          (l) =>
            '<div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--bg-subtle);">' +
            '<div>' +
            '<div style="font-weight: 650; font-size: 0.9rem;">' +
            escapeHtml(l.variantId) +
            (l.isGift ? ' <span class="badge-pill badge-blue">FREE GIFT</span>' : "") +
            "</div>" +
            '<div class="mono-meta" style="font-size: 0.74rem; color: var(--text-secondary);">' +
            "Qty " +
            l.quantity +
            " x " +
            l.effectiveBaseFormatted +
            (l.hareNiemeyerSliceFormatted ? " | Hare-Niemeyer Slice: -" + l.hareNiemeyerSliceFormatted : "") +
            " | Tax: " +
            l.taxFormatted +
            "</div>" +
            (l.isGift
              ? ""
              : '<div style="display: inline-flex; gap: 6px; margin-top: 6px;">' +
                '<button type="button" class="btn-secondary btn-press" style="padding: 2px 8px; font-size: 0.74rem;" data-qty-sku="' +
                escapeHtml(l.variantId) +
                '" data-qty-delta="-1">-1</button>' +
                '<button type="button" class="btn-secondary btn-press" style="padding: 2px 8px; font-size: 0.74rem;" data-qty-sku="' +
                escapeHtml(l.variantId) +
                '" data-qty-delta="1">+1</button>' +
                '<button type="button" class="btn-secondary btn-press" style="padding: 2px 8px; font-size: 0.74rem;" data-remove-sku="' +
                escapeHtml(l.variantId) +
                '">Remove</button>' +
                "</div>") +
            "</div>" +
            '<div class="mono-meta" style="font-weight: 700;">' +
            l.totalGrossFormatted +
            "</div>" +
            "</div>"
        )
        .join("");
    }

    async function recalculate() {
      saveCart();
      const res = await fetch("/api/demo/recalculate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelSlug: CHANNEL_SLUG,
          includePromo: document.getElementById("chk-promo")?.checked,
          includeVoucher: document.getElementById("chk-voucher")?.checked,
          includeManual: document.getElementById("chk-manual")?.checked,
          voucherCode: document.getElementById("chk-voucher-code")?.value || "",
          customLines: cartLines,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      document.getElementById("chk-winning-discount").textContent = data.winningDiscountLabel;
      document.getElementById("chk-total-net").textContent = data.totalNetFormatted;
      document.getElementById("chk-total-tax").textContent = data.totalTaxFormatted;
      document.getElementById("chk-total-gross").textContent = data.totalGrossFormatted;
      const container = document.getElementById("chk-lines-container");
      if (container && Array.isArray(data.lines)) {
        container.innerHTML = renderLinesHtml(data.lines);
      }
    }

    document.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const qtySku = btn.getAttribute("data-qty-sku");
      if (qtySku) {
        const delta = Number(btn.getAttribute("data-qty-delta") || "0");
        const row = cartLines.find((l) => l.variantId === qtySku && !l.isGift);
        if (row) {
          row.quantity = Math.max(1, row.quantity + delta);
          recalculate();
        }
        return;
      }
      const remSku = btn.getAttribute("data-remove-sku");
      if (remSku) {
        if (cartLines.filter((l) => !l.isGift).length > 1) {
          cartLines = cartLines.filter((l) => !(l.variantId === remSku && !l.isGift));
          recalculate();
        }
      }
    });

    document.getElementById("btn-chk-add-sku")?.addEventListener("click", () => {
      const sel = document.getElementById("chk-add-sku-select");
      if (!sel) return;
      const opt = sel.options[sel.selectedIndex];
      const sku = sel.value;
      const priceCents = Number(opt?.getAttribute("data-price") || "10000");
      const existing = cartLines.find((l) => l.variantId === sku && !l.isGift);
      if (existing) {
        existing.quantity += 1;
      } else {
        cartLines.unshift({ variantId: sku, quantity: 1, baseUnitPrice: priceCents, isGift: false });
      }
      recalculate();
    });

    document.getElementById("btn-chk-reset-demo")?.addEventListener("click", () => {
      cartLines = DEFAULT_LINES.map((x) => ({ ...x }));
      recalculate();
    });

    ["chk-promo", "chk-voucher", "chk-manual"].forEach((id) => {
      document.getElementById(id)?.addEventListener("change", recalculate);
    });
    document.getElementById("btn-chk-apply-voucher")?.addEventListener("click", recalculate);

    document.getElementById("btn-chk-submit")?.addEventListener("click", async () => {
      const box = document.getElementById("chk-saga-result");
      const btn = document.getElementById("btn-chk-submit");
      if (btn) btn.textContent = "Executing 5-Step Durable Saga...";
      if (box) {
        box.classList.add("visible");
        box.textContent = "Running verify-pricing -> allocate-inventory -> redeem-store-credit -> capture-payment -> commit-order-and-outbox...";
      }
      const storeCreditCents = Number(document.getElementById("chk-store-credit")?.value || "5000");
      const shouldFailPayment = Boolean(document.getElementById("chk-fail-payment")?.checked);
      const res = await fetch("/api/demo/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelSlug: CHANNEL_SLUG,
          shouldFailPayment,
          includePromo: document.getElementById("chk-promo")?.checked,
          includeVoucher: document.getElementById("chk-voucher")?.checked,
          includeManual: document.getElementById("chk-manual")?.checked,
          voucherCode: document.getElementById("chk-voucher-code")?.value || "",
          storeCreditToRedeemCents: storeCreditCents,
          customLines: cartLines,
        }),
      });
      const data = await res.json();
      if (btn) btn.textContent = "Authorize & Complete 5-Step Saga";
      if (!box) return;
      if (!res.ok || data.error) {
        box.innerHTML =
          '<div style="color: var(--warn); font-weight: 700;">CHECKOUT BLOCKED (HTTP ' +
          res.status +
          "): " +
          (data.error || "Unknown error") +
          "</div>";
        return;
      }
      if (data.status === "COMPLETED" && data.orderId) {
        box.innerHTML =
          '<div style="margin-bottom: 8px; color: var(--success); font-weight: 700;">SAGA COMMITTED: Order ' +
          data.orderId +
          " (" +
          data.shipmentCount +
          " Warehouse Slice / " +
          data.warehouseId +
          ")</div>" +
          '<a href="/orders/' +
          encodeURIComponent(data.orderId) +
          "?channel=" +
          encodeURIComponent(CHANNEL_SLUG) +
          '" class="btn-primary btn-press" style="width: 100%;">Open Order &amp; Self-Service RMA -&gt;</a>';
      } else {
        box.innerHTML =
          '<div style="color: var(--warn); font-weight: 700;">SAGA COMPENSATED (LIFO): ' +
          (data.compensatedSteps || []).join(" -&gt; ") +
          " | MSI Stock &amp; Store Credit Restored!</div>";
      }
    });

    recalculate();
  </script>
</body>
</html>`;
}

export function renderOrdersListHtml(input: OrdersListRenderInput): string {
  const { activeChannel, channels, orders, returnsByOrderId } = input;

  const orderRowsHtml =
    orders.length === 0
      ? `<tr><td colspan="7" class="mono-meta" style="text-align: center; padding: 32px; color: var(--text-muted);">No committed orders found yet. Complete a Saga Checkout to inspect orders and test Self-Service RMA returns.</td></tr>`
      : orders
          .map((ord) => {
            const rets = returnsByOrderId[ord.orderId] ?? [];
            const status = ord.paymentStatus ?? "CAPTURED";
            const badgeClass =
              status === "REFUNDED"
                ? "badge-green"
                : status === "PARTIALLY_REFUNDED" || status === "DISPUTED"
                ? "badge-warn"
                : "badge-blue";
            const totalQty = ord.pricing.lines
              .filter((l) => !l.isGift)
              .reduce((s, l) => s + l.quantity, 0);
            return `
      <tr>
        <td class="mono-meta" style="font-weight: 700; color: var(--accent);">
          <a href="/orders/${encodeURIComponent(ord.orderId)}?channel=${encodeURIComponent(activeChannel.slug)}" style="color: inherit; text-decoration: none;">${escapeHtml(ord.orderId)}</a>
        </td>
        <td class="mono-meta">${escapeHtml(ord.channelSlug)}</td>
        <td class="mono-meta">${totalQty} paid unit(s) / ${ord.shipments.map((s) => `${s.warehouseId}(${s.quantityAllocated})`).join(", ")}</td>
        <td class="mono-meta num">${formatMoney(ord.pricing.totalGrossAmount, ord.currencyCode)}</td>
        <td class="mono-meta num">${rets.length} RMA(s)</td>
        <td><span class="badge-pill ${badgeClass} mono-meta">${escapeHtml(status)}</span></td>
        <td class="num">
          <a href="/orders/${encodeURIComponent(ord.orderId)}?channel=${encodeURIComponent(activeChannel.slug)}" class="btn-secondary btn-press" style="padding: 5px 12px; font-size: 0.76rem;">
            Manage &amp; Return -&gt;
          </a>
        </td>
      </tr>`;
          })
          .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Orders &amp; Self-Service RMA Ledger - KRONOS HARDWARE</title>
  <style>${STOREFRONT_SHARED_CSS}</style>
</head>
<body>
  ${renderTopNav({
    activeChannel,
    channels,
    basePath: "/orders",
    activeRoute: "orders",
  })}

  <main class="page-shell">
    <nav class="breadcrumb-bar mono-meta" aria-label="Breadcrumb">
      <a href="/?channel=${encodeURIComponent(activeChannel.slug)}">Catalog</a>
      <span>/</span>
      <span>Orders &amp; Self-Service RMA Ledger</span>
    </nav>

    <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 20px; gap: 12px; flex-wrap: wrap;">
      <div>
        <h1 style="font-size: 1.8rem; font-weight: 750; letter-spacing: -0.025em;">
          Committed Orders &amp; Self-Service RMA Portal
        </h1>
        <p style="font-size: 0.92rem; color: var(--text-secondary);">
          Inspect two-pass Hare-Niemeyer receipts, warehouse fulfillment slices, and run Rust N-API partial return reconciliations.
        </p>
      </div>
      <a href="/checkout?channel=${encodeURIComponent(activeChannel.slug)}" class="btn-primary btn-press">New Saga Checkout</a>
    </div>

    <div class="surface-card-tight">
      <table class="data-table">
        <thead>
          <tr>
            <th>Order ID</th>
            <th>Channel</th>
            <th>Fulfillment Slices</th>
            <th class="num">Total Gross</th>
            <th class="num">RMA History</th>
            <th>Payment Status</th>
            <th class="num">Self-Service RMA</th>
          </tr>
        </thead>
        <tbody>
          ${orderRowsHtml}
        </tbody>
      </table>
    </div>

    ${
      input.pagination
        ? `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; margin-bottom: 24px; gap: 12px; flex-wrap: wrap;">
      <div>
        ${
          input.pagination.hasPrev && input.pagination.prevCursor
            ? `<a href="/orders?channel=${encodeURIComponent(activeChannel.slug)}&limit=${input.pagination.limit}&cursor=${encodeURIComponent(input.pagination.prevCursor)}&direction=prev" class="btn-secondary btn-press" style="padding: 6px 14px; font-size: 0.85rem;">&lt; Previous</a>`
            : `<span class="btn-secondary" style="padding: 6px 14px; font-size: 0.85rem; opacity: 0.45; cursor: not-allowed;">&lt; Previous</span>`
        }
      </div>
      <span class="mono-meta" style="font-size: 0.85rem; color: var(--text-secondary);">
        Showing ${orders.length} of ${input.pagination.totalMatchingCount} order(s) (Page size: ${input.pagination.limit})
      </span>
      <div>
        ${
          input.pagination.hasMore && input.pagination.nextCursor
            ? `<a href="/orders?channel=${encodeURIComponent(activeChannel.slug)}&limit=${input.pagination.limit}&cursor=${encodeURIComponent(input.pagination.nextCursor)}&direction=next" class="btn-secondary btn-press" style="padding: 6px 14px; font-size: 0.85rem;">Next &gt;</a>`
            : `<span class="btn-secondary" style="padding: 6px 14px; font-size: 0.85rem; opacity: 0.45; cursor: not-allowed;">Next &gt;</span>`
        }
      </div>
    </div>`
        : ""
    }
  </main>

  <script type="module">
    try {
      const raw = localStorage.getItem("kronos_cart_v1");
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        const badge = document.getElementById("nav-cart-count");
        if (badge) badge.textContent = String(parsed.reduce((s, l) => s + (Number(l.quantity) || 0), 0));
      }
    } catch {
      // ignore
    }
  </script>
</body>
</html>`;
}

export function renderOrderDetailRmaHtml(input: OrderDetailRmaRenderInput): string {
  const {
    activeChannel,
    channels,
    order,
    priorReturns,
    initialRmaPreview,
    warehousePriorityById,
  } = input;
  const currency = order.currencyCode;

  const returnedQtyByLine = new Map<string, number>();
  for (const rma of priorReturns) {
    for (const l of rma.calculation.lines) {
      returnedQtyByLine.set(
        l.lineId,
        (returnedQtyByLine.get(l.lineId) ?? 0) + l.acceptedReturnQuantity
      );
    }
  }

  const orderLinesRowsHtml = order.pricing.lines
    .map((line) => {
      const returned = returnedQtyByLine.get(line.lineId) ?? 0;
      const remaining = line.isGift ? 0 : Math.max(0, line.quantity - returned);
      return `
      <tr>
        <td class="mono-meta" style="font-weight: 700;">${escapeHtml(line.lineId)}</td>
        <td class="mono-meta">${escapeHtml(line.variantId)} ${line.isGift ? '<span class="badge-pill badge-blue">FREE GIFT</span>' : ""}</td>
        <td class="num">${line.quantity}</td>
        <td class="num">${returned}</td>
        <td class="num" style="font-weight: 700; color: ${remaining > 0 ? "var(--accent)" : "var(--text-muted)"};">${remaining}</td>
        <td class="num">-${formatMoney(line.allocatedOrderDiscountAmount, currency)}</td>
        <td class="num">${formatMoney(line.totalNetAmount, currency)}</td>
        <td class="num">${formatMoney(line.totalTaxAmount, currency)}</td>
        <td class="num" style="font-weight: 700;">${formatMoney(line.totalGrossAmount, currency)}</td>
      </tr>`;
    })
    .join("");

  const shipmentRowsHtml =
    order.shipments.length === 0
      ? `<tr><td colspan="4" class="mono-meta" style="text-align: center; color: var(--text-muted);">No warehouse allocations recorded.</td></tr>`
      : order.shipments
          .map((s, idx) => {
            const rank =
              (s as { priorityRank?: number }).priorityRank ??
              warehousePriorityById?.[s.warehouseId];
            const rankLabel =
              typeof rank === "number" ? `#${rank}` : `Slice #${idx + 1}`;
            return `
      <tr>
        <td class="mono-meta" style="font-weight: 700;">${escapeHtml(s.warehouseId)}</td>
        <td class="mono-meta">${rankLabel}</td>
        <td class="mono-meta">${escapeHtml(s.lineId)} (${escapeHtml(s.variantId)})</td>
        <td class="num">${s.quantityAllocated} unit(s)</td>
      </tr>`;
          })
          .join("");

  const priorRmaRowsHtml =
    priorReturns.length === 0
      ? `<tr><td colspan="6" class="mono-meta" style="text-align: center; color: var(--text-muted);">No RMA returns executed on this order yet. Use the Self-Service RMA Estimator on the right to calculate and submit a partial or full return.</td></tr>`
      : priorReturns
          .map((rma) => {
            const lineDesc = rma.calculation.lines
              .filter((l) => l.acceptedReturnQuantity > 0)
              .map(
                (l) =>
                  `${l.variantId} x${l.acceptedReturnQuantity}/${l.originalQuantity}${
                    l.isFinalUnitReconciliation ? " [FINAL_CEILING]" : ""
                  }`
              )
              .join(", ");
            const restockDesc = rma.restockedSlices
              .map((s) => `${s.warehouseId}: +${s.quantityReturned} (${s.condition})`)
              .join(", ");
            return `
      <tr>
        <td class="mono-meta" style="font-weight: 700; color: var(--accent);">${escapeHtml(rma.rmaId)}</td>
        <td class="mono-meta">${escapeHtml(lineDesc)}</td>
        <td class="mono-meta">${escapeHtml(restockDesc || "0 units")}</td>
        <td class="num" style="font-weight: 700; color: var(--success);">${formatMoney(rma.calculation.totalRefundGrossAmount, currency)}</td>
        <td class="mono-meta">Cash ${formatMoney(rma.calculation.paymentGatewayRefundAmount, currency)} / SC ${formatMoney(rma.calculation.storeCreditRefundAmount, currency)}</td>
        <td><span class="badge-pill badge-green mono-meta">${escapeHtml(rma.orderPaymentStatusAfter)}</span></td>
      </tr>`;
          })
          .join("");

  const returnableLines = order.pricing.lines
    .filter((l) => !l.isGift)
    .map((l) => {
      const returned = returnedQtyByLine.get(l.lineId) ?? 0;
      const remaining = Math.max(0, l.quantity - returned);
      return { line: l, returned, remaining };
    })
    .filter((entry) => entry.remaining > 0);

  const returnControlsHtml =
    returnableLines.length === 0
      ? `<div class="inline-toast visible mono-meta" style="background: var(--success-soft); border-color: rgba(5, 150, 105, 0.25);">
           All paid units on order ${escapeHtml(order.orderId)} have reached their refundable ceiling (0 remaining units).
         </div>`
      : returnableLines
          .map(
            ({ line, remaining }, idx) => `
      <div class="rma-line-control" data-rma-line-id="${escapeHtml(line.lineId)}" style="padding: 12px; border: 1px solid var(--border-hairline); border-radius: 8px; background: var(--bg-primary); display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong class="mono-meta" style="font-size: 0.82rem;">${escapeHtml(line.lineId)} // ${escapeHtml(line.variantId)}</strong>
          <span class="mono-meta" style="font-size: 0.74rem; color: var(--text-muted);">${remaining} returnable</span>
        </div>
        <div class="rma-inputs-grid">
          <div>
            <label class="mono-meta" style="display: block; font-size: 0.68rem; color: var(--text-muted); margin-bottom: 2px;">Return Qty</label>
            <input type="number"
                   class="field-input mono-meta rma-qty-input"
                   data-line-id="${escapeHtml(line.lineId)}"
                   min="0"
                   max="${remaining}"
                   value="${idx === 0 ? 1 : 0}" />
          </div>
          <div>
            <label class="mono-meta" style="display: block; font-size: 0.68rem; color: var(--text-muted); margin-bottom: 2px;">Item Condition</label>
            <select class="field-select mono-meta rma-condition-select" data-line-id="${escapeHtml(line.lineId)}">
              <option value="RESELLABLE">RESELLABLE (Restock MSI)</option>
              <option value="DAMAGED_QUARANTINE">DAMAGED_QUARANTINE</option>
            </select>
          </div>
          <div class="rma-fee-col">
            <label class="mono-meta" style="display: block; font-size: 0.68rem; color: var(--text-muted); margin-bottom: 2px;">Restock Fee</label>
            <select class="field-select mono-meta rma-fee-select" data-line-id="${escapeHtml(line.lineId)}">
              <option value="0">0% (0 bps)</option>
              <option value="1500">15% (1500 bps)</option>
            </select>
          </div>
        </div>
      </div>`
          )
          .join("");

  const previewHtml = initialRmaPreview
    ? `
      <div style="display: flex; justify-content: space-between;"><span>Ceiling Consumed</span><span class="mono-meta">${formatMoney(initialRmaPreview.totalGrossCeilingConsumed, currency)}</span></div>
      <div style="display: flex; justify-content: space-between;"><span>Restocking Fee</span><span class="mono-meta">-${formatMoney(initialRmaPreview.totalRestockingFeeAmount, currency)}</span></div>
      <div style="display: flex; justify-content: space-between;"><span>Gateway Cash Refund</span><span class="mono-meta">${formatMoney(initialRmaPreview.paymentGatewayRefundAmount, currency)}</span></div>
      <div style="display: flex; justify-content: space-between;"><span>Store Credit Refund</span><span class="mono-meta">${formatMoney(initialRmaPreview.storeCreditRefundAmount, currency)}</span></div>
      <div style="display: flex; justify-content: space-between; font-weight: 750; font-size: 1rem; padding-top: 6px; border-top: 1px solid var(--border-hairline);"><span>Total Refund Gross</span><span class="mono-meta" style="color: var(--success);">${formatMoney(initialRmaPreview.totalRefundGrossAmount, currency)}</span></div>`
    : `<div class="mono-meta" style="color: var(--text-muted);">Adjust quantities above to compute exact Rust ceiling reconciliation.</div>`;

  const status = order.paymentStatus ?? "CAPTURED";
  const statusClass =
    status === "REFUNDED"
      ? "badge-green"
      : status === "PARTIALLY_REFUNDED" || status === "DISPUTED"
      ? "badge-warn"
      : "badge-blue";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Order ${escapeHtml(order.orderId)} &amp; Self-Service RMA - KRONOS HARDWARE</title>
  <style>${STOREFRONT_SHARED_CSS}</style>
</head>
<body>
  ${renderTopNav({
    activeChannel,
    channels,
    basePath: `/orders/${encodeURIComponent(order.orderId)}`,
    activeRoute: "orders",
  })}

  <main class="page-shell">
    <nav class="breadcrumb-bar mono-meta" aria-label="Breadcrumb">
      <a href="/?channel=${encodeURIComponent(activeChannel.slug)}">Catalog</a>
      <span>/</span>
      <a href="/orders?channel=${encodeURIComponent(activeChannel.slug)}">Orders &amp; RMA</a>
      <span>/</span>
      <span style="color: var(--accent); font-weight: 700;">${escapeHtml(order.orderId)}</span>
    </nav>

    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 22px; gap: 16px; flex-wrap: wrap;">
      <div>
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <h1 style="font-size: 1.75rem; font-weight: 750; letter-spacing: -0.025em;" class="mono-meta">
            ${escapeHtml(order.orderId)}
          </h1>
          <span id="order-status-badge" class="badge-pill ${statusClass} mono-meta">${escapeHtml(status)}</span>
        </div>
        <p class="mono-meta" style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">
          Channel: ${escapeHtml(order.channelSlug)} | Payment Tx: ${escapeHtml(order.paymentTransactionId ?? "STORE_CREDIT")} (${formatMoney(order.paymentCapturedAmount ?? 0n, currency)}) | Store Credit Redeemed: ${formatMoney(order.storeCreditRedeemedAmount ?? 0n, currency)}
        </p>
      </div>
      <div style="text-align: right;">
        <div class="mono-meta" style="font-size: 0.72rem; color: var(--text-muted);">ORIGINAL ORDER TOTAL</div>
        <div class="mono-meta" style="font-size: 1.5rem; font-weight: 750;">${formatMoney(order.pricing.totalGrossAmount, currency)}</div>
      </div>
    </div>

    <div class="split-2col">
      <div style="display: flex; flex-direction: column; gap: 20px;">
        <section class="surface-card">
          <h2 style="font-size: 1.05rem; font-weight: 700; margin-bottom: 10px;">Committed Two-Pass Hare-Niemeyer Order Lines</h2>
          <div class="surface-card-tight">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Variant SKU</th>
                  <th class="num">Orig</th>
                  <th class="num">Ret</th>
                  <th class="num">Left</th>
                  <th class="num">Order Slice</th>
                  <th class="num">Net</th>
                  <th class="num">Tax</th>
                  <th class="num">Gross</th>
                </tr>
              </thead>
              <tbody>
                ${orderLinesRowsHtml}
              </tbody>
            </table>
          </div>
        </section>

        <section class="surface-card">
          <h2 style="font-size: 1.05rem; font-weight: 700; margin-bottom: 10px;">MSI Warehouse Fulfillment Slices</h2>
          <div class="surface-card-tight">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Warehouse</th>
                  <th>Priority Rank</th>
                  <th>Line &amp; Variant</th>
                  <th class="num">Allocated</th>
                </tr>
              </thead>
              <tbody>
                ${shipmentRowsHtml}
              </tbody>
            </table>
          </div>
        </section>

        <section class="surface-card">
          <h2 style="font-size: 1.05rem; font-weight: 700; margin-bottom: 10px;">Committed RMA Return &amp; Penny Ceiling Ledger</h2>
          <div class="surface-card-tight">
            <table class="data-table">
              <thead>
                <tr>
                  <th>RMA ID</th>
                  <th>Returned Lines</th>
                  <th>MSI Action</th>
                  <th class="num">Refund Gross</th>
                  <th>Tender Split</th>
                  <th>Status After</th>
                </tr>
              </thead>
              <tbody id="order-prior-rma-tbody">
                ${priorRmaRowsHtml}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <aside class="surface-card" style="position: sticky; top: 88px; display: flex; flex-direction: column; gap: 14px;">
        <div style="border-bottom: 1px solid var(--border-hairline); padding-bottom: 10px;">
          <h2 style="font-size: 1.05rem; font-weight: 700;">Self-Service RMA Return Estimator</h2>
          <div class="mono-meta" style="font-size: 0.74rem; color: var(--text-muted);">
            Live Rust N-API calculateReturnRefund + Final-Unit Penny Ceiling Guard
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 10px;">
          ${returnControlsHtml}
        </div>

        <div style="display: grid; grid-template-columns: 1fr; gap: 10px;">
          <div>
            <label for="rma-tender-priority" class="mono-meta" style="display: block; font-size: 0.72rem; color: var(--text-muted); margin-bottom: 4px;">
              REFUND TENDER PRIORITY
            </label>
            <select id="rma-tender-priority" class="field-select mono-meta">
              <option value="GATEWAY_CASH_FIRST">GATEWAY_CASH_FIRST (Card Refund Priority)</option>
              <option value="STORE_CREDIT_FIRST">STORE_CREDIT_FIRST (Restore Store Credit Priority)</option>
            </select>
          </div>
          <div>
            <label for="rma-reason-input" class="mono-meta" style="display: block; font-size: 0.72rem; color: var(--text-muted); margin-bottom: 4px;">
              RETURN REASON
            </label>
            <input type="text" id="rma-reason-input" class="field-input" value="Self-Service Partial Return (Switch Preference)" />
          </div>
        </div>

        <div id="rma-preview-box" style="background: var(--bg-subtle); border-radius: var(--radius-btn); padding: 14px; display: flex; flex-direction: column; gap: 6px; font-size: 0.84rem;">
          ${previewHtml}
        </div>

        <div id="rma-line-flags" class="mono-meta" style="font-size: 0.73rem; color: var(--text-secondary);"></div>

        <button type="button" id="btn-submit-rma" class="btn-primary btn-press" ${returnableLines.length === 0 ? "disabled" : ""}>
          Submit Self-Service RMA
        </button>

        <div id="rma-submit-status" class="inline-toast mono-meta" role="status"></div>
      </aside>
    </div>
  </main>

  <script type="module">
    ${STOREFRONT_ESCAPE_HTML_SCRIPT}
    const ORDER_ID = ${JSON.stringify(order.orderId)};

    function collectRmaLines() {
      const lines = [];
      document.querySelectorAll(".rma-line-control").forEach((box) => {
        const lineId = box.getAttribute("data-rma-line-id");
        const qtyInput = box.querySelector(".rma-qty-input");
        const condSel = box.querySelector(".rma-condition-select");
        const feeSel = box.querySelector(".rma-fee-select");
        const qty = Number(qtyInput?.value || "0") || 0;
        if (lineId && qty > 0) {
          lines.push({
            lineId,
            quantity: qty,
            condition: condSel?.value || "RESELLABLE",
            restockingFeeBps: Number(feeSel?.value || "0") || 0,
          });
        }
      });
      return lines;
    }

    async function refreshRmaEstimate() {
      const linesToReturn = collectRmaLines();
      const previewEl = document.getElementById("rma-preview-box");
      const flagsEl = document.getElementById("rma-line-flags");
      const submitBtn = document.getElementById("btn-submit-rma");
      if (linesToReturn.length === 0) {
        if (previewEl) {
          previewEl.innerHTML = '<div class="mono-meta" style="color: var(--text-muted);">Select at least 1 unit above to preview exact refund reconciliation.</div>';
        }
        if (flagsEl) flagsEl.textContent = "";
        if (submitBtn) submitBtn.disabled = true;
        return;
      }
      if (submitBtn) submitBtn.disabled = false;

      const res = await fetch("/api/demo/rma-estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId: ORDER_ID,
          tenderPriority: document.getElementById("rma-tender-priority")?.value || "GATEWAY_CASH_FIRST",
          linesToReturn,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (previewEl && data.preview) {
        const p = data.preview;
        previewEl.innerHTML =
          '<div style="display: flex; justify-content: space-between;"><span>Ceiling Consumed</span><span class="mono-meta">' + p.totalGrossCeilingFormatted + "</span></div>" +
          '<div style="display: flex; justify-content: space-between;"><span>Restocking Fee</span><span class="mono-meta">-' + p.totalRestockingFeeFormatted + "</span></div>" +
          '<div style="display: flex; justify-content: space-between;"><span>Net Refund</span><span class="mono-meta">' + p.totalRefundNetFormatted + "</span></div>" +
          '<div style="display: flex; justify-content: space-between;"><span>Tax Refund</span><span class="mono-meta">' + p.totalRefundTaxFormatted + "</span></div>" +
          '<div style="display: flex; justify-content: space-between;"><span>Gateway Cash Refund</span><span class="mono-meta">' + p.gatewayRefundFormatted + "</span></div>" +
          '<div style="display: flex; justify-content: space-between;"><span>Store Credit Refund</span><span class="mono-meta">' + p.storeCreditRefundFormatted + "</span></div>" +
          '<div style="display: flex; justify-content: space-between; font-weight: 750; font-size: 1rem; padding-top: 6px; border-top: 1px solid var(--border-hairline);"><span>Total Refund Gross</span><span class="mono-meta" style="color: var(--success);">' + p.totalRefundGrossFormatted + "</span></div>";
      }
      if (flagsEl && Array.isArray(data.lineBreakdown)) {
        flagsEl.innerHTML = data.lineBreakdown
          .map(
            (l) =>
              "<div>" +
              escapeHtml(l.variantId) +
              " x" +
              l.acceptedReturnQuantity +
              ": " +
              l.refundGrossFormatted +
              (l.isFinalUnitReconciliation ? ' <span class="badge-pill badge-green">FINAL_CEILING RECONCILED</span>' : "") +
              "</div>"
          )
          .join("");
      }
    }

    document.querySelectorAll(".rma-qty-input, .rma-condition-select, .rma-fee-select").forEach((el) => {
      el.addEventListener("input", refreshRmaEstimate);
      el.addEventListener("change", refreshRmaEstimate);
    });
    document.getElementById("rma-tender-priority")?.addEventListener("change", refreshRmaEstimate);

    document.getElementById("btn-submit-rma")?.addEventListener("click", async () => {
      const linesToReturn = collectRmaLines();
      if (linesToReturn.length === 0) return;
      const btn = document.getElementById("btn-submit-rma");
      const statusBox = document.getElementById("rma-submit-status");
      if (btn) btn.textContent = "Executing 5-Step RMA Saga...";
      if (statusBox) {
        statusBox.classList.add("visible");
        statusBox.textContent = "Running verify-rma-calculation -> restock-msi-inventory -> restore-store-credit -> refund-payment-gateway -> commit-rma-and-outbox...";
      }
      const res = await fetch("/api/demo/rma-submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId: ORDER_ID,
          tenderPriority: document.getElementById("rma-tender-priority")?.value || "GATEWAY_CASH_FIRST",
          reason: document.getElementById("rma-reason-input")?.value || "Self-Service Return",
          linesToReturn,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        if (statusBox) {
          statusBox.innerHTML =
            '<div style="color: var(--success); font-weight: 700;">RMA COMMITTED: ' +
            data.rmaId +
            " -> " +
            data.totalRefundGrossFormatted +
            " (" +
            data.orderPaymentStatusAfter +
            ")</div>";
        }
        setTimeout(() => window.location.reload(), 450);
      } else {
        if (btn) btn.textContent = "Submit Self-Service RMA";
        if (statusBox) {
          statusBox.textContent = "RMA ERROR: " + (data.error || "Unable to execute RMA");
        }
      }
    });

    if (document.querySelectorAll(".rma-line-control").length > 0) {
      refreshRmaEstimate();
    }
  </script>
</body>
</html>`;
}
