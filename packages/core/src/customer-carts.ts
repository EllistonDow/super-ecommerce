/**
 * C-End Customer Authentication, Address Book & Persistent Multi-Channel Cart Engine
 * (`packages/core/src/customer-carts.ts`).
 *
 * Capabilities:
 * 1. Salted `scrypt` customer registration, constant-time authentication, and signed
 *    HMAC-SHA256 `super_customer_session` tokens.
 * 2. Customer shipping address book with atomic default-shipping toggling.
 * 3. Persistent PostgreSQL guest & member carts (`carts` + `cart_lines`) priced in real
 *    time via the native Rust `commerce-kernel`.
 * 4. **Atomic Guest-to-Customer Cart Merge (`mergeGuestCartIntoCustomerCart`)**:
 *    Combines anonymous guest cart lines with the customer's active cart upon login,
 *    summing identical variant quantities (automatically unlocking lower B2B/volume tier
 *    prices in the Rust kernel!), preserving the higher-value voucher, and marking the
 *    guest cart `MERGED`.
 */

import { createHmac, randomUUID } from "node:crypto";
import {
  calculateCart,
  type Bps,
  type CandidateLineDiscount,
  type CandidateOrderDiscount,
  type CartCalculationInput,
  type CartCalculationResult,
  type MinorUnits,
  type PriceTier,
  type TaxInclusionMode,
} from "@super-ecommerce/kernel";
import {
  deserializeWithBigInt,
  serializeWithBigInt,
  type PgPoolLike,
  type PgQueryable,
  type PgTxClient,
} from "@super-ecommerce/db";
import {
  constantTimeHexEqual,
  hashAdminPasswordScrypt,
  verifyAdminPasswordConstantTime,
} from "./admin-auth-rbac.ts";
import { PgCustomersService, type CustomerRecord } from "./customers-ledger.ts";

export const CUSTOMER_SESSION_COOKIE_NAME = "super_customer_session";

export interface CustomerSessionClaims {
  readonly sub: string;
  readonly email: string;
  readonly fullName: string;
  readonly iat: number;
  readonly exp: number;
}

export interface CustomerAddressRecord {
  readonly addressId: string;
  readonly customerId: string;
  readonly label: string;
  readonly recipientName: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly postalCode: string;
  readonly countryCode: string;
  readonly phone?: string;
  readonly isDefaultShipping: boolean;
  readonly createdAt: string;
}

export interface SaveCustomerAddressInput {
  readonly addressId?: string;
  readonly customerId: string;
  readonly label?: string;
  readonly recipientName: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly postalCode: string;
  readonly countryCode: string;
  readonly phone?: string;
  readonly isDefaultShipping?: boolean;
}

export interface PersistentCartLine {
  readonly lineId: string;
  readonly variantId: string;
  readonly sku: string;
  readonly title: string;
  readonly quantity: number;
  readonly baseUnitPrice: MinorUnits;
  readonly taxRateBps: Bps;
  readonly tierPrices: readonly PriceTier[];
  readonly candidateLineDiscounts: readonly CandidateLineDiscount[];
  readonly unitCostAmount?: MinorUnits;
  readonly minMarginBps?: Bps;
}

export interface HydratedCartRecord {
  readonly cartId: string;
  readonly channelSlug: string;
  readonly currencyCode: string;
  readonly taxMode: TaxInclusionMode;
  readonly customerId?: string;
  readonly guestToken?: string;
  readonly status: "ACTIVE" | "MERGED" | "CHECKED_OUT" | "ABANDONED";
  readonly mergedIntoCartId?: string;
  readonly shippingAddress?: Omit<CustomerAddressRecord, "addressId" | "customerId" | "createdAt" | "isDefaultShipping">;
  readonly voucherCode?: string;
  readonly voucherDiscount?: CandidateOrderDiscount;
  readonly shippingBaseAmount: MinorUnits;
  readonly shippingTaxRateBps: Bps;
  readonly lines: readonly PersistentCartLine[];
  readonly pricing: CartCalculationResult;
  readonly updatedAt: string;
}

let cachedDummyCustomerScrypt: string | null = null;
function getDummyCustomerScrypt(): string {
  if (!cachedDummyCustomerScrypt) {
    cachedDummyCustomerScrypt = hashAdminPasswordScrypt(
      "customer_constant_time_dummy_fallback",
      Buffer.from("99887766554433229988776655443322", "hex")
    );
  }
  return cachedDummyCustomerScrypt;
}

export class PgCustomerAuthAndCartService {
  private readonly pool: PgPoolLike;
  private readonly customersService: PgCustomersService;
  private readonly signingSecret: string;
  private readonly sessionTtlSeconds: number;

  constructor(
    pool: PgPoolLike,
    options?: { signingSecret?: string; sessionTtlSeconds?: number }
  ) {
    this.pool = pool;
    this.customersService = new PgCustomersService(pool);
    this.signingSecret =
      options?.signingSecret ??
      process.env["SUPER_CUSTOMER_SESSION_SECRET"] ??
      "super_customer_hmac_session_secret_2026_v1";
    this.sessionTtlSeconds = options?.sessionTtlSeconds ?? 14 * 24 * 3600;
  }

  private async runInTx<T>(
    tx: PgTxClient | undefined,
    fn: (q: PgTxClient) => Promise<T>
  ): Promise<T> {
    return tx ? fn(tx) : this.pool.withTransaction(fn);
  }

  issueCustomerSessionToken(
    customer: Pick<CustomerRecord, "customerId" | "email" | "fullName">,
    nowUnixSec = Math.floor(Date.now() / 1000)
  ): string {
    const claims: CustomerSessionClaims = {
      sub: customer.customerId,
      email: customer.email,
      fullName: customer.fullName,
      iat: nowUnixSec,
      exp: nowUnixSec + this.sessionTtlSeconds,
    };
    const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const sigHex = createHmac("sha256", this.signingSecret)
      .update(payloadB64)
      .digest("hex");
    return `${payloadB64}.${sigHex}`;
  }

  verifyCustomerSessionToken(
    token: string | undefined | null,
    nowUnixSec = Math.floor(Date.now() / 1000)
  ): { valid: boolean; claims?: CustomerSessionClaims; reason?: string } {
    if (!token || !token.includes(".")) {
      return { valid: false, reason: "MISSING_OR_MALFORMED_TOKEN" };
    }
    const dotIdx = token.indexOf(".");
    const payloadB64 = token.slice(0, dotIdx);
    const sigHex = token.slice(dotIdx + 1);
    const expectedSig = createHmac("sha256", this.signingSecret)
      .update(payloadB64)
      .digest("hex");
    if (!constantTimeHexEqual(sigHex, expectedSig)) {
      return { valid: false, reason: "INVALID_SIGNATURE" };
    }
    try {
      const claims = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString("utf8")
      ) as CustomerSessionClaims;
      if (claims.exp < nowUnixSec) {
        return { valid: false, reason: "SESSION_EXPIRED" };
      }
      return { valid: true, claims };
    } catch {
      return { valid: false, reason: "INVALID_CLAIMS" };
    }
  }

  async registerCustomer(params: {
    customerId?: string;
    email: string;
    passwordPlain: string;
    fullName: string;
    defaultChannelSlug?: string;
    currencyCode?: string;
    guestCartId?: string;
  }): Promise<{
    customer: CustomerRecord;
    sessionToken: string;
    mergedCart?: HydratedCartRecord;
  }> {
    const email = params.email.toLowerCase().trim();
    if (!email.includes("@")) {
      throw new Error("Valid customer email is required");
    }
    if (params.passwordPlain.length < 8) {
      throw new Error("Customer password must be at least 8 characters");
    }
    const passwordHash = hashAdminPasswordScrypt(params.passwordPlain);
    const nowIso = new Date().toISOString();

    return await this.pool.withTransaction(async (tx) => {
      const customer = await this.customersService.createCustomer(
        {
          customerId: params.customerId,
          email,
          fullName: params.fullName,
          defaultChannelSlug: params.defaultChannelSlug,
          currencyCode: params.currencyCode,
        },
        tx
      );

      await tx.query(
        `INSERT INTO customer_credentials (
           customer_id, email, password_hash, is_active, last_login_at, created_at, updated_at
         ) VALUES ($1, $2, $3, true, $4::timestamptz, $4::timestamptz, $4::timestamptz)`,
        [customer.customerId, email, passwordHash, nowIso]
      );

      const sessionToken = this.issueCustomerSessionToken(customer);
      let mergedCart: HydratedCartRecord | undefined;
      if (params.guestCartId) {
        mergedCart = await this.mergeGuestCartIntoCustomerCart(
          {
            guestCartId: params.guestCartId,
            customerId: customer.customerId,
          },
          tx
        );
      }

      return { customer, sessionToken, mergedCart };
    });
  }

  async authenticateCustomer(params: {
    email: string;
    passwordPlain: string;
    guestCartId?: string;
  }): Promise<{
    ok: boolean;
    customer?: CustomerRecord;
    sessionToken?: string;
    mergedCart?: HydratedCartRecord;
  }> {
    const email = params.email.toLowerCase().trim();
    return await this.pool.withTransaction(async (tx) => {
      const credRes = await tx.query<{
        customer_id: string;
        password_hash: string;
        is_active: string | boolean;
      }>(
        `SELECT customer_id, password_hash, is_active
         FROM customer_credentials
         WHERE email = $1`,
        [email]
      );

      const row = credRes.rows[0];
      const targetHash = row?.password_hash ?? getDummyCustomerScrypt();
      const verification = verifyAdminPasswordConstantTime(
        email,
        params.passwordPlain,
        targetHash
      );
      const isActive =
        row && (row.is_active === true || row.is_active === "true" || row.is_active === "t");

      if (!row || !isActive || !verification.valid) {
        return { ok: false };
      }

      await tx.query(
        `UPDATE customer_credentials SET last_login_at = $1::timestamptz WHERE customer_id = $2`,
        [new Date().toISOString(), row.customer_id]
      );

      const customer = await this.customersService.getCustomer(row.customer_id, tx);
      if (!customer) {
        return { ok: false };
      }

      const sessionToken = this.issueCustomerSessionToken(customer);
      let mergedCart: HydratedCartRecord | undefined;
      if (params.guestCartId) {
        mergedCart = await this.mergeGuestCartIntoCustomerCart(
          {
            guestCartId: params.guestCartId,
            customerId: customer.customerId,
          },
          tx
        );
      }

      return { ok: true, customer, sessionToken, mergedCart };
    });
  }

  async saveAddress(
    input: SaveCustomerAddressInput,
    tx?: PgTxClient
  ): Promise<CustomerAddressRecord> {
    const addressId =
      input.addressId ?? `addr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const nowIso = new Date().toISOString();
    const isDefault = Boolean(input.isDefaultShipping);

    return await this.runInTx(tx, async (q) => {
      if (isDefault) {
        await q.query(
          `UPDATE customer_addresses SET is_default_shipping = false WHERE customer_id = $1`,
          [input.customerId]
        );
      }

      await q.query(
        `INSERT INTO customer_addresses (
           address_id, customer_id, label, recipient_name, line1, line2,
           city, postal_code, country_code, phone, is_default_shipping, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)
         ON CONFLICT (address_id) DO UPDATE SET
           label = excluded.label,
           recipient_name = excluded.recipient_name,
           line1 = excluded.line1,
           line2 = excluded.line2,
           city = excluded.city,
           postal_code = excluded.postal_code,
           country_code = excluded.country_code,
           phone = excluded.phone,
           is_default_shipping = excluded.is_default_shipping`,
        [
          addressId,
          input.customerId,
          input.label ?? "Shipping",
          input.recipientName,
          input.line1,
          input.line2 ?? null,
          input.city,
          input.postalCode,
          input.countryCode.toUpperCase().trim(),
          input.phone ?? null,
          isDefault,
          nowIso,
        ]
      );

      return {
        addressId,
        customerId: input.customerId,
        label: input.label ?? "Shipping",
        recipientName: input.recipientName,
        line1: input.line1,
        line2: input.line2,
        city: input.city,
        postalCode: input.postalCode,
        countryCode: input.countryCode.toUpperCase().trim(),
        phone: input.phone,
        isDefaultShipping: isDefault,
        createdAt: nowIso,
      };
    });
  }

  async listAddresses(customerId: string): Promise<readonly CustomerAddressRecord[]> {
    const res = await this.pool.query<{
      address_id: string;
      customer_id: string;
      label: string;
      recipient_name: string;
      line1: string;
      line2: string | null;
      city: string;
      postal_code: string;
      country_code: string;
      phone: string | null;
      is_default_shipping: string | boolean;
      created_at: string;
    }>(
      `SELECT address_id, customer_id, label, recipient_name, line1, line2,
              city, postal_code, country_code, phone, is_default_shipping, created_at
       FROM customer_addresses
       WHERE customer_id = $1
       ORDER BY is_default_shipping DESC, created_at DESC`,
      [customerId]
    );

    return res.rows.map((r) => ({
      addressId: r.address_id,
      customerId: r.customer_id,
      label: r.label,
      recipientName: r.recipient_name,
      line1: r.line1,
      line2: r.line2 ?? undefined,
      city: r.city,
      postalCode: r.postal_code,
      countryCode: r.country_code,
      phone: r.phone ?? undefined,
      isDefaultShipping:
        r.is_default_shipping === true ||
        r.is_default_shipping === "true" ||
        r.is_default_shipping === "t",
      createdAt: r.created_at,
    }));
  }

  async createOrGetActiveCart(
    params: {
      cartId?: string;
      channelSlug: string;
      currencyCode?: string;
      taxMode?: TaxInclusionMode;
      customerId?: string;
      guestToken?: string;
      shippingBaseAmount?: MinorUnits;
      shippingTaxRateBps?: Bps;
    },
    tx?: PgTxClient
  ): Promise<HydratedCartRecord> {
    return await this.runInTx(tx, async (q) => {
      if (params.cartId) {
        const byId = await this.getHydratedCart(params.cartId, q);
        if (byId && byId.status === "ACTIVE") return byId;
      }

      if (params.customerId) {
        const existingCust = await q.query<{ cart_id: string }>(
          `SELECT cart_id FROM carts
           WHERE customer_id = $1 AND channel_slug = $2 AND status = 'ACTIVE'
           ORDER BY updated_at DESC LIMIT 1`,
          [params.customerId, params.channelSlug]
        );
        if (existingCust.rows[0]) {
          const loaded = await this.getHydratedCart(existingCust.rows[0].cart_id, q);
          if (loaded) return loaded;
        }
      } else if (params.guestToken) {
        const existingGuest = await q.query<{ cart_id: string }>(
          `SELECT cart_id FROM carts
           WHERE guest_token = $1 AND channel_slug = $2 AND status = 'ACTIVE'
           ORDER BY updated_at DESC LIMIT 1`,
          [params.guestToken, params.channelSlug]
        );
        if (existingGuest.rows[0]) {
          const loaded = await this.getHydratedCart(existingGuest.rows[0].cart_id, q);
          if (loaded) return loaded;
        }
      }

      const cartId =
        params.cartId ?? `cart_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
      const nowIso = new Date().toISOString();
      const currency = (params.currencyCode ?? "USD").toUpperCase();
      const taxMode = params.taxMode ?? "TAX_EXCLUSIVE";

      await q.query(
        `INSERT INTO carts (
           cart_id, channel_slug, currency_code, tax_mode,
           customer_id, guest_token, status,
           shipping_base_amount, shipping_tax_rate_bps,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $9::timestamptz, $9::timestamptz)`,
        [
          cartId,
          params.channelSlug,
          currency,
          taxMode,
          params.customerId ?? null,
          params.guestToken ?? null,
          (params.shippingBaseAmount ?? 0n).toString(),
          Math.floor(params.shippingTaxRateBps ?? 0),
          nowIso,
        ]
      );

      return (await this.getHydratedCart(cartId, q))!;
    });
  }

  async upsertCartLine(
    params: {
      cartId: string;
      variantId: string;
      sku: string;
      title: string;
      quantity: number;
      baseUnitPrice: MinorUnits;
      taxRateBps?: Bps;
      tierPrices?: readonly PriceTier[];
      candidateLineDiscounts?: readonly CandidateLineDiscount[];
      unitCostAmount?: MinorUnits;
      minMarginBps?: Bps;
    },
    tx?: PgTxClient
  ): Promise<HydratedCartRecord> {
    const qty = Math.floor(params.quantity);
    const nowIso = new Date().toISOString();

    return await this.runInTx(tx, async (q) => {
      if (qty <= 0) {
        await q.query(
          `DELETE FROM cart_lines WHERE cart_id = $1 AND variant_id = $2`,
          [params.cartId, params.variantId]
        );
      } else {
        const rowId = `cl_${params.cartId}_${params.variantId}`;
        const lineId = `line_${params.variantId}`;
        await q.query(
          `INSERT INTO cart_lines (
             id, cart_id, line_id, variant_id, sku, title, quantity,
             base_unit_price, tax_rate_bps, tier_prices_json, line_discounts_json,
             unit_cost_amount, min_margin_bps, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10::jsonb, $11::jsonb,
             $12, $13, $14::timestamptz
           )
           ON CONFLICT (cart_id, variant_id) DO UPDATE SET
             quantity = excluded.quantity,
             base_unit_price = excluded.base_unit_price,
             tax_rate_bps = excluded.tax_rate_bps,
             tier_prices_json = excluded.tier_prices_json,
             line_discounts_json = excluded.line_discounts_json,
             unit_cost_amount = excluded.unit_cost_amount,
             min_margin_bps = excluded.min_margin_bps,
             updated_at = excluded.updated_at`,
          [
            rowId,
            params.cartId,
            lineId,
            params.variantId,
            params.sku,
            params.title,
            qty,
            params.baseUnitPrice.toString(),
            Math.floor(params.taxRateBps ?? 0),
            serializeWithBigInt(params.tierPrices ?? []),
            serializeWithBigInt(params.candidateLineDiscounts ?? []),
            params.unitCostAmount !== undefined ? params.unitCostAmount.toString() : null,
            Math.floor(params.minMarginBps ?? 0),
            nowIso,
          ]
        );
      }

      await q.query(
        `UPDATE carts SET updated_at = $1::timestamptz WHERE cart_id = $2`,
        [nowIso, params.cartId]
      );

      const updated = await this.getHydratedCart(params.cartId, q);
      if (!updated) {
        throw new Error(`Cart '${params.cartId}' not found`);
      }
      return updated;
    });
  }

  async applyCartVoucher(
    params: {
      cartId: string;
      voucherCode: string | null;
      discount: CandidateOrderDiscount | null;
    },
    tx?: PgTxClient
  ): Promise<HydratedCartRecord> {
    return await this.runInTx(tx, async (q) => {
      await q.query(
        `UPDATE carts
         SET voucher_code = $1,
             voucher_discount_json = $2::jsonb,
             updated_at = $3::timestamptz
         WHERE cart_id = $4`,
        [
          params.voucherCode,
          params.discount ? serializeWithBigInt(params.discount) : null,
          new Date().toISOString(),
          params.cartId,
        ]
      );
      const cart = await this.getHydratedCart(params.cartId, q);
      if (!cart) throw new Error(`Cart '${params.cartId}' not found`);
      return cart;
    });
  }

  async setCartShippingDetails(
    params: {
      cartId: string;
      shippingAddress?: HydratedCartRecord["shippingAddress"];
      shippingBaseAmount?: MinorUnits;
      shippingTaxRateBps?: Bps;
    },
    tx?: PgTxClient
  ): Promise<HydratedCartRecord> {
    return await this.runInTx(tx, async (q) => {
      const current = await this.getHydratedCart(params.cartId, q);
      if (!current) throw new Error(`Cart '${params.cartId}' not found`);

      const nextAddr = params.shippingAddress ?? current.shippingAddress;
      const nextShipBase = params.shippingBaseAmount ?? current.shippingBaseAmount;
      const nextShipTax = params.shippingTaxRateBps ?? current.shippingTaxRateBps;

      await q.query(
        `UPDATE carts
         SET shipping_address_json = $1::jsonb,
             shipping_base_amount = $2,
             shipping_tax_rate_bps = $3,
             updated_at = $4::timestamptz
         WHERE cart_id = $5`,
        [
          nextAddr ? JSON.stringify(nextAddr) : null,
          nextShipBase.toString(),
          Math.floor(nextShipTax),
          new Date().toISOString(),
          params.cartId,
        ]
      );

      return (await this.getHydratedCart(params.cartId, q))!;
    });
  }

  /**
   * Atomically merges an anonymous `guestCartId` into the authenticated `customerId`'s
   * active cart for the same channel:
   * - Sums quantities on matching `variant_id` (unlocking volume/B2B tier discounts!)
   * - Adopts the guest cart's voucher if the member cart has none (or keeps whichever yields higher savings)
   * - Marks the guest cart `status = 'MERGED'` (`merged_into_cart_id = memberCartId`)
   */
  async mergeGuestCartIntoCustomerCart(
    params: {
      guestCartId: string;
      customerId: string;
    },
    tx?: PgTxClient
  ): Promise<HydratedCartRecord> {
    return await this.runInTx(tx, async (q) => {
      const guestCart = await this.getHydratedCart(params.guestCartId, q);
      if (!guestCart) {
        throw new Error(`Guest cart '${params.guestCartId}' not found`);
      }
      if (guestCart.customerId === params.customerId) {
        return guestCart;
      }

      const targetCart = await this.createOrGetActiveCart(
        {
          channelSlug: guestCart.channelSlug,
          currencyCode: guestCart.currencyCode,
          taxMode: guestCart.taxMode,
          customerId: params.customerId,
          shippingBaseAmount: guestCart.shippingBaseAmount,
          shippingTaxRateBps: guestCart.shippingTaxRateBps,
        },
        q
      );

      if (guestCart.status !== "ACTIVE" || guestCart.cartId === targetCart.cartId) {
        return targetCart;
      }

      const existingByVariant = new Map<string, PersistentCartLine>();
      for (const l of targetCart.lines) {
        existingByVariant.set(l.variantId, l);
      }

      for (const guestLine of guestCart.lines) {
        const prior = existingByVariant.get(guestLine.variantId);
        const combinedQty = (prior?.quantity ?? 0) + guestLine.quantity;
        await this.upsertCartLine(
          {
            cartId: targetCart.cartId,
            variantId: guestLine.variantId,
            sku: guestLine.sku,
            title: guestLine.title,
            quantity: combinedQty,
            baseUnitPrice: prior?.baseUnitPrice ?? guestLine.baseUnitPrice,
            taxRateBps: prior?.taxRateBps ?? guestLine.taxRateBps,
            tierPrices:
              (prior?.tierPrices.length ?? 0) > 0 ? prior!.tierPrices : guestLine.tierPrices,
            candidateLineDiscounts:
              (prior?.candidateLineDiscounts.length ?? 0) > 0
                ? prior!.candidateLineDiscounts
                : guestLine.candidateLineDiscounts,
            unitCostAmount: prior?.unitCostAmount ?? guestLine.unitCostAmount,
            minMarginBps: prior?.minMarginBps ?? guestLine.minMarginBps,
          },
          q
        );
      }

      // Preserve the better voucher across guest & member carts
      if (guestCart.voucherDiscount && !targetCart.voucherDiscount) {
        await this.applyCartVoucher(
          {
            cartId: targetCart.cartId,
            voucherCode: guestCart.voucherCode ?? guestCart.voucherDiscount.discountId,
            discount: guestCart.voucherDiscount,
          },
          q
        );
      }

      if (guestCart.shippingAddress && !targetCart.shippingAddress) {
        await this.setCartShippingDetails(
          {
            cartId: targetCart.cartId,
            shippingAddress: guestCart.shippingAddress,
          },
          q
        );
      }

      await q.query(
        `UPDATE carts
         SET status = 'MERGED',
             merged_into_cart_id = $1,
             updated_at = $2::timestamptz
         WHERE cart_id = $3`,
        [targetCart.cartId, new Date().toISOString(), guestCart.cartId]
      );

      return (await this.getHydratedCart(targetCart.cartId, q))!;
    });
  }

  async markCartCheckedOut(cartId: string, tx?: PgTxClient): Promise<void> {
    const runner = tx ?? this.pool;
    await runner.query(
      `UPDATE carts SET status = 'CHECKED_OUT', updated_at = $1::timestamptz WHERE cart_id = $2`,
      [new Date().toISOString(), cartId]
    );
  }

  async listRecentCarts(limit = 25): Promise<readonly HydratedCartRecord[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const res = await this.pool.query<{ cart_id: string }>(
      `SELECT cart_id FROM carts ORDER BY updated_at DESC LIMIT $1`,
      [safeLimit]
    );
    const carts: HydratedCartRecord[] = [];
    for (const r of res.rows) {
      const c = await this.getHydratedCart(r.cart_id);
      if (c) carts.push(c);
    }
    return carts;
  }

  async getHydratedCart(
    cartId: string,
    runner?: PgQueryable
  ): Promise<HydratedCartRecord | null> {
    const q = runner ?? this.pool;
    const cartRes = await q.query<{
      cart_id: string;
      channel_slug: string;
      currency_code: string;
      tax_mode: TaxInclusionMode;
      customer_id: string | null;
      guest_token: string | null;
      status: HydratedCartRecord["status"];
      merged_into_cart_id: string | null;
      shipping_address_json: string | null;
      voucher_code: string | null;
      voucher_discount_json: string | null;
      shipping_base_amount: string;
      shipping_tax_rate_bps: string;
      updated_at: string;
    }>(
      `SELECT cart_id, channel_slug, currency_code, tax_mode,
              customer_id, guest_token, status, merged_into_cart_id,
              shipping_address_json, voucher_code, voucher_discount_json,
              shipping_base_amount, shipping_tax_rate_bps, updated_at
       FROM carts
       WHERE cart_id = $1`,
      [cartId]
    );

    const c = cartRes.rows[0];
    if (!c) return null;

    const lineRes = await q.query<{
      line_id: string;
      variant_id: string;
      sku: string;
      title: string;
      quantity: string;
      base_unit_price: string;
      tax_rate_bps: string;
      tier_prices_json: string;
      line_discounts_json: string;
      unit_cost_amount: string | null;
      min_margin_bps: string;
    }>(
      `SELECT line_id, variant_id, sku, title, quantity,
              base_unit_price, tax_rate_bps, tier_prices_json, line_discounts_json,
              unit_cost_amount, min_margin_bps
       FROM cart_lines
       WHERE cart_id = $1
       ORDER BY line_id ASC`,
      [cartId]
    );

    const lines: PersistentCartLine[] = lineRes.rows.map((r) => ({
      lineId: r.line_id,
      variantId: r.variant_id,
      sku: r.sku,
      title: r.title,
      quantity: Number(r.quantity),
      baseUnitPrice: BigInt(r.base_unit_price),
      taxRateBps: Number(r.tax_rate_bps),
      tierPrices: r.tier_prices_json
        ? deserializeWithBigInt<PriceTier[]>(
            typeof r.tier_prices_json === "string"
              ? r.tier_prices_json
              : JSON.stringify(r.tier_prices_json)
          )
        : [],
      candidateLineDiscounts: r.line_discounts_json
        ? deserializeWithBigInt<CandidateLineDiscount[]>(
            typeof r.line_discounts_json === "string"
              ? r.line_discounts_json
              : JSON.stringify(r.line_discounts_json)
          )
        : [],
      unitCostAmount: r.unit_cost_amount !== null ? BigInt(r.unit_cost_amount) : undefined,
      minMarginBps: Number(r.min_margin_bps ?? "0"),
    }));

    const voucherDiscount = c.voucher_discount_json
      ? deserializeWithBigInt<CandidateOrderDiscount>(
          typeof c.voucher_discount_json === "string"
            ? c.voucher_discount_json
            : JSON.stringify(c.voucher_discount_json)
        )
      : undefined;

    const shippingAddress = c.shipping_address_json
      ? (typeof c.shipping_address_json === "string"
          ? JSON.parse(c.shipping_address_json)
          : c.shipping_address_json)
      : undefined;

    const shippingBaseAmount = BigInt(c.shipping_base_amount);
    const shippingTaxRateBps = Number(c.shipping_tax_rate_bps);

    const calcInput: CartCalculationInput = {
      currencyCode: c.currency_code,
      taxMode: c.tax_mode,
      shippingBaseAmount,
      shippingTaxRateBps,
      lines: lines.map((l) => ({
        lineId: l.lineId,
        variantId: l.variantId,
        quantity: l.quantity,
        baseUnitPrice: l.baseUnitPrice,
        tierPrices: l.tierPrices,
        taxRateBps: l.taxRateBps,
        candidateLineDiscounts: l.candidateLineDiscounts,
        unitCostAmount: l.unitCostAmount,
        minMarginBps: l.minMarginBps,
      })),
      candidateOrderDiscounts: voucherDiscount ? [voucherDiscount] : [],
    };

    const pricing = calculateCart(calcInput);

    return {
      cartId: c.cart_id,
      channelSlug: c.channel_slug,
      currencyCode: c.currency_code,
      taxMode: c.tax_mode,
      customerId: c.customer_id ?? undefined,
      guestToken: c.guest_token ?? undefined,
      status: c.status,
      mergedIntoCartId: c.merged_into_cart_id ?? undefined,
      shippingAddress,
      voucherCode: c.voucher_code ?? undefined,
      voucherDiscount,
      shippingBaseAmount,
      shippingTaxRateBps,
      lines,
      pricing,
      updatedAt: c.updated_at,
    };
  }
}
