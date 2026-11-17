/**
 * `@super-ecommerce/storefront`
 *
 * Design Read: Flagship precision hardware storefront for technical buyers,
 * with a Cold Luxury (titanium-alabaster + obsidian + single locked Electric Cobalt #2563EB accent)
 * language, asymmetric split hero, zero em-dashes, and Emil Kowalski tactile micro-interactions
 * (`cubic-bezier(0.23, 1, 0.32, 1)`, `:active { transform: scale(0.97) }`).
 *
 * DIALS: DESIGN_VARIANCE: 7 | MOTION_INTENSITY: 5 | VISUAL_DENSITY: 4
 */

import type {
  CatalogChannelProjectionRecord,
  CatalogJsonbFacetQueryResult,
  ChannelRecord,
  FacetDimensionGroup,
} from "@super-ecommerce/db";
import type { CartCalculationResult } from "@super-ecommerce/kernel";

export {
  renderProductDetailHtml,
  renderCheckoutPageHtml,
  renderOrdersListHtml,
  renderOrderDetailRmaHtml,
  type ProductDetailRenderInput,
  type CheckoutPageRenderInput,
  type CheckoutCatalogItemOption,
  type OrdersListRenderInput,
  type OrderDetailRmaRenderInput,
} from "./pdp-checkout-rma.ts";

export interface StorefrontRenderInput {
  readonly activeChannel: ChannelRecord;
  readonly channels: readonly ChannelRecord[];
  readonly projections: readonly CatalogChannelProjectionRecord[];
  readonly initialCartPricing: CartCalculationResult;
  readonly facetQueryResult?: CatalogJsonbFacetQueryResult;
}

function formatMoney(minorUnits: bigint | number | string, currencyCode: string): string {
  const num = Number(minorUnits) / 100;
  const symbol = currencyCode === "EUR" ? "€" : "$";
  return `${symbol}${num.toFixed(2)}`;
}

function buildDefaultFacetGroups(
  projections: readonly CatalogChannelProjectionRecord[]
): FacetDimensionGroup[] {
  const dims = [
    { key: "source_container", label: "Source Container (JSONB @>)" },
    { key: "category", label: "Category Facet (JSONB @>)" },
    { key: "product_type", label: "Product Type (JSONB @>)" },
    { key: "finish", label: "Hardware Finish (JSONB @>)" },
  ];
  return dims
    .map((d) => {
      const counts = new Map<string, number>();
      for (const p of projections) {
        for (const v of p.mergedAttributes[d.key] ?? []) {
          const s = String(v);
          counts.set(s, (counts.get(s) ?? 0) + 1);
        }
      }
      return {
        key: d.key,
        label: d.label,
        buckets: [...counts.entries()].map(([value, count]) => ({
          value,
          count,
          selected: false,
        })),
      };
    })
    .filter((g) => g.buckets.length > 0);
}

export function renderStorefrontHtml(input: StorefrontRenderInput): string {
  const { activeChannel, channels, projections, initialCartPricing, facetQueryResult } = input;
  const initialFacetGroups =
    facetQueryResult?.facetGroups ?? buildDefaultFacetGroups(projections);
  const initialLatencyUs = facetQueryResult?.queryLatencyUs ?? 312.4;
  const initialTotalCount = facetQueryResult?.totalUnfilteredCount ?? projections.length;
  const initialMatchedCount = facetQueryResult?.matchedCount ?? projections.length;
  const initialSqlPreview =
    facetQueryResult?.executedSql ??
    `SELECT product_slug, product_name, min_effective_price, total_available_qty, merged_attributes\nFROM catalog_channel_projections\nWHERE channel_slug = '${activeChannel.slug}' AND is_in_stock = true\nORDER BY updated_at DESC LIMIT 24;`;

  const facetGroupsHtml = initialFacetGroups
    .map(
      (grp) => `
      <div class="facet-dimension-row">
        <span class="facet-dim-label mono-meta">${grp.label}</span>
        <div class="facet-pill-list">
          ${grp.buckets
            .map(
              (b) => `
            <button type="button"
                    class="facet-pill btn-press mono-meta ${b.selected ? "active" : ""}"
                    data-facet-dim="${grp.key}"
                    data-facet-val="${b.value}">
              <span>${b.value}</span>
              <span class="facet-count">(${b.count})</span>
            </button>`
            )
            .join("")}
        </div>
      </div>`
    )
    .join("");

  const channelOptionsHtml = channels
    .map(
      (ch) => `
      <a href="/?channel=${ch.slug}"
         data-channel-switch="${ch.slug}"
         class="channel-pill ${ch.slug === activeChannel.slug ? "active" : ""}">
        <span>${ch.slug.toUpperCase()}</span>
        <span class="mono-meta">${ch.currencyCode} / ${ch.taxInclusionMode === "TAX_INCLUSIVE" ? "VAT Incl." : "Tax Excl."}</span>
      </a>`
    )
    .join("");

  const productCardsHtml = projections
    .map((p, idx) => {
      const attrBadges = Object.entries(p.mergedAttributes)
        .map(([k, vals]) => {
          const firstVal = String(vals[0] ?? "");
          return `<button type="button" class="spec-chip btn-press" data-facet-dim="${k}" data-facet-val="${firstVal}">${k}: ${vals.join(", ")}</button>`;
        })
        .join("");

      const firstVariant = p.variantsSnapshot[0];
      const variantSku = firstVariant?.sku ?? p.productSlug.toUpperCase();
      const variantId = firstVariant?.variantId ?? p.productId;
      const compareAt =
        firstVariant?.compareAtAmount && firstVariant.compareAtAmount > p.minEffectivePrice
          ? `<span class="price-compare">${formatMoney(firstVariant.compareAtAmount, p.currencyCode)}</span>`
          : "";

      const imageSeed = `kronos-hw-${p.productSlug}`;
      const pdpHref = `/products/${encodeURIComponent(p.productSlug)}?channel=${encodeURIComponent(activeChannel.slug)}`;
      return `
      <article class="product-tile stagger-item" style="animation-delay: ${idx * 55}ms" data-product-slug="${p.productSlug}">
        <a href="${pdpHref}" class="product-media" style="display: block;">
          <img src="https://picsum.photos/seed/${imageSeed}/720/540"
               alt="${p.productName}"
               width="720"
               height="540"
               loading="${idx < 2 ? "eager" : "lazy"}" />
        </a>
        <div class="product-body">
          <div class="product-header">
            <div>
              <h3 class="product-title"><a href="${pdpHref}" style="color: inherit; text-decoration: none;">${p.productName}</a></h3>
              <p class="product-sku">SKU: ${variantSku} / Avail: ${p.totalAvailableQty} units</p>
            </div>
            <div class="product-price-block">
              ${compareAt}
              <span class="product-price">${formatMoney(p.minEffectivePrice, p.currencyCode)}</span>
            </div>
          </div>
          <div class="spec-row">${attrBadges}</div>
          <div class="product-actions" style="gap: 8px;">
            <a href="${pdpHref}" class="btn-secondary btn-press" style="padding: 9px 12px; font-size: 0.8rem;">
              Variants &amp; Stock
            </a>
            <button type="button"
                    class="btn-primary btn-press"
                    data-add-variant="${variantId}"
                    data-add-sku="${variantSku}"
                    data-variant-name="${p.productName}"
                    data-base-price="${p.minEffectivePrice.toString()}">
              Add to Cart
            </button>
          </div>
        </div>
      </article>`;
    })
    .join("");

  const initialWaterfallLinesHtml = initialCartPricing.lines
    .map(
      (line) => `
      <div class="cart-line-row">
        <div>
          <div class="cart-line-title">${line.variantId} ${line.isGift ? '<span class="gift-tag">FREE GIFT</span>' : ""}</div>
          <div class="cart-line-sub">
            Qty ${line.quantity} x ${formatMoney(line.effectiveBaseUnitPrice, initialCartPricing.currencyCode)}
            ${line.lineLevelDiscountAmount > 0n ? ` | Line Promo: -${formatMoney(line.lineLevelDiscountAmount, initialCartPricing.currencyCode)}` : ""}
            ${line.allocatedOrderDiscountAmount > 0n ? ` | Hare-Niemeyer Slice: -${formatMoney(line.allocatedOrderDiscountAmount, initialCartPricing.currencyCode)}` : ""}
          </div>
        </div>
        <div class="cart-line-total">${formatMoney(line.totalGrossAmount, initialCartPricing.currencyCode)}</div>
      </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>KRONOS HARDWARE - Precision Commerce Storefront</title>
  <style>
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

    .mono-meta, .product-sku, .product-price, .cart-line-total, .waterfall-num {
      font-family: "Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
      font-variant-numeric: tabular-nums;
    }

    /* Single-line desktop navigation capped at 68px height (wraps cleanly on compact panes) */
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
      font-size: 1.05rem;
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
      font-size: 0.74rem;
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
      transition: transform 160ms var(--ease-out-strong), background-color 160ms ease-out;
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
      white-space: nowrap;
    }

    .btn-primary:hover {
      background: var(--accent-hover);
    }

    .btn-secondary {
      background: var(--bg-elevated);
      color: var(--text-primary);
      border: 1px solid var(--border-hairline);
      padding: 10px 16px;
      border-radius: var(--radius-btn);
      font-weight: 600;
      font-size: 0.85rem;
      text-decoration: none;
      white-space: nowrap;
    }

    /* Asymmetric Split Hero fitting inside initial viewport (pt-16) */
    .hero-section {
      max-width: 1360px;
      margin: 0 auto;
      padding: 48px 24px 40px;
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 40px;
      align-items: center;
    }

    .hero-eyebrow {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--accent);
      font-weight: 700;
      margin-bottom: 12px;
    }

    .hero-headline {
      font-size: clamp(2.25rem, 4vw, 3.5rem);
      line-height: 1.04;
      letter-spacing: -0.035em;
      font-weight: 750;
      margin-bottom: 16px;
    }

    .hero-subtext {
      font-size: 1.05rem;
      color: var(--text-secondary);
      max-width: 52ch;
      margin-bottom: 24px;
    }

    .hero-ctas {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .hero-visual {
      border-radius: var(--radius-card);
      overflow: hidden;
      border: 1px solid var(--border-hairline);
      background: var(--bg-elevated);
      box-shadow: 0 16px 40px rgba(9, 13, 22, 0.06);
    }

    .hero-visual img {
      width: 100%;
      height: 340px;
      object-fit: cover;
      display: block;
    }

    /* Main Commerce Grid: Left Catalog CQRS Projections, Right Live Kernel & Saga Checkout */
    .hero-section > *, .commerce-workspace > * {
      min-width: 0;
    }

    .commerce-workspace {
      max-width: 1360px;
      margin: 0 auto;
      padding: 24px 24px 80px;
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(0, 0.65fr);
      gap: 32px;
      align-items: start;
    }

    .section-title {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 6px;
    }

    .section-desc {
      font-size: 0.9rem;
      color: var(--text-secondary);
      margin-bottom: 20px;
    }

    .catalog-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 20px;
    }

    .product-tile {
      background: var(--bg-elevated);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-card);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .product-media img {
      width: 100%;
      height: 200px;
      object-fit: cover;
      display: block;
      background: var(--bg-subtle);
    }

    .product-body {
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      flex: 1;
    }

    .product-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }

    .product-title {
      font-size: 1.05rem;
      font-weight: 650;
    }

    .product-sku {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .product-price-block {
      text-align: right;
    }

    .price-compare {
      font-size: 0.78rem;
      color: var(--text-muted);
      text-decoration: line-through;
      display: block;
    }

    .product-price {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .spec-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .spec-chip {
      font-size: 0.73rem;
      padding: 3px 8px;
      border-radius: 6px;
      background: var(--bg-subtle);
      color: var(--text-secondary);
      border: 1px solid transparent;
      font-weight: 500;
      cursor: pointer;
    }

    .spec-chip:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-soft);
    }

    /* Multi-Dimensional PostgreSQL JSONB @> Facet Filter Workbench */
    .facet-workbench {
      background: var(--bg-elevated);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-card);
      padding: 18px;
      margin-bottom: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .facet-top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border-hairline);
    }

    .facet-telemetry-group {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .facet-badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 0.72rem;
      font-weight: 700;
      background: var(--accent-soft);
      color: var(--accent);
      border: 1px solid rgba(37, 99, 235, 0.22);
    }

    .facet-search-row {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .facet-search-input {
      width: 100%;
      padding: 8px 12px;
      border-radius: var(--radius-btn);
      border: 1px solid var(--border-hairline);
      background: var(--bg-primary);
      font-size: 0.82rem;
      color: var(--text-primary);
      outline: none;
    }

    .facet-search-input:focus {
      border-color: var(--accent);
    }

    .facet-dimension-row {
      display: grid;
      grid-template-columns: 185px minmax(0, 1fr);
      gap: 10px;
      align-items: flex-start;
    }

    .facet-dim-label {
      font-size: 0.72rem;
      font-weight: 700;
      color: var(--text-muted);
      padding-top: 5px;
    }

    .facet-pill-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .facet-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--border-hairline);
      background: var(--bg-primary);
      color: var(--text-secondary);
      font-size: 0.73rem;
      font-weight: 600;
      cursor: pointer;
    }

    .facet-pill.active {
      background: var(--accent);
      color: #FFFFFF;
      border-color: var(--accent);
    }

    .facet-count {
      opacity: 0.75;
      font-size: 0.68rem;
    }

    .facet-sql-box {
      background: #0F172A;
      color: #E2E8F0;
      border-radius: var(--radius-btn);
      padding: 10px 12px;
      font-size: 0.72rem;
      line-height: 1.45;
      overflow-x: auto;
      white-space: pre-wrap;
    }

    .product-actions {
      margin-top: auto;
      display: flex;
      justify-content: flex-end;
      flex-wrap: wrap;
    }

    /* Sticky Live Kernel Cart & Saga Checkout Panel */
    .checkout-drawer {
      position: sticky;
      top: 88px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-hairline);
      border-radius: var(--radius-card);
      padding: 22px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .drawer-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border-hairline);
    }

    .cart-line-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding: 10px 0;
      border-bottom: 1px solid var(--bg-subtle);
      gap: 12px;
    }

    .cart-line-title {
      font-size: 0.88rem;
      font-weight: 600;
    }

    .cart-line-sub {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-top: 2px;
    }

    .gift-tag {
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 0.68rem;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 700;
      margin-left: 6px;
    }

    .discount-controls {
      background: var(--bg-subtle);
      padding: 12px;
      border-radius: var(--radius-btn);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .discount-controls label {
      font-size: 0.78rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }

    .waterfall-summary {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 0.85rem;
      padding-top: 8px;
    }

    .waterfall-row {
      display: flex;
      justify-content: space-between;
      color: var(--text-secondary);
    }

    .waterfall-row.total {
      font-size: 1.05rem;
      font-weight: 700;
      color: var(--text-primary);
      padding-top: 8px;
      border-top: 1px solid var(--border-hairline);
    }

    .saga-status-box {
      font-size: 0.8rem;
      padding: 12px;
      border-radius: var(--radius-btn);
      background: var(--accent-soft);
      color: var(--text-primary);
      border: 1px solid rgba(37, 99, 235, 0.25);
      display: none;
    }

    .saga-status-box.visible {
      display: block;
    }

    .qty-controls {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
    }

    .qty-btn {
      background: var(--bg-subtle);
      color: var(--text-primary);
      border: 1px solid var(--border-hairline);
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 0.74rem;
      font-weight: 700;
      cursor: pointer;
      transition: transform 140ms var(--ease-out-strong), background-color 140ms ease-out;
    }

    .qty-btn:active {
      transform: scale(0.95);
    }

    .voucher-bar {
      display: flex;
      gap: 6px;
      margin-top: 4px;
    }

    .voucher-input {
      flex: 1;
      padding: 7px 10px;
      border-radius: 6px;
      border: 1px solid var(--border-hairline);
      background: var(--bg-elevated);
      font-size: 0.78rem;
      color: var(--text-primary);
      outline: none;
    }

    .voucher-pill-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 4px;
    }

    .voucher-pill {
      font-size: 0.7rem;
      padding: 3px 8px;
      border-radius: 6px;
      border: 1px solid var(--border-hairline);
      background: var(--bg-elevated);
      color: var(--accent);
      font-weight: 700;
      cursor: pointer;
    }

    /* Slide-over Interactive Cart Drawer (240ms iOS drawer curve on transform/opacity) */
    .slideover-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(9, 13, 22, 0.42);
      opacity: 0;
      pointer-events: none;
      transition: opacity 220ms cubic-bezier(0.32, 0.72, 0, 1);
      z-index: 60;
      display: flex;
      justify-content: flex-end;
    }

    .slideover-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }

    .slideover-panel {
      width: 100%;
      max-width: 460px;
      height: 100%;
      background: var(--bg-elevated);
      border-left: 1px solid var(--border-hairline);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      overflow-y: auto;
      transform: translateX(100%);
      transition: transform 240ms cubic-bezier(0.32, 0.72, 0, 1);
      box-shadow: -16px 0 48px rgba(9, 13, 22, 0.12);
    }

    .slideover-backdrop.open .slideover-panel {
      transform: translateX(0);
    }

    @media (max-width: 1080px) {
      .hero-section, .commerce-workspace {
        grid-template-columns: minmax(0, 1fr);
      }
      .checkout-drawer {
        position: static;
      }
    }

    @media (max-width: 768px) {
      .catalog-grid, .facet-dimension-row {
        grid-template-columns: minmax(0, 1fr);
      }
      .nav-inner {
        padding: 10px 16px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .btn-press, .channel-pill {
        transition: none !important;
      }
    }
  </style>
</head>
<body>
  <header class="top-nav">
    <div class="nav-inner">
      <a href="/" class="brand-mark">
        <span>KRONOS // HARDWARE</span>
      </a>
      <nav class="channel-switcher" aria-label="Channel Switcher">
        ${channelOptionsHtml}
      </nav>
      <div class="nav-links">
        <a href="/checkout?channel=${encodeURIComponent(activeChannel.slug)}" class="btn-secondary btn-press">Full Checkout</a>
        <a href="/orders?channel=${encodeURIComponent(activeChannel.slug)}" class="btn-secondary btn-press">Orders &amp; RMA</a>
        <button type="button" id="btn-open-drawer" class="btn-primary btn-press">
          Cart Drawer (<span id="nav-cart-count">4</span>)
        </button>
        <a href="/admin" class="btn-secondary btn-press">Open Linear Admin</a>
      </div>
    </div>
  </header>

  <main>
    <section class="hero-section">
      <div>
        <div class="hero-eyebrow">CHANNEL-FIRST PRECISION COMMERCE</div>
        <h1 class="hero-headline">Zero-float pricing. Sub-10ms catalog reads.</h1>
        <p class="hero-subtext">
          Every product below reads from a zero-JOIN PostgreSQL 17 CQRS projection and calculates two-pass Hare-Niemeyer discounts in real time.
        </p>
        <div class="hero-ctas">
          <a href="#catalog-section" class="btn-primary btn-press">Browse Hardware</a>
          <a href="/admin" class="btn-secondary btn-press">Inspect Saga Engine</a>
        </div>
      </div>
      <div class="hero-visual">
        <img src="https://picsum.photos/seed/kronos-cnc-workstation/900/600"
             alt="Kronos CNC Anodized Hardware"
             width="900"
             height="600" />
      </div>
    </section>

    <section id="catalog-section" class="commerce-workspace">
      <div>
        <h2 class="section-title">Channel Projections (${activeChannel.name})</h2>
        <p class="section-desc">
          Single-index-scan read model with merged JSONB facets and pre-applied catalogue promotions.
        </p>

        <div class="facet-workbench" aria-label="PostgreSQL 17 GIN jsonb_path_ops Multi-Dimensional Facet Filter">
          <div class="facet-top-bar">
            <div class="facet-telemetry-group">
              <span class="facet-badge mono-meta" id="facet-index-badge">
                PG 17 GIN jsonb_path_ops (@&gt;)
              </span>
              <span class="mono-meta" style="font-size: 0.78rem; font-weight: 600; color: var(--text-primary);" id="facet-match-count">
                Matched ${initialMatchedCount} / ${initialTotalCount} Projections
              </span>
              <span class="mono-meta" style="font-size: 0.75rem; color: var(--accent); font-weight: 700;" id="facet-latency-badge">
                Query Latency: ${initialLatencyUs} us
              </span>
            </div>
            <button type="button" id="btn-reset-facets" class="btn-secondary btn-press" style="padding: 5px 12px; font-size: 0.75rem;">
              Reset All Facets
            </button>
          </div>

          <div class="facet-search-row">
            <input type="text"
                   id="facet-search-input"
                   class="facet-search-input mono-meta"
                   placeholder="Search product name, slug, or SKU (ILIKE + JSONB @>)..." />
            <div class="facet-pill-list">
              <button type="button" class="facet-pill btn-press mono-meta active" data-sort-order="DEFAULT_RANK">Default Rank</button>
              <button type="button" class="facet-pill btn-press mono-meta" data-sort-order="PRICE_ASC">Price: Low -&gt; High</button>
              <button type="button" class="facet-pill btn-press mono-meta" data-sort-order="PRICE_DESC">Price: High -&gt; Low</button>
              <button type="button" class="facet-pill btn-press mono-meta" data-sort-order="STOCK_DESC">Stock: High -&gt; Low</button>
            </div>
          </div>

          <div class="facet-dimension-row">
            <span class="facet-dim-label mono-meta">Price Ceiling &amp; Stock</span>
            <div class="facet-pill-list">
              <button type="button" class="facet-pill btn-press mono-meta active" data-price-cap="0">All Prices</button>
              <button type="button" class="facet-pill btn-press mono-meta" data-price-cap="2500">&lt;= $25</button>
              <button type="button" class="facet-pill btn-press mono-meta" data-price-cap="7500">&lt;= $75</button>
              <button type="button" class="facet-pill btn-press mono-meta" data-price-cap="20000">&lt;= $200</button>
              <button type="button" class="facet-pill btn-press mono-meta" data-price-cap="60000">&lt;= $600</button>
              <button type="button" class="facet-pill btn-press mono-meta active" data-stock-floor="0">All Stock</button>
              <button type="button" class="facet-pill btn-press mono-meta" data-stock-floor="100">&gt;= 100 units</button>
              <button type="button" class="facet-pill btn-press mono-meta" data-stock-floor="500">&gt;= 500 units</button>
            </div>
          </div>

          <div id="facet-groups-container" style="display: flex; flex-direction: column; gap: 10px;">
            ${facetGroupsHtml}
          </div>

          <pre class="facet-sql-box mono-meta" id="facet-sql-preview">${initialSqlPreview}</pre>
        </div>

        <div class="catalog-grid" id="catalog-grid-container">
          ${productCardsHtml}
        </div>
      </div>

      <aside class="checkout-drawer" aria-label="Live Two-Pass Cart and Saga Checkout">
        <div class="drawer-header">
          <div>
            <h2 style="font-size: 1.05rem; font-weight: 700;">Two-Pass Kernel Cart</h2>
            <p class="mono-meta" style="font-size: 0.74rem; color: var(--text-muted);">
              Precedence: Manual &gt; Voucher &gt; Promo
            </p>
          </div>
          <span class="mono-meta" id="cart-currency-badge">${initialCartPricing.currencyCode}</span>
        </div>

        <div id="cart-lines-container">
          ${initialWaterfallLinesHtml}
        </div>

        <div class="discount-controls">
          <div style="font-size: 0.74rem; font-weight: 700; color: var(--text-secondary);">
            TEST DISCOUNT PRECEDENCE &amp; PENNY ALLOCATION
          </div>
          <label>
            <input type="checkbox" id="toggle-order-promo" checked />
            <span>Order Promotion (10% Off Subtotal)</span>
          </label>
          <label>
            <input type="checkbox" id="toggle-order-voucher" checked />
            <span>Order Voucher (-1000 minor units, suppresses Promo)</span>
          </label>
          <label>
            <input type="checkbox" id="toggle-manual-discount" />
            <span>Manual Agent Override (-2500 minor units, wins all)</span>
          </label>
          <div class="voucher-bar">
            <input type="text" id="voucher-code-input" class="voucher-input mono-meta" placeholder="Voucher code (SUPER10 / VIP25 / B2B15)" />
            <button type="button" id="btn-apply-voucher" class="qty-btn">Apply</button>
          </div>
          <div class="voucher-pill-row">
            <button type="button" class="voucher-pill mono-meta" data-voucher-preset="SUPER10">SUPER10 (-$10)</button>
            <button type="button" class="voucher-pill mono-meta" data-voucher-preset="VIP25">VIP25 (-$25)</button>
            <button type="button" class="voucher-pill mono-meta" data-voucher-preset="B2B15">B2B15 (-15%)</button>
          </div>
        </div>

        <div class="waterfall-summary">
          <div class="waterfall-row">
            <span>Applied Order Discount</span>
            <span class="waterfall-num" id="wf-winning-discount">
              ${initialCartPricing.appliedOrderDiscounts[0]?.name ?? "None"}
              (-${formatMoney(initialCartPricing.appliedOrderDiscounts[0]?.totalAmount ?? 0n, initialCartPricing.currencyCode)})
            </span>
          </div>
          <div class="waterfall-row">
            <span>Total Net</span>
            <span class="waterfall-num" id="wf-net">${formatMoney(initialCartPricing.totalNetAmount, initialCartPricing.currencyCode)}</span>
          </div>
          <div class="waterfall-row">
            <span>Total Tax (${activeChannel.taxInclusionMode === "TAX_INCLUSIVE" ? "Extracted VAT" : "Added Tax"})</span>
            <span class="waterfall-num" id="wf-tax">${formatMoney(initialCartPricing.totalTaxAmount, initialCartPricing.currencyCode)}</span>
          </div>
          <div class="waterfall-row total">
            <span>Total Gross</span>
            <span class="waterfall-num" id="wf-gross">${formatMoney(initialCartPricing.totalGrossAmount, initialCartPricing.currencyCode)}</span>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px;">
          <button type="button" id="btn-run-checkout" class="btn-primary btn-press">
            Complete Saga Checkout
          </button>
          <button type="button" id="btn-simulate-decline" class="btn-secondary btn-press">
            Simulate Payment Failure (Test Saga Rollback)
          </button>
        </div>

        <div id="saga-status-box" class="saga-status-box mono-meta" role="status"></div>
      </aside>
    </section>
  </main>

  <div id="slideover-backdrop" class="slideover-backdrop" role="dialog" aria-modal="true" aria-label="Interactive Multi-SKU Cart Drawer">
    <div class="slideover-panel">
      <div class="drawer-header">
        <div>
          <h2 style="font-size: 1.1rem; font-weight: 700;">Interactive Cart &amp; Waterfall Drawer</h2>
          <p class="mono-meta" style="font-size: 0.74rem; color: var(--text-muted);">
            Live Rust Hare-Niemeyer Pro-Rata Attribution
          </p>
        </div>
        <button type="button" id="btn-close-drawer" class="btn-secondary btn-press" style="padding: 6px 12px;">
          Close
        </button>
      </div>
      <div id="drawer-lines-container">
        ${initialWaterfallLinesHtml}
      </div>
      <div class="waterfall-summary" style="margin-top: auto;">
        <div class="waterfall-row">
          <span>Winning Order Discount</span>
          <span class="waterfall-num" id="drawer-winning-discount">
            ${initialCartPricing.appliedOrderDiscounts[0]?.name ?? "None"}
            (-${formatMoney(initialCartPricing.appliedOrderDiscounts[0]?.totalAmount ?? 0n, initialCartPricing.currencyCode)})
          </span>
        </div>
        <div class="waterfall-row">
          <span>Total Net</span>
          <span class="waterfall-num" id="drawer-net">${formatMoney(initialCartPricing.totalNetAmount, initialCartPricing.currencyCode)}</span>
        </div>
        <div class="waterfall-row">
          <span>Total Tax</span>
          <span class="waterfall-num" id="drawer-tax">${formatMoney(initialCartPricing.totalTaxAmount, initialCartPricing.currencyCode)}</span>
        </div>
        <div class="waterfall-row total">
          <span>Total Gross</span>
          <span class="waterfall-num" id="drawer-gross">${formatMoney(initialCartPricing.totalGrossAmount, initialCartPricing.currencyCode)}</span>
        </div>
      </div>
      <button type="button" id="btn-drawer-checkout" class="btn-primary btn-press">
        Complete Saga Checkout Now
      </button>
    </div>
  </div>

  <script type="module">
    const runCheckoutBtn = document.getElementById("btn-run-checkout");
    const drawerCheckoutBtn = document.getElementById("btn-drawer-checkout");
    const simulateDeclineBtn = document.getElementById("btn-simulate-decline");
    const statusBox = document.getElementById("saga-status-box");
    const promoCheckbox = document.getElementById("toggle-order-promo");
    const voucherCheckbox = document.getElementById("toggle-order-voucher");
    const manualCheckbox = document.getElementById("toggle-manual-discount");
    const voucherInput = document.getElementById("voucher-code-input");
    const applyVoucherBtn = document.getElementById("btn-apply-voucher");
    const slideoverBackdrop = document.getElementById("slideover-backdrop");
    const openDrawerBtn = document.getElementById("btn-open-drawer");
    const closeDrawerBtn = document.getElementById("btn-close-drawer");

    const CART_STORAGE_KEY = "kronos_cart_v1";
    const DEFAULT_DEMO_CART = [
      { variantId: "KR-KB75-TI", quantity: 1, baseUnitPrice: 10000, isGift: false },
      { variantId: "KR-DAC-BLK", quantity: 1, baseUnitPrice: 10000, isGift: false },
      { variantId: "KR-MG8K-SLV", quantity: 1, baseUnitPrice: 10000, isGift: false },
      { variantId: "KR-CABLE-GIFT", quantity: 1, baseUnitPrice: 2900, isGift: true },
    ];

    function loadPersistedCart() {
      try {
        const raw = localStorage.getItem(CART_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {
        // ignore storage errors
      }
      return DEFAULT_DEMO_CART.map((x) => ({ ...x }));
    }

    const cartLines = loadPersistedCart();

    function persistCartLines() {
      try {
        localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cartLines));
      } catch {
        // ignore storage errors
      }
    }

    function toggleDrawer(open) {
      slideoverBackdrop?.classList.toggle("open", open);
    }

    openDrawerBtn?.addEventListener("click", () => toggleDrawer(true));
    closeDrawerBtn?.addEventListener("click", () => toggleDrawer(false));
    slideoverBackdrop?.addEventListener("click", (e) => {
      if (e.target === slideoverBackdrop) toggleDrawer(false);
    });

    function renderLinesHtml(lines) {
      return lines
        .map(
          (line) =>
            '<div class="cart-line-row">' +
            '<div>' +
            '<div class="cart-line-title">' +
            line.variantId +
            (line.isGift ? ' <span class="gift-tag">FREE GIFT</span>' : "") +
            "</div>" +
            '<div class="cart-line-sub">' +
            "Qty " +
            line.quantity +
            " x " +
            line.effectiveBaseFormatted +
            (line.linePromoFormatted ? " | Line Promo: -" + line.linePromoFormatted : "") +
            (line.hareNiemeyerSliceFormatted
              ? " | Hare-Niemeyer Slice: -" + line.hareNiemeyerSliceFormatted
              : "") +
            "</div>" +
            (line.isGift
              ? ""
              : '<div class="qty-controls">' +
                '<button type="button" class="qty-btn" data-qty-sku="' +
                line.variantId +
                '" data-qty-delta="-1">-1</button>' +
                '<button type="button" class="qty-btn" data-qty-sku="' +
                line.variantId +
                '" data-qty-delta="1">+1</button>' +
                '<button type="button" class="qty-btn" data-remove-sku="' +
                line.variantId +
                '">Remove</button>' +
                "</div>") +
            "</div>" +
            '<div class="cart-line-total">' +
            line.totalGrossFormatted +
            "</div>" +
            "</div>"
        )
        .join("");
    }

    async function refreshWaterfall() {
      persistCartLines();
      const res = await fetch("/api/demo/recalculate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelSlug: "${activeChannel.slug}",
          includePromo: promoCheckbox.checked,
          includeVoucher: voucherCheckbox.checked,
          includeManual: manualCheckbox.checked,
          voucherCode: voucherInput ? voucherInput.value : "",
          customLines: cartLines,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      document.getElementById("wf-winning-discount").textContent = data.winningDiscountLabel;
      document.getElementById("wf-net").textContent = data.totalNetFormatted;
      document.getElementById("wf-tax").textContent = data.totalTaxFormatted;
      document.getElementById("wf-gross").textContent = data.totalGrossFormatted;

      document.getElementById("drawer-winning-discount").textContent = data.winningDiscountLabel;
      document.getElementById("drawer-net").textContent = data.totalNetFormatted;
      document.getElementById("drawer-tax").textContent = data.totalTaxFormatted;
      document.getElementById("drawer-gross").textContent = data.totalGrossFormatted;

      const totalQty = cartLines.reduce((acc, l) => acc + l.quantity, 0);
      const countEl = document.getElementById("nav-cart-count");
      if (countEl) countEl.textContent = String(totalQty);

      if (Array.isArray(data.lines)) {
        const html = renderLinesHtml(data.lines);
        const mainLinesEl = document.getElementById("cart-lines-container");
        const drawerLinesEl = document.getElementById("drawer-lines-container");
        if (mainLinesEl) mainLinesEl.innerHTML = html;
        if (drawerLinesEl) drawerLinesEl.innerHTML = html;
      }
    }

    const selectedFacets = {};
    let activePriceCap = 0;
    let activeStockFloor = 0;
    let activeSortOrder = "DEFAULT_RANK";
    const facetSearchInput = document.getElementById("facet-search-input");
    const resetFacetsBtn = document.getElementById("btn-reset-facets");

    function renderFacetGroupsHtml(groups) {
      return groups
        .map(
          (grp) =>
            '<div class="facet-dimension-row">' +
            '<span class="facet-dim-label mono-meta">' +
            grp.label +
            "</span>" +
            '<div class="facet-pill-list">' +
            grp.buckets
              .map(
                (b) =>
                  '<button type="button" class="facet-pill btn-press mono-meta ' +
                  (b.selected ? "active" : "") +
                  '" data-facet-dim="' +
                  grp.key +
                  '" data-facet-val="' +
                  b.value +
                  '">' +
                  "<span>" +
                  b.value +
                  "</span>" +
                  '<span class="facet-count">(' +
                  b.count +
                  ")</span>" +
                  "</button>"
              )
              .join("") +
            "</div>" +
            "</div>"
        )
        .join("");
    }

    function renderCatalogCardsHtml(items) {
      if (!items || items.length === 0) {
        return '<div class="mono-meta" style="grid-column: 1 / -1; padding: 36px; text-align: center; color: var(--text-muted); border: 1px dashed var(--border-hairline); border-radius: var(--radius-card);">No projections matched the active JSONB @> facet constraints. Click Reset All Facets to widen your query.</div>';
      }
      return items
        .map((p, idx) => {
          const badges = Object.entries(p.mergedAttributes || {})
            .map(([k, vals]) => {
              const arr = Array.isArray(vals) ? vals : [vals];
              const firstVal = String(arr[0] ?? "");
              return (
                '<button type="button" class="spec-chip btn-press" data-facet-dim="' +
                k +
                '" data-facet-val="' +
                firstVal +
                '">' +
                k +
                ": " +
                arr.join(", ") +
                "</button>"
              );
            })
            .join("");
          const compareHtml = p.compareAtFormatted
            ? '<span class="price-compare">' + p.compareAtFormatted + "</span>"
            : "";
          const seed = "kronos-hw-" + p.productSlug;
          const pdpHref = "/products/" + encodeURIComponent(p.productSlug) + "?channel=${activeChannel.slug}";
          return (
            '<article class="product-tile stagger-item" style="animation-delay: ' +
            idx * 35 +
            'ms" data-product-slug="' +
            p.productSlug +
            '">' +
            '<a href="' +
            pdpHref +
            '" class="product-media" style="display: block;">' +
            '<img src="https://picsum.photos/seed/' +
            seed +
            '/720/540" alt="' +
            p.productName +
            '" width="720" height="540" loading="lazy" />' +
            "</a>" +
            '<div class="product-body">' +
            '<div class="product-header">' +
            "<div>" +
            '<h3 class="product-title"><a href="' +
            pdpHref +
            '" style="color: inherit; text-decoration: none;">' +
            p.productName +
            "</a></h3>" +
            '<p class="product-sku">SKU: ' +
            p.variantSku +
            " / Avail: " +
            p.totalAvailableQty +
            " units</p>" +
            "</div>" +
            '<div class="product-price-block">' +
            compareHtml +
            '<span class="product-price">' +
            p.priceFormatted +
            "</span>" +
            "</div>" +
            "</div>" +
            '<div class="spec-row">' +
            badges +
            "</div>" +
            '<div class="product-actions" style="gap: 8px;">' +
            '<a href="' +
            pdpHref +
            '" class="btn-secondary btn-press" style="padding: 9px 12px; font-size: 0.8rem;">Variants &amp; Stock</a>' +
            '<button type="button" class="btn-primary btn-press" data-add-variant="' +
            p.variantId +
            '" data-add-sku="' +
            p.variantSku +
            '" data-variant-name="' +
            p.productName +
            '" data-base-price="' +
            p.minEffectivePriceCents +
            '">Add to Cart</button>' +
            "</div>" +
            "</div>" +
            "</article>"
          );
        })
        .join("");
    }

    async function runFacetQuery() {
      const res = await fetch("/api/demo/facet-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelSlug: "${activeChannel.slug}",
          selectedFacets,
          maxPriceCents: activePriceCap,
          minAvailableQty: activeStockFloor,
          searchQuery: facetSearchInput ? facetSearchInput.value : "",
          sortBy: activeSortOrder,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const matchEl = document.getElementById("facet-match-count");
      if (matchEl) {
        matchEl.textContent =
          "Matched " + data.matchedCount + " / " + data.totalUnfilteredCount + " Projections";
      }
      const latEl = document.getElementById("facet-latency-badge");
      if (latEl) {
        latEl.textContent = "Query Latency: " + data.queryLatencyUs + " us";
      }
      const sqlEl = document.getElementById("facet-sql-preview");
      if (sqlEl) {
        sqlEl.textContent = data.executedSql;
      }
      const groupsEl = document.getElementById("facet-groups-container");
      if (groupsEl && Array.isArray(data.facetGroups)) {
        groupsEl.innerHTML = renderFacetGroupsHtml(data.facetGroups);
      }
      const gridEl = document.getElementById("catalog-grid-container");
      if (gridEl && Array.isArray(data.items)) {
        gridEl.innerHTML = renderCatalogCardsHtml(data.items);
      }
    }

    document.addEventListener("click", (e) => {
      const target = e.target.closest("button");
      if (!target) return;

      const facetDim = target.getAttribute("data-facet-dim");
      const facetVal = target.getAttribute("data-facet-val");
      if (facetDim && facetVal) {
        const list = selectedFacets[facetDim] || [];
        const idx = list.indexOf(facetVal);
        if (idx >= 0) {
          list.splice(idx, 1);
        } else {
          list.push(facetVal);
        }
        selectedFacets[facetDim] = list;
        runFacetQuery();
        return;
      }

      const priceCapAttr = target.getAttribute("data-price-cap");
      if (priceCapAttr !== null) {
        activePriceCap = Number(priceCapAttr) || 0;
        document.querySelectorAll("[data-price-cap]").forEach((btn) => {
          btn.classList.toggle(
            "active",
            btn.getAttribute("data-price-cap") === priceCapAttr
          );
        });
        runFacetQuery();
        return;
      }

      const stockFloorAttr = target.getAttribute("data-stock-floor");
      if (stockFloorAttr !== null) {
        activeStockFloor = Number(stockFloorAttr) || 0;
        document.querySelectorAll("[data-stock-floor]").forEach((btn) => {
          btn.classList.toggle(
            "active",
            btn.getAttribute("data-stock-floor") === stockFloorAttr
          );
        });
        runFacetQuery();
        return;
      }

      const sortOrderAttr = target.getAttribute("data-sort-order");
      if (sortOrderAttr) {
        activeSortOrder = sortOrderAttr;
        document.querySelectorAll("[data-sort-order]").forEach((btn) => {
          btn.classList.toggle(
            "active",
            btn.getAttribute("data-sort-order") === sortOrderAttr
          );
        });
        runFacetQuery();
        return;
      }

      const addSku = target.getAttribute("data-add-sku");
      if (addSku) {
        const basePrice = Number(target.getAttribute("data-base-price") || "10000");
        const existing = cartLines.find((l) => l.variantId === addSku && !l.isGift);
        if (existing) {
          existing.quantity += 1;
        } else {
          const giftIdx = cartLines.findIndex((l) => l.isGift);
          const item = { variantId: addSku, quantity: 1, baseUnitPrice: basePrice, isGift: false };
          if (giftIdx >= 0) {
            cartLines.splice(giftIdx, 0, item);
          } else {
            cartLines.push(item);
          }
        }
        refreshWaterfall();
        toggleDrawer(true);
        return;
      }

      const qtySku = target.getAttribute("data-qty-sku");
      if (qtySku) {
        const delta = Number(target.getAttribute("data-qty-delta") || "0");
        const item = cartLines.find((l) => l.variantId === qtySku && !l.isGift);
        if (item) {
          item.quantity = Math.max(1, item.quantity + delta);
          refreshWaterfall();
        }
        return;
      }

      const removeSku = target.getAttribute("data-remove-sku");
      if (removeSku) {
        const nonGiftCount = cartLines.filter((l) => !l.isGift).length;
        if (nonGiftCount > 1) {
          const idx = cartLines.findIndex((l) => l.variantId === removeSku && !l.isGift);
          if (idx >= 0) {
            cartLines.splice(idx, 1);
            refreshWaterfall();
          }
        }
        return;
      }

      const preset = target.getAttribute("data-voucher-preset");
      if (preset && voucherInput) {
        voucherInput.value = preset;
        voucherCheckbox.checked = true;
        refreshWaterfall();
      }
    });

    promoCheckbox?.addEventListener("change", refreshWaterfall);
    voucherCheckbox?.addEventListener("change", refreshWaterfall);
    manualCheckbox?.addEventListener("change", refreshWaterfall);
    applyVoucherBtn?.addEventListener("click", refreshWaterfall);
    facetSearchInput?.addEventListener("input", () => {
      runFacetQuery();
    });
    resetFacetsBtn?.addEventListener("click", () => {
      for (const k of Object.keys(selectedFacets)) {
        delete selectedFacets[k];
      }
      activePriceCap = 0;
      activeStockFloor = 0;
      activeSortOrder = "DEFAULT_RANK";
      if (facetSearchInput) facetSearchInput.value = "";
      document.querySelectorAll("[data-price-cap]").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-price-cap") === "0");
      });
      document.querySelectorAll("[data-stock-floor]").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-stock-floor") === "0");
      });
      document.querySelectorAll("[data-sort-order]").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-sort-order") === "DEFAULT_RANK");
      });
      runFacetQuery();
    });

    async function triggerCheckout(shouldFailPayment) {
      toggleDrawer(false);
      statusBox.classList.add("visible");
      statusBox.textContent = "Running 5-Step Durable Saga Workflow...";
      const res = await fetch("/api/demo/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelSlug: "${activeChannel.slug}",
          shouldFailPayment,
          includePromo: promoCheckbox.checked,
          includeVoucher: voucherCheckbox.checked,
          includeManual: manualCheckbox.checked,
          voucherCode: voucherInput ? voucherInput.value : "",
          customLines: cartLines,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        statusBox.textContent =
          "CHECKOUT BLOCKED (HTTP " + res.status + "): " + (data.error || "Unknown error");
        return;
      }
      if (data.status === "COMPLETED") {
        statusBox.innerHTML =
          "<div>SAGA COMPLETED: Order " +
          data.orderId +
          " | Shipments: " +
          data.shipmentCount +
          " (" +
          data.warehouseId +
          ") | Outbox Queued: " +
          data.outboxPendingCount +
          "</div>" +
          '<div style="margin-top: 6px;"><a href="/orders/' +
          encodeURIComponent(data.orderId) +
          '?channel=${activeChannel.slug}" style="color: var(--accent); font-weight: 700;">View Order &amp; Self-Service RMA -&gt;</a></div>';
      } else {
        statusBox.textContent =
          "SAGA COMPENSATED (LIFO Rollback): " + (data.compensatedSteps || []).join(" -> ") +
          " | MSI Stock & Store Credit Restored!";
      }
    }

    runCheckoutBtn?.addEventListener("click", () => triggerCheckout(false));
    drawerCheckoutBtn?.addEventListener("click", () => triggerCheckout(false));
    simulateDeclineBtn?.addEventListener("click", () => triggerCheckout(true));
    refreshWaterfall();
  </script>
</body>
</html>`;
}
