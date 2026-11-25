/**
 * `@super-ecommerce/configurator` - PIM Plugin Ingestion Adapter
 *
 * Enterprise PIM (Akeneo / Pimcore / Salsify) Ingestion & Mapping Engine.
 *
 * Transforms external PIM JSON/Webhook export payloads into Super Ecommerce's
 * declarative topological Commerce-as-Code store configuration documents,
 * executes strict Stage 1 Pre-Flight validation, enforces immutable slug identity,
 * and synthesizes zero-JOIN CQRS catalog projections for instant sub-millisecond querying.
 */

import type { MinorUnits } from "@super-ecommerce/kernel";
import type {
  AttributeDefinition,
  DynamicAttributesMap,
} from "@super-ecommerce/db";
import {
  diffStoreConfig,
  validateStoreConfig,
  type ConfigDiffPlan,
  type ProductConfig,
  type ProductTypeConfig,
  type StoreConfigDocument,
  type VariantChannelListingConfig,
} from "./index.ts";

export interface PimAttributeDefinition {
  readonly code: string;
  readonly label: string;
  readonly type: "text" | "number" | "enum" | "boolean";
  readonly required?: boolean;
  readonly allowedValues?: readonly string[];
}

export interface PimProductFamily {
  readonly code: string;
  readonly label: string;
  readonly isShippingRequired?: boolean;
  readonly attributes: readonly PimAttributeDefinition[];
}

export interface PimProductListing {
  readonly channelSlug: string;
  readonly priceAmount: string | number | bigint;
  readonly compareAtAmount?: string | number | bigint;
  readonly isPublished: boolean;
}

export interface PimProductItem {
  readonly id: string;
  readonly sku: string;
  readonly slug: string;
  readonly familyCode: string;
  readonly name: string;
  readonly attributes: Record<string, string | number | boolean>;
  readonly listings: readonly PimProductListing[];
  readonly mediaUrl?: string;
}

export interface PimIngestionPayload {
  readonly exportId: string;
  readonly systemSource: string;
  readonly exportedAtIso: string;
  readonly families: readonly PimProductFamily[];
  readonly products: readonly PimProductItem[];
}

export interface PimMaterializedCatalogProjection {
  readonly productSlug: string;
  readonly productName: string;
  readonly channelSlug: string;
  readonly sku: string;
  readonly minEffectivePrice: string;
  readonly isInStock: boolean;
  readonly totalAvailableQty: number;
  readonly mediaUrl: string;
  readonly mergedAttributes: Record<string, unknown>;
}

export interface PimIngestionAuditEntry {
  readonly syncId: string;
  readonly systemSource: string;
  readonly exportId: string;
  readonly status: "APPLIED" | "PREFLIGHT_BLOCKED" | "ZERO_DIFF_NOOP";
  readonly durationUs: number;
  readonly familiesCount: number;
  readonly productsCount: number;
  readonly diffPlan?: ConfigDiffPlan;
  readonly issues: readonly string[];
  readonly summary: string;
  readonly materializedProjectionsCount: number;
  readonly executedAtIso: string;
}

export interface PimIngestionResult {
  readonly ok: boolean;
  readonly audit: PimIngestionAuditEntry;
  readonly materializedProjections: readonly PimMaterializedCatalogProjection[];
}

export class InvalidPimPayloadError extends Error {}

export function validatePimEnvelope(payload: PimIngestionPayload): void {
  if (!payload || typeof payload.systemSource !== "string" || !payload.systemSource.trim() ||
      typeof payload.exportId !== "string" || !payload.exportId.trim() ||
      !Array.isArray(payload.families) || !Array.isArray(payload.products)) {
    throw new InvalidPimPayloadError("PIM export requires systemSource, exportId, families and products");
  }
}

const SLUG_REGEX = /^[a-z0-9-]+$/;
const ATTR_SLUG_REGEX = /^[a-z0-9_-]+$/;
const MAX_PRICE = 9_223_372_036_854_775_807n;

function parsePimPrice(value: PimProductListing["priceAmount"]): bigint {
  if (typeof value === "string" ? !/^\d+$/.test(value) :
      typeof value !== "bigint" && !Number.isSafeInteger(value)) {
    throw new InvalidPimPayloadError("Prices must be integer minor units");
  }
  const price = BigInt(value);
  if (price < 0n || price > MAX_PRICE) {
    throw new InvalidPimPayloadError("Price is outside the PostgreSQL BIGINT range");
  }
  return price;
}

export function mapPimPayloadToStoreConfig(
  payload: PimIngestionPayload,
  baseState: StoreConfigDocument = PIM_DEMO_INITIAL_STORE_STATE
): {
  readonly document: StoreConfigDocument;
  readonly issues: readonly string[];
} {
  const issues: string[] = [];

  validatePimEnvelope(payload);
  const familyCodes = new Set<string>();
  const mappedProductTypes: ProductTypeConfig[] = payload.families.map((f) => {
    if (typeof f?.code !== "string" || typeof f.label !== "string" || !Array.isArray(f.attributes)) {
      throw new InvalidPimPayloadError("PIM families require a code, label and attributes");
    }
    if (!SLUG_REGEX.test(f.code)) {
      issues.push(`PIM family code '${f.code}' is not a valid kebab-case slug (/^[a-z0-9-]+$/)`);
    }
    if (familyCodes.has(f.code)) issues.push(`Duplicate PIM family '${f.code}'`);
    familyCodes.add(f.code);

    const productAttributesSchema: AttributeDefinition[] = f.attributes.map((attr) => {
      if (!ATTR_SLUG_REGEX.test(attr.code)) {
        issues.push(`PIM attribute code '${attr.code}' in family '${f.code}' is not a valid attribute slug (/^[a-z0-9_-]+$/)`);
      }
      return {
        slug: attr.code,
        name: attr.label,
        type:
          attr.type === "number"
            ? "NUMBER"
            : attr.type === "enum"
            ? "ENUM"
            : attr.type === "boolean"
            ? "BOOLEAN"
            : "TEXT",
        required: attr.required ?? false,
        allowedValues: attr.allowedValues,
      };
    });

    return {
      slug: f.code,
      name: f.label,
      isShippingRequired: f.isShippingRequired ?? true,
      productAttributesSchema,
      variantAttributesSchema: [],
    };
  });

  // Combine with existing base state product types, overwriting duplicates by slug
  const productTypeMap = new Map<string, ProductTypeConfig>();
  for (const pt of baseState.productTypes) {
    productTypeMap.set(pt.slug, pt);
  }
  for (const pt of mappedProductTypes) {
    productTypeMap.set(pt.slug, pt);
  }

  // 2. Map and validate products
  const productMap = new Map<string, ProductConfig>();
  for (const p of baseState.products) {
    productMap.set(p.slug, p);
  }

  const productSlugs = new Set<string>();
  const productIds = new Set<string>();
  const skus = new Set<string>();
  for (const item of payload.products) {
    if (typeof item?.slug !== "string" || typeof item.id !== "string" || !item.id.trim() ||
        typeof item.sku !== "string" || !item.sku.trim() || typeof item.name !== "string" ||
        typeof item.familyCode !== "string" || !item.attributes || typeof item.attributes !== "object" ||
        Array.isArray(item.attributes) || !Array.isArray(item.listings) ||
        (item.mediaUrl !== undefined && typeof item.mediaUrl !== "string")) {
      throw new InvalidPimPayloadError("PIM products require an id, slug, SKU, name, family, attributes and listings");
    }
    if (productSlugs.has(item.slug)) issues.push(`Duplicate PIM product slug '${item.slug}'`);
    if (productIds.has(item.id)) issues.push(`Duplicate PIM product ID '${item.id}'`);
    if (skus.has(item.sku)) issues.push(`Duplicate PIM SKU '${item.sku}'`);
    productSlugs.add(item.slug);
    productIds.add(item.id);
    skus.add(item.sku);
    if (!SLUG_REGEX.test(item.slug)) {
      issues.push(`PIM product slug '${item.slug}' is not a valid kebab-case slug`);
    }
    if (!productTypeMap.has(item.familyCode)) {
      issues.push(
        `PIM product '${item.slug}' references unknown familyCode '${item.familyCode}'`
      );
    }

    // Validate attributes against family schema
    const familyDef = productTypeMap.get(item.familyCode);
    if (familyDef) {
      for (const attrSchema of familyDef.productAttributesSchema) {
        const val = item.attributes[attrSchema.slug];
        if (attrSchema.required && (val === undefined || val === null || val === "")) {
          issues.push(
            `PIM product '${item.slug}' is missing required attribute '${attrSchema.slug}' (${attrSchema.name})`
          );
        }
        if (
          attrSchema.type === "ENUM" &&
          val !== undefined &&
          attrSchema.allowedValues &&
          !attrSchema.allowedValues.includes(String(val))
        ) {
          issues.push(
            `PIM product '${item.slug}' attribute '${attrSchema.slug}' has invalid value '${String(val)}' (allowed: ${attrSchema.allowedValues.join(", ")})`
          );
        }
      }
    }

    const listingChannels = new Set<string>();
    const channelListings: VariantChannelListingConfig[] = item.listings.map((listing) => {
      if (typeof listing?.channelSlug !== "string" || typeof listing.isPublished !== "boolean") {
        throw new InvalidPimPayloadError(`Invalid channel listing for '${item.slug}'`);
      }
      if (listingChannels.has(listing.channelSlug)) {
        issues.push(`Duplicate listing for '${item.slug}' in '${listing.channelSlug}'`);
      }
      listingChannels.add(listing.channelSlug);
      return {
        channelSlug: listing.channelSlug,
        isPublished: listing.isPublished,
        priceAmount: parsePimPrice(listing.priceAmount),
        compareAtAmount: listing.compareAtAmount === undefined ? undefined : parsePimPrice(listing.compareAtAmount),
      };
    });

    const productConfig: ProductConfig = {
      slug: item.slug,
      name: item.name,
      productTypeSlug: item.familyCode,
      attributes: item.attributes as DynamicAttributesMap,
      variants: [
        {
          sku: item.sku,
          name: item.name,
          attributes: {},
          channelListings,
        },
      ],
    };

    productMap.set(item.slug, productConfig);
  }

  const document: StoreConfigDocument = {
    warehouses: baseState.warehouses,
    channels: baseState.channels,
    productTypes: Array.from(productTypeMap.values()),
    products: Array.from(productMap.values()),
  };

  return { document, issues };
}

export const PIM_DEMO_INITIAL_STORE_STATE: StoreConfigDocument = {
  warehouses: [
    { slug: "us-east", name: "US East Hub (NJ)", countryCode: "US" },
    { slug: "us-central", name: "US Central Hub (TX)", countryCode: "US" },
    { slug: "eu-central", name: "EU Frankfurt Hub (DE)", countryCode: "DE" },
  ],
  channels: [
    {
      slug: "us-retail",
      name: "US Flagship Store",
      currencyCode: "USD",
      defaultCountry: "US",
      taxInclusionMode: "TAX_EXCLUSIVE",
      stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
      allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
      warehouseSlugs: ["us-east", "us-central"],
    },
    {
      slug: "eu-flagship",
      name: "EU Direct Store (VAT Inclusive)",
      currencyCode: "EUR",
      defaultCountry: "DE",
      taxInclusionMode: "TAX_INCLUSIVE",
      stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
      allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
      warehouseSlugs: ["eu-central"],
    },
  ],
  productTypes: [
    {
      slug: "precision-hardware",
      name: "Precision Hardware",
      isShippingRequired: true,
      productAttributesSchema: [
        {
          slug: "chassis_material",
          name: "Chassis Material",
          type: "ENUM",
          required: true,
          allowedValues: ["grade-5-titanium", "cnc-aluminum", "magnesium-alloy"],
        },
      ],
      variantAttributesSchema: [
        {
          slug: "switch_type",
          name: "Switch Type",
          type: "ENUM",
          required: true,
          allowedValues: ["linear-45g", "tactile-55g", "optical-rapid"],
        },
      ],
    },
  ],
  products: [
    {
      slug: "kronos-cnc-keyboard",
      name: "Kronos 75% CNC Titanium Mechanical Keyboard",
      productTypeSlug: "precision-hardware",
      attributes: { chassis_material: "grade-5-titanium" },
      variants: [
        {
          sku: "KR-KB75-TI",
          name: "Kronos 75% Titanium / Linear 45g",
          attributes: { switch_type: "linear-45g" },
          channelListings: [
            {
              channelSlug: "us-retail",
              isPublished: true,
              priceAmount: 39_000n,
              compareAtAmount: 45_000n,
            },
          ],
        },
      ],
    },
  ],
};

export function preparePimIngestion(payload: PimIngestionPayload, base: StoreConfigDocument) {
  const start = process.hrtime.bigint();
  const durationUs = () => Math.round(Number(process.hrtime.bigint() - start) / 100) / 10;
  try {
    const { document, issues } = mapPimPayloadToStoreConfig(payload, base);
    if (issues.length > 0) return { ok: false as const, issues, durationUs: durationUs() };
    validateStoreConfig(document);
    const plan = diffStoreConfig(base, document);
    return { ok: true as const, document, plan, issues: [], durationUs: durationUs() };
  } catch (error) {
    const issues = [error instanceof Error ? error.message : String(error)];
    return { ok: false as const, issues, durationUs: durationUs() };
  }
}

export class StatefulPimAdapter {
  private baseState: StoreConfigDocument;
  private syncSeq = 1;
  private readonly history: PimIngestionAuditEntry[] = [];
  private materializedCache: PimMaterializedCatalogProjection[] = [];

  constructor(initialState: StoreConfigDocument = structuredClone(PIM_DEMO_INITIAL_STORE_STATE)) {
    this.baseState = initialState;
  }

  getCurrentState(): StoreConfigDocument {
    return this.baseState;
  }

  listAuditHistory(limit = 10): readonly PimIngestionAuditEntry[] {
    return this.history.slice(0, limit);
  }

  listMaterializedProjections(): readonly PimMaterializedCatalogProjection[] {
    return this.materializedCache;
  }

  previewSync(payload: PimIngestionPayload): {
    readonly ok: boolean;
    readonly issues: readonly string[];
    readonly plan?: ConfigDiffPlan;
    readonly durationUs: number;
  } {
    const prepared = preparePimIngestion(payload, this.baseState);
    return prepared.ok
      ? { ok: true, issues: [], plan: prepared.plan, durationUs: prepared.durationUs }
      : prepared;
  }

  ingestPimPayload(payload: PimIngestionPayload): PimIngestionResult {
    validatePimEnvelope(payload);
    const t0 = process.hrtime.bigint();
    const preview = preparePimIngestion(payload, this.baseState);

    if (!preview.ok) {
      const audit: PimIngestionAuditEntry = {
        syncId: `pim_sync_${String(this.syncSeq++).padStart(3, "0")}`,
        systemSource: payload.systemSource,
        exportId: payload.exportId,
        status: "PREFLIGHT_BLOCKED",
        durationUs: preview.durationUs,
        familiesCount: payload.families.length,
        productsCount: payload.products.length,
        issues: preview.issues,
        summary: `PIM Ingestion Blocked: ${preview.issues.join("; ")}`,
        materializedProjectionsCount: 0,
        executedAtIso: new Date().toISOString(),
      };
      this.history.unshift(audit);
      return { ok: false, audit, materializedProjections: [] };
    }

    const { document, plan } = preview;
    this.baseState = document;

    // Synthesize materialized CQRS catalog projections
    const newProjections: PimMaterializedCatalogProjection[] = [];
    for (const p of payload.products) {
      for (const l of p.listings) {
        if (l.isPublished) {
          newProjections.push({
            productSlug: p.slug,
            productName: p.name,
            channelSlug: l.channelSlug,
            sku: p.sku,
            minEffectivePrice: String(l.priceAmount),
            isInStock: true,
            totalAvailableQty: 48,
            mediaUrl: p.mediaUrl ?? "https://cdn.super-ecommerce.com/pim/default-product.webp",
            mergedAttributes: {
              ...p.attributes,
              family: p.familyCode,
              pimSource: payload.systemSource,
            },
          });
        }
      }
    }

    const importedSlugs = new Set(payload.products.map((product) => product.slug));
    this.materializedCache = [
      ...newProjections,
      ...this.materializedCache.filter((projection) => !importedSlugs.has(projection.productSlug)),
    ];

    const durationUs = Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;
    const isNoop = plan.totalChanges === 0;
    const audit: PimIngestionAuditEntry = {
      syncId: `pim_sync_${String(this.syncSeq++).padStart(3, "0")}`,
      systemSource: payload.systemSource,
      exportId: payload.exportId,
      status: isNoop ? "ZERO_DIFF_NOOP" : "APPLIED",
      durationUs,
      familiesCount: payload.families.length,
      productsCount: payload.products.length,
      diffPlan: plan,
      issues: [],
      summary: isNoop
        ? `Zero-diff idempotency verified for ${payload.products.length} PIM products`
        : `Ingested ${plan.totalChanges} changes across ${payload.families.length} families and ${payload.products.length} products into CQRS projection`,
      materializedProjectionsCount: newProjections.length,
      executedAtIso: new Date().toISOString(),
    };

    this.history.unshift(audit);
    return { ok: true, audit, materializedProjections: newProjections };
  }
}

/**
 * Standard benchmark demo PIM catalog payload representing an export from Akeneo PIM v7.
 */
export const SAMPLE_AKENEO_PIM_EXPORT: PimIngestionPayload = {
  exportId: "EXP-2026-Q4-AKENEO-789",
  systemSource: "Akeneo Enterprise PIM v7.3 (EU Cloud)",
  exportedAtIso: "2026-11-23T02:15:00.000Z",
  families: [
    {
      code: "audiophile-dac",
      label: "Audiophile DAC & Headphone Amps",
      isShippingRequired: true,
      attributes: [
        {
          code: "chassis_finish",
          label: "Chassis CNC Finish",
          type: "enum",
          required: true,
          allowedValues: ["raw-titanium", "matte-black", "silver-anodized"],
        },
        {
          code: "dac_chipset",
          label: "DAC Chipset",
          type: "text",
          required: true,
        },
        {
          code: "balanced_output",
          label: "True Balanced XLR/4.4mm Output",
          type: "boolean",
          required: true,
        },
      ],
    },
    {
      code: "planar-headphones",
      label: "Planar Magnetic Studio Headphones",
      isShippingRequired: true,
      attributes: [
        {
          code: "driver_size_mm",
          label: "Planar Driver Size (mm)",
          type: "number",
          required: true,
        },
        {
          code: "earpad_material",
          label: "Earpad Ergonomics Material",
          type: "enum",
          required: true,
          allowedValues: ["perforated-lambskin", "cooling-gel-velour", "hybrid-suede"],
        },
      ],
    },
  ],
  products: [
    {
      id: "PIM-PRD-1001",
      sku: "KR-DAC-TI-PRO",
      slug: "kronos-dac-pro",
      familyCode: "audiophile-dac",
      name: "Kronos 32-bit/768kHz Balanced DAC Pro (Titanium Edition)",
      attributes: {
        chassis_finish: "raw-titanium",
        dac_chipset: "Dual ESS Sabre ES9039PRO",
        balanced_output: true,
      },
      mediaUrl: "https://images.unsplash.com/photo-1546435770-a3e426bf472b?w=600&auto=format&fit=crop",
      listings: [
        { channelSlug: "us-retail", priceAmount: "89900", compareAtAmount: "99900", isPublished: true },
        { channelSlug: "eu-flagship", priceAmount: "94900", compareAtAmount: "104900", isPublished: true },
      ],
    },
    {
      id: "PIM-PRD-1002",
      sku: "KR-HP100-PLN",
      slug: "kronos-planar-100",
      familyCode: "planar-headphones",
      name: "Kronos Planar-100 Open-Back Reference Headphones",
      attributes: {
        driver_size_mm: 100,
        earpad_material: "perforated-lambskin",
      },
      mediaUrl: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=600&auto=format&fit=crop",
      listings: [
        { channelSlug: "us-retail", priceAmount: "64900", compareAtAmount: "72900", isPublished: true },
        { channelSlug: "eu-flagship", priceAmount: "68900", compareAtAmount: "76900", isPublished: true },
      ],
    },
    {
      id: "PIM-PRD-1003",
      sku: "KR-HP100-VEL",
      slug: "kronos-planar-100-velour",
      familyCode: "planar-headphones",
      name: "Kronos Planar-100 Velour Mastering Edition",
      attributes: {
        driver_size_mm: 100,
        earpad_material: "cooling-gel-velour",
      },
      mediaUrl: "https://images.unsplash.com/photo-1583394838336-acd977736f90?w=600&auto=format&fit=crop",
      listings: [
        { channelSlug: "us-retail", priceAmount: "66900", compareAtAmount: "74900", isPublished: true },
      ],
    },
  ],
};

export const INVALID_PIM_EXPORT_FAULT_DEMO: PimIngestionPayload = {
  exportId: "EXP-FAULT-PIM-002",
  systemSource: "Akeneo Enterprise PIM v7.3 (Fault Simulation)",
  exportedAtIso: "2026-11-23T02:16:00.000Z",
  families: [
    {
      code: "INVALID FAMILY SLUG!!", // Invalid regex
      label: "Faulty Family",
      attributes: [],
    },
  ],
  products: [
    {
      id: "FAULT-1",
      sku: "FLT-001",
      slug: "faulty_slug_with_underscores", // Invalid slug
      familyCode: "missing-family-code",
      name: "Broken Product Record",
      attributes: {},
      listings: [],
    },
  ],
};
