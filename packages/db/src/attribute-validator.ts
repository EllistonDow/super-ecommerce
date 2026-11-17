/**
 * Strongly-typed `ProductType` JSONB Attribute Validator & CQRS Projection Builder.
 *
 * Replaces Magento's 20-table EAV model with application-enforced JSON Schema validation
 * backed by PostgreSQL 17 `JSONB` + `GIN (jsonb_path_ops)` indexing.
 */

import type { MinorUnits } from "@super-ecommerce/kernel";
import { applyBps } from "@super-ecommerce/kernel";
import type {
  AttributeDefinition,
  CatalogChannelProjectionRecord,
  ChannelRecord,
  DynamicAttributesMap,
  ProductRecord,
  ProductVariantRecord,
  VariantChannelListingRecord,
  VariantProjectionSnapshot,
} from "./schema-types.ts";

export interface AttributeValidationError {
  readonly attributeSlug: string;
  readonly message: string;
}

export interface AttributeValidationResult {
  readonly valid: boolean;
  readonly errors: readonly AttributeValidationError[];
}

/**
 * Validates a `DynamicAttributesMap` against a `ProductType` attribute schema definition.
 */
export function validateDynamicAttributes(
  schema: readonly AttributeDefinition[],
  attributes: DynamicAttributesMap
): AttributeValidationResult {
  const errors: AttributeValidationError[] = [];
  const schemaBySlug = new Map<string, AttributeDefinition>();

  for (const def of schema) {
    schemaBySlug.set(def.slug, def);
    const val = attributes[def.slug];

    if (val === undefined || val === null) {
      if (def.required) {
        errors.push({
          attributeSlug: def.slug,
          message: `Required attribute '${def.slug}' is missing.`,
        });
      }
      continue;
    }

    switch (def.type) {
      case "TEXT": {
        if (typeof val !== "string" || val.trim().length === 0) {
          errors.push({
            attributeSlug: def.slug,
            message: `Attribute '${def.slug}' must be a non-empty string.`,
          });
        }
        break;
      }
      case "BOOLEAN": {
        if (typeof val !== "boolean") {
          errors.push({
            attributeSlug: def.slug,
            message: `Attribute '${def.slug}' must be a boolean.`,
          });
        }
        break;
      }
      case "NUMBER": {
        if (typeof val !== "number" || !Number.isFinite(val)) {
          errors.push({
            attributeSlug: def.slug,
            message: `Attribute '${def.slug}' must be a finite number.`,
          });
        } else {
          if (def.minNumber !== undefined && val < def.minNumber) {
            errors.push({
              attributeSlug: def.slug,
              message: `Attribute '${def.slug}' (${val}) is below minimum ${def.minNumber}.`,
            });
          }
          if (def.maxNumber !== undefined && val > def.maxNumber) {
            errors.push({
              attributeSlug: def.slug,
              message: `Attribute '${def.slug}' (${val}) exceeds maximum ${def.maxNumber}.`,
            });
          }
        }
        break;
      }
      case "ENUM": {
        if (
          typeof val !== "string" ||
          (def.allowedValues && !def.allowedValues.includes(val))
        ) {
          errors.push({
            attributeSlug: def.slug,
            message: `Attribute '${def.slug}' must be one of [${(def.allowedValues ?? []).join(", ")}].`,
          });
        }
        break;
      }
      case "MULTI_ENUM": {
        if (
          !Array.isArray(val) ||
          val.some(
            (item) =>
              typeof item !== "string" ||
              (def.allowedValues !== undefined && !def.allowedValues.includes(item))
          )
        ) {
          errors.push({
            attributeSlug: def.slug,
            message: `Attribute '${def.slug}' must be an array of allowed values [${(def.allowedValues ?? []).join(", ")}].`,
          });
        }
        break;
      }
    }
  }

  for (const key of Object.keys(attributes)) {
    if (!schemaBySlug.has(key)) {
      errors.push({
        attributeSlug: key,
        message: `Unknown attribute '${key}' is not declared on this ProductType.`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export interface BuildProjectionInput {
  readonly channel: ChannelRecord;
  readonly product: ProductRecord;
  readonly variants: readonly ProductVariantRecord[];
  readonly listingsByVariantId: ReadonlyMap<string, VariantChannelListingRecord>;
  readonly availableQtyByVariantId: ReadonlyMap<string, number>;
  readonly activeCatalogueDiscountBps?: number;
}

/**
 * Builds the zero-JOIN `CatalogChannelProjectionRecord` for fast storefront PLP/PDP reads.
 * Returns `null` if no variant is published in the target channel.
 */
export function buildCatalogChannelProjection(
  input: BuildProjectionInput
): CatalogChannelProjectionRecord | null {
  const discountBps = input.activeCatalogueDiscountBps ?? 0;
  const variantSnapshots: VariantProjectionSnapshot[] = [];
  const mergedMap = new Map<string, Set<string | number | boolean>>();

  const addAttributeToMerged = (key: string, value: unknown) => {
    let set = mergedMap.get(key);
    if (!set) {
      set = new Set();
      mergedMap.set(key, set);
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
          set.add(item);
        }
      }
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      set.add(value);
    }
  };

  for (const [k, v] of Object.entries(input.product.attributes)) {
    addAttributeToMerged(k, v);
  }

  for (const variant of input.variants) {
    const listing = input.listingsByVariantId.get(variant.id);
    if (!listing || !listing.isPublished || listing.channelId !== input.channel.id) {
      continue;
    }

    const discountAmount =
      discountBps > 0 ? applyBps(listing.priceAmount, discountBps) : 0n;
    const effectivePrice = listing.priceAmount - discountAmount;
    const availableQty = Math.max(0, input.availableQtyByVariantId.get(variant.id) ?? 0);

    for (const [k, v] of Object.entries(variant.attributes)) {
      addAttributeToMerged(k, v);
    }

    variantSnapshots.push({
      variantId: variant.id,
      sku: variant.sku,
      name: variant.name,
      effectivePrice,
      compareAtAmount:
        discountAmount > 0n ? listing.priceAmount : listing.compareAtAmount,
      availableQuantity: availableQty,
      isInStock: availableQty > 0,
      attributes: variant.attributes,
    });
  }

  if (variantSnapshots.length === 0) {
    return null;
  }

  let minPrice: MinorUnits = variantSnapshots[0]!.effectivePrice;
  let maxPrice: MinorUnits = variantSnapshots[0]!.effectivePrice;
  let totalAvail = 0;

  for (const snap of variantSnapshots) {
    if (snap.effectivePrice < minPrice) minPrice = snap.effectivePrice;
    if (snap.effectivePrice > maxPrice) maxPrice = snap.effectivePrice;
    totalAvail += snap.availableQuantity;
  }

  const mergedAttributes: Record<string, readonly (string | number | boolean)[]> = {};
  for (const [k, set] of mergedMap.entries()) {
    mergedAttributes[k] = Array.from(set);
  }

  return {
    channelSlug: input.channel.slug,
    productId: input.product.id,
    productSlug: input.product.slug,
    productName: input.product.name,
    currencyCode: input.channel.currencyCode,
    minEffectivePrice: minPrice,
    maxEffectivePrice: maxPrice,
    isInStock: totalAvail > 0,
    totalAvailableQty: totalAvail,
    mergedAttributes,
    variantsSnapshot: variantSnapshots,
  };
}
