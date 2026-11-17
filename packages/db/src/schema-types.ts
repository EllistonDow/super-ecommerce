/**
 * Core database & domain schema types for `@super-ecommerce/db`.
 */

import type { MinorUnits, PriceTier, TaxInclusionMode } from "@super-ecommerce/kernel";

export type StockAvailabilityMode =
  | "DIRECT_CHANNEL_WAREHOUSES"
  | "SHIPPING_ZONE_INTERSECTION";

export type AllocationStrategy =
  | "PRIORITIZE_RANK_ORDER"
  | "MINIMIZE_SPLIT_THEN_HIGH_STOCK";

export interface ChannelRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly currencyCode: string;
  readonly defaultCountry: string;
  readonly taxInclusionMode: TaxInclusionMode;
  readonly stockAvailabilityMode: StockAvailabilityMode;
  readonly allocationStrategy: AllocationStrategy;
  readonly reservationTtlSeconds: number;
  readonly isActive: boolean;
}

export type AttributeInputType =
  | "TEXT"
  | "NUMBER"
  | "BOOLEAN"
  | "ENUM"
  | "MULTI_ENUM";

export interface AttributeDefinition {
  readonly slug: string;
  readonly name: string;
  readonly type: AttributeInputType;
  readonly required: boolean;
  readonly filterable?: boolean;
  readonly allowedValues?: readonly string[];
  readonly minNumber?: number;
  readonly maxNumber?: number;
}

export interface ProductTypeRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly isShippingRequired: boolean;
  readonly isDigital: boolean;
  readonly productAttributesSchema: readonly AttributeDefinition[];
  readonly variantAttributesSchema: readonly AttributeDefinition[];
}

export type DynamicAttributeValue =
  | string
  | number
  | boolean
  | readonly string[];

export type DynamicAttributesMap = Readonly<Record<string, DynamicAttributeValue>>;

export interface ProductRecord {
  readonly id: string;
  readonly productTypeId: string;
  readonly slug: string;
  readonly name: string;
  readonly attributes: DynamicAttributesMap;
}

export interface ProductVariantRecord {
  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly weightGrams?: number;
  readonly attributes: DynamicAttributesMap;
}

export interface VariantChannelListingRecord {
  readonly variantId: string;
  readonly channelId: string;
  readonly isPublished: boolean;
  readonly priceAmount: MinorUnits;
  readonly compareAtAmount?: MinorUnits;
  readonly costAmount?: MinorUnits;
  readonly tierPrices: readonly PriceTier[];
}

export interface VariantProjectionSnapshot {
  readonly variantId: string;
  readonly sku: string;
  readonly name: string;
  readonly effectivePrice: MinorUnits;
  readonly compareAtAmount?: MinorUnits;
  readonly availableQuantity: number;
  readonly isInStock: boolean;
  readonly attributes: DynamicAttributesMap;
}

export interface CatalogChannelProjectionRecord {
  readonly channelSlug: string;
  readonly productId: string;
  readonly productSlug: string;
  readonly productName: string;
  readonly currencyCode: string;
  readonly minEffectivePrice: MinorUnits;
  readonly maxEffectivePrice: MinorUnits;
  readonly isInStock: boolean;
  readonly totalAvailableQty: number;
  readonly mergedAttributes: Readonly<Record<string, readonly (string | number | boolean)[]>>;
  readonly variantsSnapshot: readonly VariantProjectionSnapshot[];
}
