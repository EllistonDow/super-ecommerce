import type { PgQueryable } from "./pg-pool.ts";
import type {
  CatalogChannelProjectionRecord,
  DynamicAttributesMap,
} from "./schema-types.ts";

export interface CatalogProjectionRow {
  channel_slug: string;
  product_id: string;
  product_slug: string;
  product_name: string;
  currency_code: string;
  min_effective_price: string;
  max_effective_price: string;
  is_in_stock: string;
  total_available_qty: string;
  merged_attributes: string;
  variants_snapshot: string;
}

export const CATALOG_PROJECTION_COLUMNS = `
  channel_slug, product_id::text, product_slug, product_name, TRIM(currency_code) AS currency_code,
  min_effective_price::text, max_effective_price::text, is_in_stock::text,
  total_available_qty::text, merged_attributes::text, variants_snapshot::text
`;

export function hydrateCatalogProjection(row: CatalogProjectionRow): CatalogChannelProjectionRecord {
  const snapshots = JSON.parse(row.variants_snapshot || "[]") as {
    variantId: string;
    sku: string;
    name: string;
    effectivePrice: string;
    compareAtAmount?: string;
    availableQuantity?: number;
    availableQty?: number;
    isInStock?: boolean;
    attributes?: DynamicAttributesMap;
  }[];
  return {
    channelSlug: row.channel_slug,
    productId: row.product_id,
    productSlug: row.product_slug,
    productName: row.product_name,
    currencyCode: row.currency_code,
    minEffectivePrice: BigInt(row.min_effective_price || "0"),
    maxEffectivePrice: BigInt(row.max_effective_price || "0"),
    isInStock: row.is_in_stock === "true" || row.is_in_stock === "t",
    totalAvailableQty: Number(row.total_available_qty || "0"),
    mergedAttributes: JSON.parse(row.merged_attributes || "{}") as CatalogChannelProjectionRecord["mergedAttributes"],
    variantsSnapshot: snapshots.map((variant) => {
      const availableQuantity = Number(variant.availableQuantity ?? variant.availableQty ?? 0);
      return {
        variantId: variant.variantId,
        sku: variant.sku,
        name: variant.name,
        effectivePrice: BigInt(variant.effectivePrice || "0"),
        compareAtAmount: variant.compareAtAmount ? BigInt(variant.compareAtAmount) : undefined,
        availableQuantity,
        isInStock: variant.isInStock ?? availableQuantity > 0,
        attributes: variant.attributes ?? {},
      };
    }),
  };
}

/** Demo and external read-model seeds must yield to a PIM-managed product. */
export async function upsertCatalogProjection(
  client: PgQueryable,
  projection: CatalogChannelProjectionRecord,
  source: "PIM" | "SEED",
): Promise<void> {
  const variants = projection.variantsSnapshot.map((variant) => ({
    ...variant,
    effectivePrice: variant.effectivePrice.toString(),
    compareAtAmount: variant.compareAtAmount?.toString(),
  }));
  await client.query(
    `INSERT INTO catalog_channel_projections (
       channel_slug, product_id, product_slug, product_name, currency_code,
       min_effective_price, max_effective_price, is_in_stock, total_available_qty,
       merged_attributes, variants_snapshot
     ) SELECT $1, $2::uuid, $3, $4, $5, $6::bigint, $7::bigint, $8::boolean,
              $9::integer, $10::jsonb, $11::jsonb
       WHERE $12::boolean OR NOT EXISTS (
         SELECT 1 FROM products p WHERE p.slug = $3 AND to_jsonb(p)->>'pim_source' IS NOT NULL
       )
     ON CONFLICT (channel_slug, product_id) DO UPDATE SET
       product_slug = EXCLUDED.product_slug,
       product_name = EXCLUDED.product_name,
       currency_code = EXCLUDED.currency_code,
       min_effective_price = EXCLUDED.min_effective_price,
       max_effective_price = EXCLUDED.max_effective_price,
       is_in_stock = EXCLUDED.is_in_stock,
       total_available_qty = EXCLUDED.total_available_qty,
       merged_attributes = EXCLUDED.merged_attributes,
       variants_snapshot = EXCLUDED.variants_snapshot,
       updated_at = now()
     WHERE $12::boolean OR NOT EXISTS (
       SELECT 1 FROM products p WHERE p.slug = EXCLUDED.product_slug AND to_jsonb(p)->>'pim_source' IS NOT NULL
     )`,
    [
      projection.channelSlug, projection.productId, projection.productSlug,
      projection.productName, projection.currencyCode, projection.minEffectivePrice,
      projection.maxEffectivePrice, projection.isInStock, projection.totalAvailableQty,
      projection.mergedAttributes, variants, source === "PIM",
    ],
  );
}
