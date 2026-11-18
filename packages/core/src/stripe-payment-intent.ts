/**
 * Dual-Mode Stripe `PaymentIntent` Engine (`packages/core/src/stripe-payment-intent.ts`).
 *
 * Bridges real commercial Stripe APIs and hermetic PostgreSQL state tracking:
 * 1. **Live Stripe REST Mode (`STRIPE_LIVE_API`)**: When `stripeSecretKey` (`sk_live_...` / `sk_test_...`)
 *    is configured, invokes official `https://api.stripe.com/v1/payment_intents` and `/v1/refunds`
 *    endpoints with form-urlencoded payloads and strict `Idempotency-Key` headers.
 * 2. **Deterministic Local State Machine (`LOCAL_SIMULATOR`)**: Persists full Stripe-compatible
 *    `PaymentIntent` lifecycles in PostgreSQL (`payment_intents`), supporting:
 *    - Automatic one-step confirmation & capture (`automatic`)
 *    - Two-phase authorization & delayed capture (`manual`: `requires_capture` -> `succeeded`)
 *    - 3D Secure (`pm_card_3ds_required`: `requires_action` -> `complete3dsChallenge` -> `succeeded` / `requires_capture`)
 *    - Card declines (`pm_card_declined`) and partial/full refunds
 * 3. Exposes `asPaymentGatewayStrategy()` so `completeCheckoutWorkflow`, `processReturnRefundWorkflow`,
 *    and `buildEditOrderWorkflow` execute against real PaymentIntents seamlessly.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { MinorUnits } from "@super-ecommerce/kernel";
import type { PgPoolLike, PgQueryable } from "@super-ecommerce/db";
import type { PaymentGatewayStrategy } from "./complete-checkout-workflow.ts";

export type StripeCaptureMethod = "automatic" | "manual";

export type StripePaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "requires_capture"
  | "succeeded"
  | "canceled";

export interface StripePaymentIntentRecord {
  readonly paymentIntentId: string;
  readonly idempotencyKey: string;
  readonly checkoutId: string;
  readonly orderId?: string;
  readonly customerId?: string;
  readonly channelSlug: string;
  readonly currencyCode: string;
  readonly amount: MinorUnits;
  readonly amountCapturable: MinorUnits;
  readonly amountReceived: MinorUnits;
  readonly amountRefunded: MinorUnits;
  readonly captureMethod: StripeCaptureMethod;
  readonly status: StripePaymentIntentStatus;
  readonly clientSecret: string;
  readonly paymentMethodToken?: string;
  readonly nextActionRedirectUrl?: string;
  readonly providerMode: "STRIPE_LIVE_API" | "LOCAL_SIMULATOR";
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePaymentIntentInput {
  readonly idempotencyKey: string;
  readonly checkoutId: string;
  readonly orderId?: string;
  readonly customerId?: string;
  readonly channelSlug: string;
  readonly currencyCode: string;
  readonly amount: MinorUnits;
  readonly captureMethod?: StripeCaptureMethod;
  readonly paymentMethodToken?: string;
  readonly confirmImmediately?: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
}

export class StripePaymentDeclinedError extends Error {
  readonly declineCode: string;
  constructor(declineCode: string, message: string) {
    super(message);
    this.name = "StripePaymentDeclinedError";
    this.declineCode = declineCode;
  }
}

export class PgStripePaymentIntentService {
  private readonly pool: PgPoolLike;
  private readonly stripeSecretKey?: string;
  private readonly stripeApiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(params: {
    pool: PgPoolLike;
    stripeSecretKey?: string;
    stripeApiBaseUrl?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.pool = params.pool;
    const envKey = process.env["STRIPE_SECRET_KEY"]?.trim();
    this.stripeSecretKey = params.stripeSecretKey?.trim() || envKey || undefined;
    this.stripeApiBaseUrl = (
      params.stripeApiBaseUrl ?? "https://api.stripe.com"
    ).replace(/\/+$/, "");
    this.fetchImpl = params.fetchImpl ?? globalThis.fetch;
  }

  isLiveStripeConfigured(): boolean {
    return Boolean(this.stripeSecretKey);
  }

  private async callStripeFormApi(params: {
    path: string;
    idempotencyKey: string;
    formFields: Record<string, string>;
  }): Promise<Record<string, unknown>> {
    if (!this.stripeSecretKey) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    const body = new URLSearchParams(params.formFields).toString();
    const res = await this.fetchImpl(`${this.stripeApiBaseUrl}${params.path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.stripeSecretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": params.idempotencyKey,
      },
      body,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const errObj = (json["error"] ?? {}) as Record<string, unknown>;
      throw new StripePaymentDeclinedError(
        String(errObj["code"] ?? "stripe_api_error"),
        String(errObj["message"] ?? `Stripe API HTTP ${res.status}`)
      );
    }
    return json;
  }

  async createPaymentIntent(
    input: CreatePaymentIntentInput
  ): Promise<StripePaymentIntentRecord> {
    const normalizedAmount = BigInt(input.amount);
    if (normalizedAmount <= 0n) {
      throw new Error("PaymentIntent amount must be strictly positive");
    }

    const existing = await this.getByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    const captureMethod: StripeCaptureMethod = input.captureMethod ?? "automatic";
    const confirmNow = input.confirmImmediately ?? Boolean(input.paymentMethodToken);
    const pmToken = input.paymentMethodToken;

    if (pmToken === "pm_card_declined" || pmToken === "tok_declined") {
      throw new StripePaymentDeclinedError(
        "card_declined",
        "Your card was declined by the issuing bank"
      );
    }

    let paymentIntentId: string;
    let clientSecret: string;
    let status: StripePaymentIntentStatus;
    let amountCapturable = 0n;
    let amountReceived = 0n;
    let nextActionUrl: string | undefined;
    const providerMode = this.isLiveStripeConfigured()
      ? ("STRIPE_LIVE_API" as const)
      : ("LOCAL_SIMULATOR" as const);

    if (providerMode === "STRIPE_LIVE_API") {
      const formFields: Record<string, string> = {
        amount: normalizedAmount.toString(),
        currency: input.currencyCode.toLowerCase(),
        capture_method: captureMethod,
        "metadata[checkoutId]": input.checkoutId,
        "metadata[channelSlug]": input.channelSlug,
      };
      if (input.orderId) formFields["metadata[orderId]"] = input.orderId;
      if (pmToken) formFields["payment_method"] = pmToken;
      if (confirmNow && pmToken) formFields["confirm"] = "true";

      const livePi = await this.callStripeFormApi({
        path: "/v1/payment_intents",
        idempotencyKey: input.idempotencyKey,
        formFields,
      });

      paymentIntentId = String(livePi["id"]);
      clientSecret = String(livePi["client_secret"] ?? `${paymentIntentId}_secret_live`);
      status = String(livePi["status"]) as StripePaymentIntentStatus;
      amountCapturable = BigInt(String(livePi["amount_capturable"] ?? "0"));
      amountReceived = BigInt(String(livePi["amount_received"] ?? "0"));
      const nextAct = livePi["next_action"] as Record<string, unknown> | undefined;
      const redir = nextAct?.["redirect_to_url"] as Record<string, unknown> | undefined;
      if (typeof redir?.["url"] === "string") {
        nextActionUrl = redir["url"];
      }
    } else {
      paymentIntentId = `pi_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      clientSecret = `${paymentIntentId}_secret_${randomBytes(8).toString("hex")}`;

      if (!pmToken) {
        status = "requires_payment_method";
      } else if (!confirmNow) {
        status = "requires_confirmation";
      } else if (pmToken === "pm_card_3ds_required" || pmToken.includes("3ds")) {
        status = "requires_action";
        nextActionUrl = `https://hooks.stripe.local/3d_secure_2/authenticate/${paymentIntentId}`;
      } else if (captureMethod === "manual") {
        status = "requires_capture";
        amountCapturable = normalizedAmount;
      } else {
        status = "succeeded";
        amountReceived = normalizedAmount;
      }
    }

    const nowIso = new Date().toISOString();
    const metadata: Record<string, string> = {
      checkoutId: input.checkoutId,
      channelSlug: input.channelSlug,
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(input.metadata ?? {}),
    };

    await this.pool.query(
      `INSERT INTO payment_intents (
         payment_intent_id, idempotency_key, checkout_id, order_id, customer_id,
         channel_slug, currency_code, amount, amount_capturable, amount_received,
         amount_refunded, capture_method, status, client_secret, payment_method_token,
         next_action_redirect_url, provider_mode, metadata_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10,
         0, $11, $12, $13, $14,
         $15, $16, $17::jsonb, $18::timestamptz, $18::timestamptz
       )`,
      [
        paymentIntentId,
        input.idempotencyKey,
        input.checkoutId,
        input.orderId ?? null,
        input.customerId ?? null,
        input.channelSlug,
        input.currencyCode.toUpperCase(),
        normalizedAmount.toString(),
        amountCapturable.toString(),
        amountReceived.toString(),
        captureMethod,
        status,
        clientSecret,
        pmToken ?? null,
        nextActionUrl ?? null,
        providerMode,
        JSON.stringify(metadata),
        nowIso,
      ]
    );

    return (await this.getPaymentIntent(paymentIntentId))!;
  }

  /**
   * Completes a 3D Secure (`requires_action`) challenge and transitions the PaymentIntent
   * to `requires_capture` (for `manual` capture) or `succeeded` (for `automatic` capture).
   */
  async complete3dsChallenge(paymentIntentId: string): Promise<StripePaymentIntentRecord> {
    const pi = await this.getPaymentIntent(paymentIntentId);
    if (!pi) throw new Error(`PaymentIntent '${paymentIntentId}' not found`);
    if (pi.status !== "requires_action") {
      return pi;
    }

    const nextStatus: StripePaymentIntentStatus =
      pi.captureMethod === "manual" ? "requires_capture" : "succeeded";
    const nextCapturable = pi.captureMethod === "manual" ? pi.amount : 0n;
    const nextReceived = pi.captureMethod === "automatic" ? pi.amount : 0n;

    await this.pool.query(
      `UPDATE payment_intents
       SET status = $1,
           amount_capturable = $2,
           amount_received = $3,
           next_action_redirect_url = NULL,
           updated_at = $4::timestamptz
       WHERE payment_intent_id = $5`,
      [
        nextStatus,
        nextCapturable.toString(),
        nextReceived.toString(),
        new Date().toISOString(),
        paymentIntentId,
      ]
    );
    return (await this.getPaymentIntent(paymentIntentId))!;
  }

  /**
   * Captures a two-phase authorized PaymentIntent (`requires_capture` -> `succeeded`),
   * supporting partial or full capture (`amountToCapture <= amountCapturable`).
   */
  async capturePaymentIntent(
    paymentIntentId: string,
    amountToCapture?: MinorUnits
  ): Promise<StripePaymentIntentRecord> {
    const pi = await this.getPaymentIntent(paymentIntentId);
    if (!pi) throw new Error(`PaymentIntent '${paymentIntentId}' not found`);
    if (pi.status === "succeeded") return pi;
    if (pi.status !== "requires_capture") {
      throw new Error(
        `Cannot capture PaymentIntent '${paymentIntentId}' in status '${pi.status}'`
      );
    }

    const captureAmt = amountToCapture ?? pi.amountCapturable;
    if (captureAmt <= 0n || captureAmt > pi.amountCapturable) {
      throw new Error(
        `Invalid capture amount ${captureAmt} (capturable=${pi.amountCapturable})`
      );
    }

    if (pi.providerMode === "STRIPE_LIVE_API") {
      await this.callStripeFormApi({
        path: `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`,
        idempotencyKey: `capture:${paymentIntentId}:${captureAmt.toString()}`,
        formFields: { amount_to_capture: captureAmt.toString() },
      });
    }

    await this.pool.query(
      `UPDATE payment_intents
       SET status = 'succeeded',
           amount_capturable = 0,
           amount_received = $1,
           updated_at = $2::timestamptz
       WHERE payment_intent_id = $3`,
      [captureAmt.toString(), new Date().toISOString(), paymentIntentId]
    );
    return (await this.getPaymentIntent(paymentIntentId))!;
  }

  /**
   * Cancels an uncaptured PaymentIntent or issues a partial/full refund on a captured PaymentIntent.
   */
  async refundOrCancelPaymentIntent(params: {
    paymentIntentId: string;
    amount?: MinorUnits;
    idempotencyKey?: string;
  }): Promise<StripePaymentIntentRecord> {
    const pi = await this.getPaymentIntent(params.paymentIntentId);
    if (!pi) {
      throw new Error(`PaymentIntent '${params.paymentIntentId}' not found`);
    }

    const nowIso = new Date().toISOString();

    if (pi.status !== "succeeded") {
      if (pi.providerMode === "STRIPE_LIVE_API") {
        await this.callStripeFormApi({
          path: `/v1/payment_intents/${encodeURIComponent(pi.paymentIntentId)}/cancel`,
          idempotencyKey: params.idempotencyKey ?? `cancel:${pi.paymentIntentId}`,
          formFields: {},
        });
      }
      await this.pool.query(
        `UPDATE payment_intents
         SET status = 'canceled', amount_capturable = 0, updated_at = $1::timestamptz
         WHERE payment_intent_id = $2`,
        [nowIso, pi.paymentIntentId]
      );
      return (await this.getPaymentIntent(pi.paymentIntentId))!;
    }

    const remainingRefundable = pi.amountReceived - pi.amountRefunded;
    const refundAmt = params.amount ?? remainingRefundable;
    if (refundAmt <= 0n || refundAmt > remainingRefundable) {
      throw new Error(
        `Refund amount ${refundAmt} exceeds remaining refundable balance ${remainingRefundable} on '${pi.paymentIntentId}'`
      );
    }

    if (pi.providerMode === "STRIPE_LIVE_API") {
      await this.callStripeFormApi({
        path: "/v1/refunds",
        idempotencyKey:
          params.idempotencyKey ??
          `refund:${pi.paymentIntentId}:${(pi.amountRefunded + refundAmt).toString()}`,
        formFields: {
          payment_intent: pi.paymentIntentId,
          amount: refundAmt.toString(),
        },
      });
    }

    await this.pool.query(
      `UPDATE payment_intents
       SET amount_refunded = amount_refunded + $1,
           updated_at = $2::timestamptz
       WHERE payment_intent_id = $3`,
      [refundAmt.toString(), nowIso, pi.paymentIntentId]
    );
    return (await this.getPaymentIntent(pi.paymentIntentId))!;
  }

  async getByIdempotencyKey(
    idempotencyKey: string,
    runner?: PgQueryable
  ): Promise<StripePaymentIntentRecord | null> {
    const q = runner ?? this.pool;
    const res = await q.query<{ payment_intent_id: string }>(
      `SELECT payment_intent_id FROM payment_intents WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    const id = res.rows[0]?.payment_intent_id;
    return id ? await this.getPaymentIntent(id, q) : null;
  }

  async getPaymentIntent(
    paymentIntentId: string,
    runner?: PgQueryable
  ): Promise<StripePaymentIntentRecord | null> {
    const q = runner ?? this.pool;
    const res = await q.query<{
      payment_intent_id: string;
      idempotency_key: string;
      checkout_id: string;
      order_id: string | null;
      customer_id: string | null;
      channel_slug: string;
      currency_code: string;
      amount: string;
      amount_capturable: string;
      amount_received: string;
      amount_refunded: string;
      capture_method: StripeCaptureMethod;
      status: StripePaymentIntentStatus;
      client_secret: string;
      payment_method_token: string | null;
      next_action_redirect_url: string | null;
      provider_mode: "STRIPE_LIVE_API" | "LOCAL_SIMULATOR";
      metadata_json: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT * FROM payment_intents WHERE payment_intent_id = $1`,
      [paymentIntentId]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      paymentIntentId: r.payment_intent_id,
      idempotencyKey: r.idempotency_key,
      checkoutId: r.checkout_id,
      orderId: r.order_id ?? undefined,
      customerId: r.customer_id ?? undefined,
      channelSlug: r.channel_slug,
      currencyCode: r.currency_code,
      amount: BigInt(r.amount),
      amountCapturable: BigInt(r.amount_capturable),
      amountReceived: BigInt(r.amount_received),
      amountRefunded: BigInt(r.amount_refunded),
      captureMethod: r.capture_method,
      status: r.status,
      clientSecret: r.client_secret,
      paymentMethodToken: r.payment_method_token ?? undefined,
      nextActionRedirectUrl: r.next_action_redirect_url ?? undefined,
      providerMode: r.provider_mode,
      metadata:
        typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async listRecentPaymentIntents(limit = 25): Promise<readonly StripePaymentIntentRecord[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const res = await this.pool.query<{ payment_intent_id: string }>(
      `SELECT payment_intent_id FROM payment_intents ORDER BY created_at DESC LIMIT $1`,
      [safeLimit]
    );
    const out: StripePaymentIntentRecord[] = [];
    for (const r of res.rows) {
      const pi = await this.getPaymentIntent(r.payment_intent_id);
      if (pi) out.push(pi);
    }
    return out;
  }

  /**
   * Adapts `PgStripePaymentIntentService` directly to `PaymentGatewayStrategy`
   * for `completeCheckoutWorkflow`, `processReturnRefundWorkflow`, and `buildEditOrderWorkflow`.
   */
  asPaymentGatewayStrategy(defaultChannelSlug = "us-retail"): PaymentGatewayStrategy {
    return {
      capture: async ({ checkoutId, amount, currencyCode, paymentToken }) => {
        // Support passing an existing pre-authorized `pi_...` PaymentIntent ID to capture
        if (paymentToken.startsWith("pi_")) {
          const existing = await this.getPaymentIntent(paymentToken);
          if (existing) {
            const finalized =
              existing.status === "requires_capture"
                ? await this.capturePaymentIntent(existing.paymentIntentId, amount)
                : existing;
            if (finalized.status !== "succeeded") {
              throw new StripePaymentDeclinedError(
                "intent_not_succeeded",
                `PaymentIntent '${finalized.paymentIntentId}' requires ${finalized.status}`
              );
            }
            return {
              transactionId: finalized.paymentIntentId,
              provider: "stripe",
              capturedAmount: finalized.amountReceived,
            };
          }
        }

        const created = await this.createPaymentIntent({
          idempotencyKey: `pi_auto:${checkoutId}:${amount.toString()}`,
          checkoutId,
          channelSlug: defaultChannelSlug,
          currencyCode,
          amount,
          captureMethod: "automatic",
          paymentMethodToken: paymentToken,
          confirmImmediately: true,
        });
        if (created.status !== "succeeded") {
          throw new StripePaymentDeclinedError(
            "authentication_required",
            `PaymentIntent '${created.paymentIntentId}' entered '${created.status}' (${created.nextActionRedirectUrl ?? "action required"})`
          );
        }
        return {
          transactionId: created.paymentIntentId,
          provider: "stripe",
          capturedAmount: created.amountReceived,
        };
      },
      voidOrRefund: async ({ transactionId, amount }) => {
        if (transactionId.startsWith("pi_")) {
          const found = await this.getPaymentIntent(transactionId);
          if (found) {
            await this.refundOrCancelPaymentIntent({
              paymentIntentId: transactionId,
              amount,
            });
          }
        }
      },
    };
  }
}
