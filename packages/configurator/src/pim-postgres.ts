import { randomUUID } from "node:crypto";
import {
  buildCatalogChannelProjection,
  CATALOG_PROJECTION_COLUMNS,
  deserializeWithBigInt,
  hydrateCatalogProjection,
  serializeWithBigInt,
  upsertCatalogProjection,
  type CatalogChannelProjectionRecord,
  type CatalogProjectionRow,
  type ChannelRecord,
  type PgPoolLike,
  type PgQueryable,
  type PgTxClient,
} from "@super-ecommerce/db";
import type { ChannelConfig, StoreConfigDocument } from "./index.ts";
import {
  PIM_DEMO_INITIAL_STORE_STATE,
  preparePimIngestion,
  validatePimEnvelope,
  type PimIngestionAuditEntry,
  type PimIngestionPayload,
  type PimIngestionResult,
  type PimMaterializedCatalogProjection,
} from "./pim-adapter.ts";

const CONFIG_KEY = "pim";
const PIM_CATALOG_LOCK = 742918237193;
const DEFAULT_MEDIA = "https://cdn.super-ecommerce.com/pim/default-product.webp";

export class PimCatalogConflictError extends Error {}

interface ChannelRow {
  id: string;
  slug: string;
  name: string;
  currency_code: string;
  default_country: string;
  tax_inclusion_mode: ChannelRecord["taxInclusionMode"];
  stock_availability_mode: ChannelRecord["stockAvailabilityMode"];
  allocation_strategy: ChannelRecord["allocationStrategy"];
  reservation_ttl_seconds: string;
  is_active: string;
}

function hydrateChannel(row: ChannelRow): ChannelRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    currencyCode: row.currency_code.trim(),
    defaultCountry: row.default_country.trim(),
    taxInclusionMode: row.tax_inclusion_mode,
    stockAvailabilityMode: row.stock_availability_mode,
    allocationStrategy: row.allocation_strategy,
    reservationTtlSeconds: Number(row.reservation_ttl_seconds),
    isActive: row.is_active === "t" || row.is_active === "true",
  };
}

async function readContext(client: PgQueryable) {
  const { rows: [saved] } = await client.query<{ remote_state_json: string }>(
    "SELECT remote_state_json FROM store_config_state WHERE config_key = $1", [CONFIG_KEY],
  );
  const { rows } = await client.query<ChannelRow>("SELECT * FROM channels ORDER BY slug");
  const channels = new Map(rows.map((row) => [row.slug, hydrateChannel(row)]));
  const channelConfigs = new Map<string, ChannelConfig>();
  for (const channel of PIM_DEMO_INITIAL_STORE_STATE.channels) {
    channelConfigs.set(channel.slug, { ...channel, warehouseSlugs: [] });
  }
  for (const channel of channels.values()) {
    channelConfigs.set(channel.slug, { ...channel, warehouseSlugs: [] });
  }
  const snapshot = saved && deserializeWithBigInt<StoreConfigDocument>(saved.remote_state_json);
  const base: StoreConfigDocument = {
    warehouses: [],
    channels: [...channelConfigs.values()],
    productTypes: snapshot ? snapshot.productTypes : [],
    products: snapshot ? snapshot.products : [],
  };
  return { base, channels, channelConfigs };
}

// A fresh local store can ingest the two sample channels. Existing channel settings win.
async function ensureChannel(tx: PgTxClient, config: ChannelConfig): Promise<ChannelRecord> {
  const { rows: [row] } = await tx.query<ChannelRow>(
    `INSERT INTO channels (slug, name, currency_code, default_country,
      tax_inclusion_mode, stock_availability_mode, allocation_strategy)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING *`,
    [config.slug, config.name, config.currencyCode, config.defaultCountry,
      config.taxInclusionMode, config.stockAvailabilityMode, config.allocationStrategy],
  );
  return hydrateChannel(row!);
}

interface PimProjectionRow extends CatalogProjectionRow {
  media_url: string | null;
}

async function readPimProjections(client: PgQueryable, channelSlug?: string, productSlugs?: readonly string[]) {
  const { rows } = await client.query<PimProjectionRow>(
    `SELECT ${CATALOG_PROJECTION_COLUMNS},
            (SELECT pim_media_url FROM products WHERE id = projection.product_id) AS media_url
     FROM catalog_channel_projections projection
     WHERE product_id IN (SELECT id FROM products WHERE pim_source IS NOT NULL)
       AND ($1::text IS NULL OR channel_slug = $1)
       AND ($2::jsonb IS NULL OR product_slug IN (SELECT jsonb_array_elements_text($2::jsonb)))
     ORDER BY product_slug, channel_slug`,
    [channelSlug ?? null, productSlugs === undefined ? null : JSON.stringify(productSlugs)],
  );
  return rows;
}

function toPimProjection(row: PimProjectionRow): PimMaterializedCatalogProjection {
  const projection = hydrateCatalogProjection(row);
  const variant = projection.variantsSnapshot[0]!;
  return {
    productSlug: projection.productSlug,
    productName: projection.productName,
    channelSlug: projection.channelSlug,
    sku: variant.sku,
    minEffectivePrice: row.min_effective_price,
    isInStock: projection.isInStock,
    totalAvailableQty: projection.totalAvailableQty,
    mediaUrl: row.media_url ?? DEFAULT_MEDIA,
    mergedAttributes: Object.fromEntries(Object.entries(projection.mergedAttributes).map(([key, values]) => [
      key, values.length === 1 ? values[0] : values,
    ])),
  };
}

async function writeCatalog(
  tx: PgTxClient,
  payload: PimIngestionPayload,
  document: StoreConfigDocument,
  context: Awaited<ReturnType<typeof readContext>>,
): Promise<void> {
  const importedFamilies = new Set(payload.families.map((family) => family.code));
  for (const family of document.productTypes) {
    if (!importedFamilies.has(family.slug)) continue;
    await tx.query(
      `INSERT INTO product_types (slug, name, is_shipping_required, product_attributes_schema, variant_attributes_schema)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name,
         is_shipping_required = EXCLUDED.is_shipping_required,
         product_attributes_schema = EXCLUDED.product_attributes_schema,
         variant_attributes_schema = EXCLUDED.variant_attributes_schema`,
      [family.slug, family.name, family.isShippingRequired ?? true,
        family.productAttributesSchema, family.variantAttributesSchema],
    );
  }

  const mappedProducts = new Map(document.products.map((product) => [product.slug, product]));
  await tx.query(
    `DELETE FROM catalog_channel_projections
     WHERE product_slug IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    [JSON.stringify(payload.products.map((product) => product.slug))],
  );
  for (const item of payload.products) {
    const product = mappedProducts.get(item.slug)!;
    const variant = product.variants[0]!;
    const { rows: [storedProduct] } = await tx.query<{ id: string; product_type_id: string }>(
      `INSERT INTO products (product_type_id, slug, name, attributes, pim_source, pim_external_id, pim_media_url)
       SELECT id, $1, $2, $3::jsonb, $4, $5, $6 FROM product_types WHERE slug = $7
         AND NOT EXISTS (SELECT 1 FROM products WHERE pim_source = $4 AND pim_external_id = $5 AND slug <> $1)
       ON CONFLICT (slug) DO UPDATE SET product_type_id = EXCLUDED.product_type_id,
         name = EXCLUDED.name, attributes = EXCLUDED.attributes, pim_source = EXCLUDED.pim_source,
         pim_external_id = EXCLUDED.pim_external_id, pim_media_url = EXCLUDED.pim_media_url,
         updated_at = now()
       WHERE products.pim_source IS NULL OR
         (products.pim_source = EXCLUDED.pim_source AND products.pim_external_id = EXCLUDED.pim_external_id)
       RETURNING id, product_type_id`,
      [product.slug, product.name, product.attributes, payload.systemSource, item.id,
        item.mediaUrl ?? null, product.productTypeSlug],
    );
    if (!storedProduct) throw new PimCatalogConflictError(`Cannot claim PIM product '${product.slug}'`);

    const { rows: [storedVariant] } = await tx.query<{ id: string }>(
      `INSERT INTO product_variants (product_id, sku, name, attributes)
       VALUES ($1::uuid, $2, $3, $4::jsonb)
       ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name, attributes = EXCLUDED.attributes,
         updated_at = now()
       WHERE product_variants.product_id = EXCLUDED.product_id
       RETURNING id`,
      [storedProduct.id, variant.sku, variant.name, variant.attributes],
    );
    if (!storedVariant) throw new PimCatalogConflictError(`SKU '${variant.sku}' belongs to another product`);

    // A product entry replaces its full channel list. Preserve older listing rows as unpublished.
    await tx.query(
      `UPDATE variant_channel_listings SET is_published = false, updated_at = now()
       WHERE is_published AND variant_id IN (SELECT id FROM product_variants WHERE product_id = $1::uuid)`,
      [storedProduct.id],
    );
    for (const listing of variant.channelListings) {
      let channel = context.channels.get(listing.channelSlug);
      if (!channel) {
        channel = await ensureChannel(tx, context.channelConfigs.get(listing.channelSlug)!);
        context.channels.set(channel.slug, channel);
      }
      await tx.query(
        `INSERT INTO variant_channel_listings (variant_id, channel_id, is_published, price_amount, compare_at_amount)
         VALUES ($1::uuid, $2::uuid, $3, $4::bigint, $5::bigint)
         ON CONFLICT (variant_id, channel_id) DO UPDATE SET is_published = EXCLUDED.is_published,
           price_amount = EXCLUDED.price_amount, compare_at_amount = EXCLUDED.compare_at_amount,
           updated_at = now()`,
        [storedVariant.id, channel.id, listing.isPublished, listing.priceAmount, listing.compareAtAmount ?? null],
      );
      if (!listing.isPublished) continue;
      const { rows: [stock] } = await tx.query<{ quantity: string }>(
        `SELECT LEAST(COALESCE(SUM(GREATEST(q.quantity_on_hand - q.quantity_reserved - q.quantity_allocated, 0)), 0), 2147483647)::text AS quantity
         FROM stock_quants q JOIN channel_warehouses cw ON cw.warehouse_id = q.warehouse_id
         WHERE q.variant_id = $1::uuid AND cw.channel_id = $2::uuid`,
        [storedVariant.id, channel.id],
      );
      const projection = buildCatalogChannelProjection({
        channel,
        product: {
          id: storedProduct.id, productTypeId: storedProduct.product_type_id,
          slug: product.slug, name: product.name,
          attributes: { ...product.attributes, family: item.familyCode, pimSource: payload.systemSource },
        },
        variants: [{ ...variant, id: storedVariant.id, productId: storedProduct.id }],
        listingsByVariantId: new Map([[storedVariant.id, {
          ...listing, variantId: storedVariant.id, channelId: channel.id, tierPrices: [],
        }]]),
        availableQtyByVariantId: new Map([[storedVariant.id, Number(stock?.quantity ?? "0")]]),
      });
      if (projection) await upsertCatalogProjection(tx, projection, "PIM");
    }
  }
}

export class PgPimAdapter {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async listAuditHistory(limit = 10): Promise<readonly PimIngestionAuditEntry[]> {
    const { rows } = await this.pool.query<{ audit_json: string }>(
      "SELECT audit_json FROM pim_ingestions ORDER BY sequence DESC LIMIT $1", [limit],
    );
    return rows.map((row) => JSON.parse(row.audit_json) as PimIngestionAuditEntry);
  }

  async listMaterializedProjections(): Promise<readonly PimMaterializedCatalogProjection[]> {
    return (await readPimProjections(this.pool)).map(toPimProjection);
  }

  async listChannelProjections(
    channelSlug: string,
    seeds: readonly CatalogChannelProjectionRecord[],
  ): Promise<readonly CatalogChannelProjectionRecord[]> {
    const { rows } = await this.pool.query<{ slug: string }>(
      `SELECT slug FROM products WHERE pim_source IS NOT NULL
       AND slug IN (SELECT jsonb_array_elements_text($1::jsonb))`,
      [JSON.stringify(seeds.map((seed) => seed.productSlug))],
    );
    const managed = new Set(rows.map(({ slug }) => slug));
    const stored = await readPimProjections(this.pool, channelSlug);
    return [...seeds.filter((seed) => !managed.has(seed.productSlug)), ...stored.map(hydrateCatalogProjection)];
  }

  async previewSync(payload: PimIngestionPayload) {
    const { base } = await readContext(this.pool);
    const prepared = preparePimIngestion(payload, base);
    return prepared.ok
      ? { ok: true, issues: [], plan: prepared.plan, durationUs: prepared.durationUs }
      : prepared;
  }

  async ingestPimPayload(payload: PimIngestionPayload): Promise<PimIngestionResult> {
    validatePimEnvelope(payload);
    const start = process.hrtime.bigint();
    const payloadJson = serializeWithBigInt(payload);
    return this.pool.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [PIM_CATALOG_LOCK]);
      const { rows: [previous] } = await tx.query<{ same_payload: string; audit_json: string }>(
        `SELECT (payload_json = $3::jsonb)::text AS same_payload, audit_json
         FROM pim_ingestions WHERE system_source = $1 AND export_id = $2 AND accepted`,
        [payload.systemSource, payload.exportId, payloadJson],
      );
      if (previous) {
        if (previous.same_payload !== "true") {
          throw new PimCatalogConflictError(`Export '${payload.exportId}' was already accepted with different content`);
        }
        const projections = (await readPimProjections(tx, undefined, payload.products.map((product) => product.slug))).map(toPimProjection);
        return {
          ok: true,
          audit: {
            ...JSON.parse(previous.audit_json) as PimIngestionAuditEntry,
            status: "ZERO_DIFF_NOOP", diffPlan: { totalChanges: 0, entries: [] },
            durationUs: Math.round(Number(process.hrtime.bigint() - start) / 100) / 10,
            summary: "Export already applied. Current channel projections returned.",
            materializedProjectionsCount: projections.length,
          },
          materializedProjections: projections,
        };
      }

      const context = await readContext(tx);
      const prepared = preparePimIngestion(payload, context.base);
      let projections: PimMaterializedCatalogProjection[] = [];
      if (prepared.ok) {
        await writeCatalog(tx, payload, prepared.document, context);
        const state = serializeWithBigInt(prepared.document);
        await tx.query(
          `INSERT INTO store_config_state (config_key, revision, desired_config_json, remote_state_json)
           VALUES ($1, 1, $2::jsonb, $2::jsonb)
           ON CONFLICT (config_key) DO UPDATE SET revision = store_config_state.revision + 1,
             desired_config_json = EXCLUDED.desired_config_json,
             remote_state_json = EXCLUDED.remote_state_json, updated_at = now()`,
          [CONFIG_KEY, state],
        );
        projections = (await readPimProjections(tx, undefined, payload.products.map((product) => product.slug))).map(toPimProjection);
      }
      const audit: PimIngestionAuditEntry = {
        syncId: `pim_sync_${randomUUID()}`,
        systemSource: payload.systemSource,
        exportId: payload.exportId,
        status: prepared.ok ? "APPLIED" : "PREFLIGHT_BLOCKED",
        durationUs: Math.round(Number(process.hrtime.bigint() - start) / 100) / 10,
        familiesCount: payload.families.length,
        productsCount: payload.products.length,
        diffPlan: prepared.ok ? prepared.plan : undefined,
        issues: prepared.issues,
        summary: prepared.ok
          ? `Saved ${payload.products.length} PIM products and ${projections.length} channel projections to PostgreSQL`
          : `PIM ingestion blocked: ${prepared.issues.join("; ")}`,
        materializedProjectionsCount: projections.length,
        executedAtIso: new Date().toISOString(),
      };
      await tx.query(
        `INSERT INTO pim_ingestions (system_source, export_id, payload_json, accepted, audit_json)
         VALUES ($1, $2, $3::jsonb, $4, $5::jsonb)`,
        [payload.systemSource, payload.exportId, payloadJson, prepared.ok, JSON.stringify(audit)],
      );
      return { ok: prepared.ok, audit, materializedProjections: projections };
    });
  }
}
