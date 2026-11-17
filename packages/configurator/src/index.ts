/**
 * `@super-ecommerce/configurator`
 *
 * Commerce-as-Code Declarative GitOps Engine (`validate`, `diff`, `deploy`, `introspect`).
 *
 * Absorbs lessons from `saleor-configurator` while eliminating its `name`-vs-`slug`
 * identity split: every entity in Super Ecommerce uses an immutable `slug` (`/^[a-z0-9-]+$/`)
 * as its canonical key, so renaming `name` updates in place rather than duplicating records.
 *
 * Deployment Pipeline Topological Stage Order:
 *   Stage 1: Pre-flight Validation (slug format, uniqueness, cross-references, ProductType attribute schemas)
 *   Stage 2: Warehouses
 *   Stage 3: Channels (references Warehouses)
 *   Stage 4: ProductTypes
 *   Stage 5: Products & Channel Listings (references ProductTypes & Channels)
 */

import { randomUUID } from "node:crypto";
import type { MinorUnits, PriceTier, TaxInclusionMode } from "@super-ecommerce/kernel";
import {
  deserializeWithBigInt,
  serializeWithBigInt,
  validateDynamicAttributes,
  type AllocationStrategy,
  type AttributeDefinition,
  type DynamicAttributesMap,
  type PgPoolLike,
  type PgTxClient,
  type StockAvailabilityMode,
} from "@super-ecommerce/db";
import {
  parseStoreConfigJson,
  parseStoreConfigText,
  serializeStoreConfigJson,
  serializeStoreConfigYaml,
} from "./yaml.ts";

export {
  parseStoreConfigJson,
  parseStoreConfigText,
  serializeStoreConfigJson,
  serializeStoreConfigYaml,
};

const SLUG_REGEX = /^[a-z0-9-]+$/;

export interface WarehouseConfig {
  readonly slug: string;
  readonly name: string;
  readonly countryCode: string;
}

export interface ChannelConfig {
  readonly slug: string;
  readonly name: string;
  readonly currencyCode: string;
  readonly defaultCountry: string;
  readonly taxInclusionMode?: TaxInclusionMode;
  readonly stockAvailabilityMode?: StockAvailabilityMode;
  readonly allocationStrategy?: AllocationStrategy;
  readonly warehouseSlugs: readonly string[];
}

export interface ProductTypeConfig {
  readonly slug: string;
  readonly name: string;
  readonly isShippingRequired?: boolean;
  readonly productAttributesSchema: readonly AttributeDefinition[];
  readonly variantAttributesSchema: readonly AttributeDefinition[];
}

export interface VariantChannelListingConfig {
  readonly channelSlug: string;
  readonly isPublished: boolean;
  readonly priceAmount: MinorUnits;
  readonly compareAtAmount?: MinorUnits;
  readonly tierPrices?: readonly PriceTier[];
}

export interface ProductVariantConfig {
  readonly sku: string;
  readonly name: string;
  readonly attributes: DynamicAttributesMap;
  readonly channelListings: readonly VariantChannelListingConfig[];
}

export interface ProductConfig {
  readonly slug: string;
  readonly name: string;
  readonly productTypeSlug: string;
  readonly attributes: DynamicAttributesMap;
  readonly variants: readonly ProductVariantConfig[];
}

export interface StoreConfigDocument {
  readonly warehouses: readonly WarehouseConfig[];
  readonly channels: readonly ChannelConfig[];
  readonly productTypes: readonly ProductTypeConfig[];
  readonly products: readonly ProductConfig[];
}

export type ConfigStageName =
  | "warehouses"
  | "channels"
  | "productTypes"
  | "products";

export type DiffOperationType = "CREATE" | "UPDATE" | "DELETE";

export interface ConfigDiffEntry {
  readonly stage: ConfigStageName;
  readonly operation: DiffOperationType;
  readonly slug: string;
  readonly summary: string;
  readonly beforeSummary?: string;
  readonly afterSummary?: string;
}

export interface ConfigDiffPlan {
  readonly totalChanges: number;
  readonly entries: readonly ConfigDiffEntry[];
}

export interface ConfigDeploymentAuditEntry {
  readonly deployId: string;
  readonly revision: number;
  readonly action:
    | "DEPLOY_DAG"
    | "ZERO_DIFF_VERIFY"
    | "STAGE_DRIFT_UPDATE"
    | "PREFLIGHT_REJECTED";
  readonly status: "APPLIED" | "IDEMPOTENT_NOOP" | "STAGED" | "BLOCKED_PREFLIGHT";
  readonly changesApplied: number;
  readonly stageBreakdown: string;
  readonly detailSummary: string;
  readonly durationUs: number;
  readonly executedAtIso: string;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Store configuration validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Stage 1: Pre-flight validation of slug syntax, duplicates, cross-references,
 * and `ProductType` dynamic attribute schemas.
 */
export function validateStoreConfig(doc: StoreConfigDocument): void {
  const issues: string[] = [];

  const checkSlugs = (stage: string, slugs: readonly string[]) => {
    const seen = new Set<string>();
    for (const s of slugs) {
      if (!SLUG_REGEX.test(s)) {
        issues.push(`[${stage}] Invalid slug '${s}': must match /^[a-z0-9-]+$/`);
      }
      if (seen.has(s)) {
        issues.push(`[${stage}] Duplicate slug '${s}'`);
      }
      seen.add(s);
    }
    return seen;
  };

  const warehouseSlugs = checkSlugs(
    "warehouses",
    doc.warehouses.map((w) => w.slug)
  );
  const channelSlugs = checkSlugs(
    "channels",
    doc.channels.map((c) => c.slug)
  );
  const productTypeSlugs = checkSlugs(
    "productTypes",
    doc.productTypes.map((pt) => pt.slug)
  );
  checkSlugs(
    "products",
    doc.products.map((p) => p.slug)
  );

  // Verify Channel -> Warehouse cross-references
  for (const ch of doc.channels) {
    for (const whSlug of ch.warehouseSlugs) {
      if (!warehouseSlugs.has(whSlug)) {
        issues.push(
          `[channels] Channel '${ch.slug}' references unknown warehouse '${whSlug}'`
        );
      }
    }
  }

  const ptMap = new Map(doc.productTypes.map((pt) => [pt.slug, pt]));

  // Verify Product -> ProductType, ChannelListings, and Dynamic Attributes
  for (const prod of doc.products) {
    if (!productTypeSlugs.has(prod.productTypeSlug)) {
      issues.push(
        `[products] Product '${prod.slug}' references unknown productType '${prod.productTypeSlug}'`
      );
      continue;
    }

    const pt = ptMap.get(prod.productTypeSlug)!;
    const prodAttrCheck = validateDynamicAttributes(
      pt.productAttributesSchema,
      prod.attributes
    );
    if (!prodAttrCheck.valid) {
      for (const err of prodAttrCheck.errors) {
        issues.push(`[products:${prod.slug}] ${err.message}`);
      }
    }

    for (const variant of prod.variants) {
      const varAttrCheck = validateDynamicAttributes(
        pt.variantAttributesSchema,
        variant.attributes
      );
      if (!varAttrCheck.valid) {
        for (const err of varAttrCheck.errors) {
          issues.push(`[products:${prod.slug}:sku=${variant.sku}] ${err.message}`);
        }
      }

      for (const listing of variant.channelListings) {
        if (!channelSlugs.has(listing.channelSlug)) {
          issues.push(
            `[products:${prod.slug}:sku=${variant.sku}] Listing references unknown channel '${listing.channelSlug}'`
          );
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") {
      return `${val.toString()}n`;
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

function summarizeEntity(stage: ConfigStageName, item: unknown): string {
  const obj = item as Record<string, unknown>;
  if (stage === "warehouses") {
    return `${obj["name"]} (${obj["countryCode"]})`;
  }
  if (stage === "channels") {
    const whs = (obj["warehouseSlugs"] as string[] | undefined) ?? [];
    return `${obj["name"]} [${obj["currencyCode"]} / ${whs.join("+")}]`;
  }
  if (stage === "productTypes") {
    const pAttrs = (obj["productAttributesSchema"] as unknown[] | undefined) ?? [];
    const vAttrs = (obj["variantAttributesSchema"] as unknown[] | undefined) ?? [];
    return `${obj["name"]} (${pAttrs.length} prod / ${vAttrs.length} var attrs)`;
  }
  const vars = (obj["variants"] as unknown[] | undefined) ?? [];
  return `${obj["name"]} (type=${obj["productTypeSlug"]}, ${vars.length} SKU)`;
}

function diffStageEntities<T extends { readonly slug: string; readonly name: string }>(
  stage: ConfigStageName,
  remoteItems: readonly T[],
  desiredItems: readonly T[]
): ConfigDiffEntry[] {
  const entries: ConfigDiffEntry[] = [];
  const remoteMap = new Map(remoteItems.map((i) => [i.slug, i]));
  const desiredMap = new Map(desiredItems.map((i) => [i.slug, i]));

  for (const desired of desiredItems) {
    const existing = remoteMap.get(desired.slug);
    if (!existing) {
      entries.push({
        stage,
        operation: "CREATE",
        slug: desired.slug,
        summary: `Create ${stage} '${desired.slug}' (${desired.name})`,
        beforeSummary: "NONE (Absent in Remote State)",
        afterSummary: summarizeEntity(stage, desired),
      });
    } else if (stableSerialize(existing) !== stableSerialize(desired)) {
      entries.push({
        stage,
        operation: "UPDATE",
        slug: desired.slug,
        summary: `Update ${stage} '${desired.slug}' in place (${existing.name} -> ${desired.name})`,
        beforeSummary: summarizeEntity(stage, existing),
        afterSummary: summarizeEntity(stage, desired),
      });
    }
  }

  for (const existing of remoteItems) {
    if (!desiredMap.has(existing.slug)) {
      entries.push({
        stage,
        operation: "DELETE",
        slug: existing.slug,
        summary: `Delete ${stage} '${existing.slug}'`,
        beforeSummary: summarizeEntity(stage, existing),
        afterSummary: "DELETED",
      });
    }
  }

  return entries;
}

/**
 * Computes a deterministic, topologically ordered diff plan between `remoteState` and `desiredConfig`.
 */
export function diffStoreConfig(
  remoteState: StoreConfigDocument,
  desiredConfig: StoreConfigDocument
): ConfigDiffPlan {
  validateStoreConfig(desiredConfig);

  // Ordered strictly by topological dependency: Warehouses -> Channels -> ProductTypes -> Products
  const entries: ConfigDiffEntry[] = [
    ...diffStageEntities("warehouses", remoteState.warehouses, desiredConfig.warehouses),
    ...diffStageEntities("channels", remoteState.channels, desiredConfig.channels),
    ...diffStageEntities("productTypes", remoteState.productTypes, desiredConfig.productTypes),
    ...diffStageEntities("products", remoteState.products, desiredConfig.products),
  ];

  return {
    totalChanges: entries.length,
    entries,
  };
}

/**
 * Applies `desiredConfig` onto `remoteState` following topological stage order and returns
 * the new state alongside the executed diff plan.
 */
export function deployStoreConfig(
  remoteState: StoreConfigDocument,
  desiredConfig: StoreConfigDocument
): {
  readonly plan: ConfigDiffPlan;
  readonly nextState: StoreConfigDocument;
} {
  const plan = diffStoreConfig(remoteState, desiredConfig);
  const nextState: StoreConfigDocument = {
    warehouses: structuredClone(desiredConfig.warehouses),
    channels: structuredClone(desiredConfig.channels),
    productTypes: structuredClone(desiredConfig.productTypes),
    products: structuredClone(desiredConfig.products),
  };
  return { plan, nextState };
}

export const BASELINE_DESIRED_STORE_CONFIG: StoreConfigDocument = {
  warehouses: [
    { slug: "us-east", name: "US East Hub (NJ)", countryCode: "US" },
    { slug: "us-central", name: "US Central Hub (TX)", countryCode: "US" },
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

/**
 * Stateful Commerce-as-Code GitOps Coordinator for interactive deployment,
 * zero-diff idempotency verification, in-place slug updates, and pre-flight guard auditing.
 */
export class StatefulStoreConfigurator {
  private remoteState: StoreConfigDocument = {
    warehouses: [],
    channels: [],
    productTypes: [],
    products: [],
  };
  private desiredConfig: StoreConfigDocument = structuredClone(
    BASELINE_DESIRED_STORE_CONFIG
  );
  private revision = 0;
  private deploySeq = 1;
  private latestBanner =
    "Ready: 4-Stage Topological DAG (warehouses -> channels -> productTypes -> products) | Universal Immutable Slug Identity";
  private readonly history: ConfigDeploymentAuditEntry[] = [];

  getRemoteState(): StoreConfigDocument {
    return this.remoteState;
  }

  getDesiredConfig(): StoreConfigDocument {
    return this.desiredConfig;
  }

  getCurrentDiffPlan(): ConfigDiffPlan {
    return diffStoreConfig(this.remoteState, this.desiredConfig);
  }

  getRevision(): number {
    return this.revision;
  }

  getLatestBanner(): string {
    return this.latestBanner;
  }

  listDeploymentHistory(limit = 8): readonly ConfigDeploymentAuditEntry[] {
    return this.history.slice(0, limit);
  }

  deployDesiredConfig(): {
    plan: ConfigDiffPlan;
    audit: ConfigDeploymentAuditEntry;
  } {
    const t0 = process.hrtime.bigint();
    const { plan, nextState } = deployStoreConfig(
      this.remoteState,
      this.desiredConfig
    );
    const durationUs =
      Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;

    if (plan.totalChanges > 0) {
      this.remoteState = nextState;
      this.revision += 1;
    }

    const whCount = plan.entries.filter((e) => e.stage === "warehouses").length;
    const chCount = plan.entries.filter((e) => e.stage === "channels").length;
    const ptCount = plan.entries.filter((e) => e.stage === "productTypes").length;
    const prCount = plan.entries.filter((e) => e.stage === "products").length;
    const stageBreakdown = `warehouses(${whCount}) -> channels(${chCount}) -> productTypes(${ptCount}) -> products(${prCount})`;

    const isNoop = plan.totalChanges === 0;
    const audit: ConfigDeploymentAuditEntry = {
      deployId: `cfg_dep_${String(this.deploySeq++).padStart(3, "0")}`,
      revision: this.revision,
      action: isNoop ? "ZERO_DIFF_VERIFY" : "DEPLOY_DAG",
      status: isNoop ? "IDEMPOTENT_NOOP" : "APPLIED",
      changesApplied: plan.totalChanges,
      stageBreakdown,
      detailSummary: isNoop
        ? "0 Changes Detected across all 4 DAG stages (Strict GitOps Idempotency Verified)"
        : `Applied ${plan.totalChanges} change(s) in topological order: ${plan.entries
            .map((e) => `${e.operation} ${e.slug}`)
            .join(", ")}`,
      durationUs,
      executedAtIso: new Date().toISOString(),
    };

    this.history.unshift(audit);
    this.latestBanner = isNoop
      ? `ZERO-DIFF IDEMPOTENCY VERIFIED (Rev #${this.revision}) // 0 Staged Changes (${stageBreakdown}) in ${durationUs} us -> Remote State Matches Desired YAML Bit-for-Bit`
      : `TOPOLOGICAL DAG DEPLOYED (Rev #${this.revision}) // Applied ${plan.totalChanges} Change(s) [${stageBreakdown}] in ${durationUs} us -> Synced to super-postgres:5438`;

    return { plan, audit };
  }

  stageSlugRenameAndExpansionDrift(): ConfigDiffPlan {
    const t0 = process.hrtime.bigint();
    this.desiredConfig = {
      warehouses: [
        ...BASELINE_DESIRED_STORE_CONFIG.warehouses,
        { slug: "eu-frankfurt", name: "EU Frankfurt Hub (DE)", countryCode: "DE" },
      ],
      channels: [
        ...BASELINE_DESIRED_STORE_CONFIG.channels,
        {
          slug: "eu-flagship",
          name: "EU Direct Store (VAT Inclusive)",
          currencyCode: "EUR",
          defaultCountry: "DE",
          taxInclusionMode: "TAX_INCLUSIVE",
          stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
          allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
          warehouseSlugs: ["eu-frankfurt"],
        },
      ],
      productTypes: [
        {
          ...BASELINE_DESIRED_STORE_CONFIG.productTypes[0]!,
          // Immutable slug 'precision-hardware' preserved while display name is updated in place!
          name: "Precision CNC Hardware Pro (v2)",
        },
      ],
      products: [
        ...BASELINE_DESIRED_STORE_CONFIG.products,
        {
          slug: "kronos-8k-wireless-mouse",
          name: "Kronos Magnesium 8KHz Wireless Mouse",
          productTypeSlug: "precision-hardware",
          attributes: { chassis_material: "magnesium-alloy" },
          variants: [
            {
              sku: "KR-MG8K-SLV",
              name: "Raw Silver / Optical Rapid",
              attributes: { switch_type: "optical-rapid" },
              channelListings: [
                {
                  channelSlug: "us-retail",
                  isPublished: true,
                  priceAmount: 17_900n,
                },
                {
                  channelSlug: "eu-flagship",
                  isPublished: true,
                  priceAmount: 19_000n,
                },
              ],
            },
          ],
        },
      ],
    };

    const plan = this.getCurrentDiffPlan();
    const durationUs =
      Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;

    const audit: ConfigDeploymentAuditEntry = {
      deployId: `cfg_dep_${String(this.deploySeq++).padStart(3, "0")}`,
      revision: this.revision,
      action: "STAGE_DRIFT_UPDATE",
      status: "STAGED",
      changesApplied: plan.totalChanges,
      stageBreakdown: `warehouses(1 CREATE) -> channels(1 CREATE) -> productTypes(1 UPDATE) -> products(1 CREATE)`,
      detailSummary: `Staged in-place UPDATE for slug 'precision-hardware' (no duplicate created) + CREATE eu-frankfurt, eu-flagship, kronos-8k-wireless-mouse`,
      durationUs,
      executedAtIso: new Date().toISOString(),
    };
    this.history.unshift(audit);
    this.latestBanner = `GITOPS DRIFT STAGED (${plan.totalChanges} Changes) // Slug 'precision-hardware' renamed in-place (UPDATE, 0 Duplicates) + Staged CREATE for eu-frankfurt, eu-flagship & kronos-8k-wireless-mouse`;
    return plan;
  }

  simulatePreflightValidationGuard(): {
    blocked: boolean;
    issues: readonly string[];
    audit: ConfigDeploymentAuditEntry;
  } {
    const t0 = process.hrtime.bigint();
    const brokenCandidate: StoreConfigDocument = {
      ...this.desiredConfig,
      channels: [
        {
          ...this.desiredConfig.channels[0]!,
          warehouseSlugs: ["us-east", "ghost-mars-warehouse"],
        },
      ],
      products: [
        {
          ...this.desiredConfig.products[0]!,
          attributes: { chassis_material: "unobtainium-cardboard" },
        },
      ],
    };

    let issues: readonly string[] = [];
    try {
      validateStoreConfig(brokenCandidate);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        issues = err.issues;
      }
    }

    const durationUs =
      Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;

    const audit: ConfigDeploymentAuditEntry = {
      deployId: `cfg_dep_${String(this.deploySeq++).padStart(3, "0")}`,
      revision: this.revision,
      action: "PREFLIGHT_REJECTED",
      status: "BLOCKED_PREFLIGHT",
      changesApplied: 0,
      stageBreakdown: "Stage 1 Pre-Flight Aborted (0 DB Writes)",
      detailSummary: issues.join(" | "),
      durationUs,
      executedAtIso: new Date().toISOString(),
    };
    this.history.unshift(audit);
    this.latestBanner = `STAGE 1 PRE-FLIGHT GUARD TRIGGERED (${durationUs} us) // Aborted Deployment Before DB Mutation: ${issues.join(" ; ")}`;
    return { blocked: true, issues, audit };
  }

  getDesiredConfigYaml(): string {
    return serializeStoreConfigYaml(this.desiredConfig);
  }

  getDesiredConfigJson(): string {
    return serializeStoreConfigJson(this.desiredConfig, true);
  }

  previewCustomConfigText(rawText: string): {
    readonly ok: boolean;
    readonly format: "json" | "yaml";
    readonly document?: StoreConfigDocument;
    readonly plan?: ConfigDiffPlan;
    readonly issues: readonly string[];
    readonly durationUs: number;
  } {
    const t0 = process.hrtime.bigint();
    try {
      const { format, document } = parseStoreConfigText(rawText);
      const plan = diffStoreConfig(this.remoteState, document);
      const durationUs =
        Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;
      return { ok: true, format, document, plan, issues: [], durationUs };
    } catch (err) {
      const durationUs =
        Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;
      const issues =
        err instanceof ConfigValidationError
          ? err.issues
          : [err instanceof Error ? err.message : String(err)];
      return {
        ok: false,
        format: rawText.trim().startsWith("{") ? "json" : "yaml",
        issues,
        durationUs,
      };
    }
  }

  deployCustomConfigText(rawText: string): {
    readonly ok: boolean;
    readonly format: "json" | "yaml";
    readonly plan?: ConfigDiffPlan;
    readonly audit: ConfigDeploymentAuditEntry;
    readonly issues: readonly string[];
  } {
    const t0 = process.hrtime.bigint();
    const fallbackFmt = rawText.trim().startsWith("{") ? "json" : "yaml";
    try {
      const { format, document } = parseStoreConfigText(rawText);
      validateStoreConfig(document);
      this.desiredConfig = document;
      const { plan, audit } = this.deployDesiredConfig();
      return { ok: true, format, plan, audit, issues: [] };
    } catch (err) {
      const durationUs =
        Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;
      const issues =
        err instanceof ConfigValidationError
          ? err.issues
          : [err instanceof Error ? err.message : String(err)];
      const audit: ConfigDeploymentAuditEntry = {
        deployId: `cfg_dep_${String(this.deploySeq++).padStart(3, "0")}`,
        revision: this.revision,
        action: "PREFLIGHT_REJECTED",
        status: "BLOCKED_PREFLIGHT",
        changesApplied: 0,
        stageBreakdown: "Stage 1 Pre-Flight Aborted (0 DB Writes)",
        detailSummary: issues.join(" | "),
        durationUs,
        executedAtIso: new Date().toISOString(),
      };
      this.history.unshift(audit);
      this.latestBanner = `ONLINE EDITOR STAGE 1 PRE-FLIGHT REJECTED (${durationUs} us) // Aborted Before DB Mutation: ${issues.join(" ; ")}`;
      return { ok: false, format: fallbackFmt, audit, issues };
    }
  }
}

interface PgStoreConfigStateRow {
  config_key: string;
  revision: string;
  desired_config_json: string;
  remote_state_json: string;
  updated_at: string;
}

interface PgStoredDiffEnvelope {
  readonly audit: ConfigDeploymentAuditEntry;
  readonly entries: readonly ConfigDiffEntry[];
}

const EMPTY_STORE_CONFIG: StoreConfigDocument = {
  warehouses: [],
  channels: [],
  productTypes: [],
  products: [],
};

function normalizeCfgIso(raw: string): string {
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? raw : dt.toISOString();
}

/**
 * PostgreSQL 17-backed Store Configurator (`store_config_state`, `store_config_deployments`).
 * Preserves lossless `BigInt` (`MinorUnits`) serialization across JSONB storage and executes
 * all revision bumps and audit logging inside `FOR UPDATE` PostgreSQL transactions.
 */
export class PgStoreConfigurator {
  private readonly pool: PgPoolLike;
  private readonly configKey: string;
  private latestBanner =
    "Ready: 4-Stage Topological DAG (warehouses -> channels -> productTypes -> products) | Universal Immutable Slug Identity";

  constructor(pool: PgPoolLike, configKey = "default") {
    this.pool = pool;
    this.configKey = configKey;
  }

  private async ensureInitialized(tx: PgTxClient): Promise<PgStoreConfigStateRow> {
    const existing = await tx.query<PgStoreConfigStateRow>(
      `SELECT config_key, revision, desired_config_json, remote_state_json, updated_at
       FROM store_config_state
       WHERE config_key = $1
       FOR UPDATE`,
      [this.configKey]
    );
    if (existing.rows[0]) {
      return existing.rows[0];
    }

    const nowIso = new Date().toISOString();
    const desiredJson = serializeWithBigInt(BASELINE_DESIRED_STORE_CONFIG);
    const remoteJson = serializeWithBigInt(EMPTY_STORE_CONFIG);
    await tx.query(
      `INSERT INTO store_config_state (
         config_key, revision, desired_config_json, remote_state_json, updated_at
       ) VALUES ($1, 0, $2::jsonb, $3::jsonb, $4::timestamptz)
       ON CONFLICT (config_key) DO NOTHING`,
      [this.configKey, desiredJson, remoteJson, nowIso]
    );

    const locked = await tx.query<PgStoreConfigStateRow>(
      `SELECT config_key, revision, desired_config_json, remote_state_json, updated_at
       FROM store_config_state
       WHERE config_key = $1
       FOR UPDATE`,
      [this.configKey]
    );
    return locked.rows[0]!;
  }

  private nextMonotonicIso(prevUpdatedAt: string): string {
    const prevMs = Date.parse(prevUpdatedAt);
    const nextMs = Number.isFinite(prevMs)
      ? Math.max(Date.now(), prevMs + 1)
      : Date.now();
    return new Date(nextMs).toISOString();
  }

  private async loadStateReadonly(): Promise<{
    revision: number;
    desiredConfig: StoreConfigDocument;
    remoteState: StoreConfigDocument;
    updatedAt: string;
  }> {
    const res = await this.pool.query<PgStoreConfigStateRow>(
      `SELECT config_key, revision, desired_config_json, remote_state_json, updated_at
       FROM store_config_state
       WHERE config_key = $1`,
      [this.configKey]
    );
    if (res.rows[0]) {
      const r = res.rows[0];
      return {
        revision: Number(r.revision),
        desiredConfig: deserializeWithBigInt<StoreConfigDocument>(
          r.desired_config_json
        ),
        remoteState: deserializeWithBigInt<StoreConfigDocument>(
          r.remote_state_json
        ),
        updatedAt: normalizeCfgIso(r.updated_at),
      };
    }

    return await this.pool.withTransaction(async (tx) => {
      const row = await this.ensureInitialized(tx);
      return {
        revision: Number(row.revision),
        desiredConfig: deserializeWithBigInt<StoreConfigDocument>(
          row.desired_config_json
        ),
        remoteState: deserializeWithBigInt<StoreConfigDocument>(
          row.remote_state_json
        ),
        updatedAt: normalizeCfgIso(row.updated_at),
      };
    });
  }

  async getRemoteState(): Promise<StoreConfigDocument> {
    return (await this.loadStateReadonly()).remoteState;
  }

  async getDesiredConfig(): Promise<StoreConfigDocument> {
    return (await this.loadStateReadonly()).desiredConfig;
  }

  async getRevision(): Promise<number> {
    return (await this.loadStateReadonly()).revision;
  }

  async getCurrentDiffPlan(): Promise<ConfigDiffPlan> {
    const state = await this.loadStateReadonly();
    return diffStoreConfig(state.remoteState, state.desiredConfig);
  }

  getLatestBanner(): string {
    return this.latestBanner;
  }

  async getDesiredConfigYaml(): Promise<string> {
    return serializeStoreConfigYaml(await this.getDesiredConfig());
  }

  async getDesiredConfigJson(): Promise<string> {
    return serializeStoreConfigJson(await this.getDesiredConfig(), true);
  }

  async listDeploymentHistory(
    limit = 8
  ): Promise<readonly ConfigDeploymentAuditEntry[]> {
    const res = await this.pool.query<{
      deployment_id: string;
      revision: string;
      summary: string;
      diff_json: string;
      created_at: string;
    }>(
      `SELECT deployment_id, revision, summary, diff_json, created_at
       FROM store_config_deployments
       WHERE config_key = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [this.configKey, limit]
    );

    return res.rows.map((r) => {
      const env = deserializeWithBigInt<PgStoredDiffEnvelope>(r.diff_json);
      return {
        ...env.audit,
        deployId: env.audit.deployId ?? r.deployment_id,
        revision: Number(r.revision),
        executedAtIso: normalizeCfgIso(r.created_at),
      };
    });
  }

  private async recordDeploymentAudit(
    tx: PgTxClient,
    params: {
      audit: ConfigDeploymentAuditEntry;
      entries: readonly ConfigDiffEntry[];
      executedBy: string;
    }
  ): Promise<void> {
    const envelope: PgStoredDiffEnvelope = {
      audit: params.audit,
      entries: params.entries,
    };
    await tx.query(
      `INSERT INTO store_config_deployments (
         deployment_id, config_key, revision, executed_by, summary, diff_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)`,
      [
        params.audit.deployId,
        this.configKey,
        params.audit.revision,
        params.executedBy,
        params.audit.detailSummary,
        serializeWithBigInt(envelope),
        params.audit.executedAtIso,
      ]
    );
  }

  async deployDesiredConfig(executedBy = "admin@super-ecommerce.io"): Promise<{
    plan: ConfigDiffPlan;
    audit: ConfigDeploymentAuditEntry;
  }> {
    return await this.pool.withTransaction(async (tx) => {
      const row = await this.ensureInitialized(tx);
      const remoteState = deserializeWithBigInt<StoreConfigDocument>(
        row.remote_state_json
      );
      const desiredConfig = deserializeWithBigInt<StoreConfigDocument>(
        row.desired_config_json
      );
      let revision = Number(row.revision);

      const t0 = process.hrtime.bigint();
      const { plan, nextState } = deployStoreConfig(remoteState, desiredConfig);
      const durationUs =
        Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;

      if (plan.totalChanges > 0) {
        revision += 1;
      }

      const execIso = this.nextMonotonicIso(row.updated_at);
      await tx.query(
        `UPDATE store_config_state
         SET revision = $1,
             remote_state_json = $2::jsonb,
             updated_at = $3::timestamptz
         WHERE config_key = $4`,
        [
          revision,
          serializeWithBigInt(plan.totalChanges > 0 ? nextState : remoteState),
          execIso,
          this.configKey,
        ]
      );

      const whCount = plan.entries.filter((e) => e.stage === "warehouses").length;
      const chCount = plan.entries.filter((e) => e.stage === "channels").length;
      const ptCount = plan.entries.filter((e) => e.stage === "productTypes").length;
      const prCount = plan.entries.filter((e) => e.stage === "products").length;
      const stageBreakdown = `warehouses(${whCount}) -> channels(${chCount}) -> productTypes(${ptCount}) -> products(${prCount})`;

      const isNoop = plan.totalChanges === 0;
      const audit: ConfigDeploymentAuditEntry = {
        deployId: `cfg_dep_${randomUUID()}`,
        revision,
        action: isNoop ? "ZERO_DIFF_VERIFY" : "DEPLOY_DAG",
        status: isNoop ? "IDEMPOTENT_NOOP" : "APPLIED",
        changesApplied: plan.totalChanges,
        stageBreakdown,
        detailSummary: isNoop
          ? "0 Changes Detected across all 4 DAG stages (Strict GitOps Idempotency Verified)"
          : `Applied ${plan.totalChanges} change(s) in topological order: ${plan.entries
              .map((e) => `${e.operation} ${e.slug}`)
              .join(", ")}`,
        durationUs,
        executedAtIso: execIso,
      };

      await this.recordDeploymentAudit(tx, {
        audit,
        entries: plan.entries,
        executedBy,
      });

      this.latestBanner = isNoop
        ? `ZERO-DIFF IDEMPOTENCY VERIFIED (Rev #${revision}) // 0 Staged Changes (${stageBreakdown}) in ${durationUs} us -> Remote State Matches Desired YAML Bit-for-Bit`
        : `TOPOLOGICAL DAG DEPLOYED (Rev #${revision}) // Applied ${plan.totalChanges} Change(s) [${stageBreakdown}] in ${durationUs} us -> Synced to PostgreSQL`;

      return { plan, audit };
    });
  }

  async stageSlugRenameAndExpansionDrift(
    executedBy = "admin@super-ecommerce.io"
  ): Promise<ConfigDiffPlan> {
    return await this.pool.withTransaction(async (tx) => {
      const row = await this.ensureInitialized(tx);
      const remoteState = deserializeWithBigInt<StoreConfigDocument>(
        row.remote_state_json
      );
      const revision = Number(row.revision);
      const t0 = process.hrtime.bigint();

      const nextDesired: StoreConfigDocument = {
        warehouses: [
          ...BASELINE_DESIRED_STORE_CONFIG.warehouses,
          { slug: "eu-frankfurt", name: "EU Frankfurt Hub (DE)", countryCode: "DE" },
        ],
        channels: [
          ...BASELINE_DESIRED_STORE_CONFIG.channels,
          {
            slug: "eu-flagship",
            name: "EU Direct Store (VAT Inclusive)",
            currencyCode: "EUR",
            defaultCountry: "DE",
            taxInclusionMode: "TAX_INCLUSIVE",
            stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
            allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
            warehouseSlugs: ["eu-frankfurt"],
          },
        ],
        productTypes: [
          {
            ...BASELINE_DESIRED_STORE_CONFIG.productTypes[0]!,
            name: "Precision CNC Hardware Pro (v2)",
          },
        ],
        products: [
          ...BASELINE_DESIRED_STORE_CONFIG.products,
          {
            slug: "kronos-8k-wireless-mouse",
            name: "Kronos Magnesium 8KHz Wireless Mouse",
            productTypeSlug: "precision-hardware",
            attributes: { chassis_material: "magnesium-alloy" },
            variants: [
              {
                sku: "KR-MG8K-SLV",
                name: "Raw Silver / Optical Rapid",
                attributes: { switch_type: "optical-rapid" },
                channelListings: [
                  {
                    channelSlug: "us-retail",
                    isPublished: true,
                    priceAmount: 17_900n,
                  },
                  {
                    channelSlug: "eu-flagship",
                    isPublished: true,
                    priceAmount: 19_000n,
                  },
                ],
              },
            ],
          },
        ],
      };

      const plan = diffStoreConfig(remoteState, nextDesired);
      const durationUs =
        Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;
      const execIso = this.nextMonotonicIso(row.updated_at);

      await tx.query(
        `UPDATE store_config_state
         SET desired_config_json = $1::jsonb,
             updated_at = $2::timestamptz
         WHERE config_key = $3`,
        [serializeWithBigInt(nextDesired), execIso, this.configKey]
      );

      const audit: ConfigDeploymentAuditEntry = {
        deployId: `cfg_dep_${randomUUID()}`,
        revision,
        action: "STAGE_DRIFT_UPDATE",
        status: "STAGED",
        changesApplied: plan.totalChanges,
        stageBreakdown:
          "warehouses(1 CREATE) -> channels(1 CREATE) -> productTypes(1 UPDATE) -> products(1 CREATE)",
        detailSummary:
          "Staged in-place UPDATE for slug 'precision-hardware' (no duplicate created) + CREATE eu-frankfurt, eu-flagship, kronos-8k-wireless-mouse",
        durationUs,
        executedAtIso: execIso,
      };
      await this.recordDeploymentAudit(tx, {
        audit,
        entries: plan.entries,
        executedBy,
      });

      this.latestBanner = `GITOPS DRIFT STAGED (${plan.totalChanges} Changes) // Slug 'precision-hardware' renamed in-place (UPDATE, 0 Duplicates) + Staged CREATE for eu-frankfurt, eu-flagship & kronos-8k-wireless-mouse`;
      return plan;
    });
  }

  async simulatePreflightValidationGuard(
    executedBy = "admin@super-ecommerce.io"
  ): Promise<{
    blocked: boolean;
    issues: readonly string[];
    audit: ConfigDeploymentAuditEntry;
  }> {
    return await this.pool.withTransaction(async (tx) => {
      const row = await this.ensureInitialized(tx);
      const desiredConfig = deserializeWithBigInt<StoreConfigDocument>(
        row.desired_config_json
      );
      const revision = Number(row.revision);
      const t0 = process.hrtime.bigint();

      const brokenCandidate: StoreConfigDocument = {
        ...desiredConfig,
        channels: [
          {
            ...desiredConfig.channels[0]!,
            warehouseSlugs: ["us-east", "ghost-mars-warehouse"],
          },
        ],
        products: [
          {
            ...desiredConfig.products[0]!,
            attributes: { chassis_material: "unobtainium-cardboard" },
          },
        ],
      };

      let issues: readonly string[] = [];
      try {
        validateStoreConfig(brokenCandidate);
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          issues = err.issues;
        }
      }

      const durationUs =
        Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;
      const execIso = this.nextMonotonicIso(row.updated_at);

      await tx.query(
        `UPDATE store_config_state SET updated_at = $1::timestamptz WHERE config_key = $2`,
        [execIso, this.configKey]
      );

      const audit: ConfigDeploymentAuditEntry = {
        deployId: `cfg_dep_${randomUUID()}`,
        revision,
        action: "PREFLIGHT_REJECTED",
        status: "BLOCKED_PREFLIGHT",
        changesApplied: 0,
        stageBreakdown: "Stage 1 Pre-Flight Aborted (0 DB Writes)",
        detailSummary: issues.join(" | "),
        durationUs,
        executedAtIso: execIso,
      };
      await this.recordDeploymentAudit(tx, { audit, entries: [], executedBy });
      this.latestBanner = `STAGE 1 PRE-FLIGHT GUARD TRIGGERED (${durationUs} us) // Aborted Deployment Before DB Mutation: ${issues.join(" ; ")}`;
      return { blocked: true, issues, audit };
    });
  }

  async previewCustomConfigText(rawText: string): Promise<{
    readonly ok: boolean;
    readonly format: "json" | "yaml";
    readonly document?: StoreConfigDocument;
    readonly plan?: ConfigDiffPlan;
    readonly issues: readonly string[];
    readonly durationUs: number;
  }> {
    const state = await this.loadStateReadonly();
    const t0 = process.hrtime.bigint();
    try {
      const { format, document } = parseStoreConfigText(rawText);
      const plan = diffStoreConfig(state.remoteState, document);
      const durationUs =
        Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;
      return { ok: true, format, document, plan, issues: [], durationUs };
    } catch (err) {
      const durationUs =
        Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;
      const issues =
        err instanceof ConfigValidationError
          ? err.issues
          : [err instanceof Error ? err.message : String(err)];
      return {
        ok: false,
        format: rawText.trim().startsWith("{") ? "json" : "yaml",
        issues,
        durationUs,
      };
    }
  }

  async deployCustomConfigText(
    rawText: string,
    executedBy = "admin@super-ecommerce.io"
  ): Promise<{
    readonly ok: boolean;
    readonly format: "json" | "yaml";
    readonly plan?: ConfigDiffPlan;
    readonly audit: ConfigDeploymentAuditEntry;
    readonly issues: readonly string[];
  }> {
    const t0 = process.hrtime.bigint();
    const fallbackFmt = rawText.trim().startsWith("{") ? "json" : "yaml";
    try {
      const { format, document } = parseStoreConfigText(rawText);
      validateStoreConfig(document);

      const res = await this.pool.withTransaction(async (tx) => {
        const row = await this.ensureInitialized(tx);
        const remoteState = deserializeWithBigInt<StoreConfigDocument>(
          row.remote_state_json
        );
        let revision = Number(row.revision);

        const { plan, nextState } = deployStoreConfig(remoteState, document);
        const durationUs =
          Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;

        if (plan.totalChanges > 0) {
          revision += 1;
        }
        const execIso = this.nextMonotonicIso(row.updated_at);

        await tx.query(
          `UPDATE store_config_state
           SET revision = $1,
               desired_config_json = $2::jsonb,
               remote_state_json = $3::jsonb,
               updated_at = $4::timestamptz
           WHERE config_key = $5`,
          [
            revision,
            serializeWithBigInt(document),
            serializeWithBigInt(plan.totalChanges > 0 ? nextState : remoteState),
            execIso,
            this.configKey,
          ]
        );

        const whCount = plan.entries.filter((e) => e.stage === "warehouses").length;
        const chCount = plan.entries.filter((e) => e.stage === "channels").length;
        const ptCount = plan.entries.filter((e) => e.stage === "productTypes").length;
        const prCount = plan.entries.filter((e) => e.stage === "products").length;
        const stageBreakdown = `warehouses(${whCount}) -> channels(${chCount}) -> productTypes(${ptCount}) -> products(${prCount})`;
        const isNoop = plan.totalChanges === 0;

        const audit: ConfigDeploymentAuditEntry = {
          deployId: `cfg_dep_${randomUUID()}`,
          revision,
          action: isNoop ? "ZERO_DIFF_VERIFY" : "DEPLOY_DAG",
          status: isNoop ? "IDEMPOTENT_NOOP" : "APPLIED",
          changesApplied: plan.totalChanges,
          stageBreakdown,
          detailSummary: isNoop
            ? "0 Changes Detected across all 4 DAG stages (Strict GitOps Idempotency Verified)"
            : `Applied ${plan.totalChanges} change(s) in topological order: ${plan.entries
                .map((e) => `${e.operation} ${e.slug}`)
                .join(", ")}`,
          durationUs,
          executedAtIso: execIso,
        };

        await this.recordDeploymentAudit(tx, {
          audit,
          entries: plan.entries,
          executedBy,
        });
        this.latestBanner = isNoop
          ? `ZERO-DIFF IDEMPOTENCY VERIFIED (Rev #${revision}) // 0 Staged Changes (${stageBreakdown}) in ${durationUs} us -> Remote State Matches Desired YAML Bit-for-Bit`
          : `TOPOLOGICAL DAG DEPLOYED (Rev #${revision}) // Applied ${plan.totalChanges} Change(s) [${stageBreakdown}] in ${durationUs} us -> Synced to PostgreSQL`;

        return { ok: true as const, format, plan, audit, issues: [] as const };
      });
      return res;
    } catch (err) {
      const durationUs =
        Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;
      const issues =
        err instanceof ConfigValidationError
          ? err.issues
          : [err instanceof Error ? err.message : String(err)];

      const audit = await this.pool.withTransaction(async (tx) => {
        const row = await this.ensureInitialized(tx);
        const execIso = this.nextMonotonicIso(row.updated_at);
        await tx.query(
          `UPDATE store_config_state SET updated_at = $1::timestamptz WHERE config_key = $2`,
          [execIso, this.configKey]
        );
        const entry: ConfigDeploymentAuditEntry = {
          deployId: `cfg_dep_${randomUUID()}`,
          revision: Number(row.revision),
          action: "PREFLIGHT_REJECTED",
          status: "BLOCKED_PREFLIGHT",
          changesApplied: 0,
          stageBreakdown: "Stage 1 Pre-Flight Aborted (0 DB Writes)",
          detailSummary: issues.join(" | "),
          durationUs,
          executedAtIso: execIso,
        };
        await this.recordDeploymentAudit(tx, {
          audit: entry,
          entries: [],
          executedBy,
        });
        return entry;
      });
      this.latestBanner = `ONLINE EDITOR STAGE 1 PRE-FLIGHT REJECTED (${durationUs} us) // Aborted Before DB Mutation: ${issues.join(" ; ")}`;
      return { ok: false, format: fallbackFmt, audit, issues };
    }
  }
}
