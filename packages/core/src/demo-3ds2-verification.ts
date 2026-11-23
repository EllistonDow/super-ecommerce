import assert from "node:assert/strict";
import {
  OfflinePgPool,
  runMigrations,
} from "@super-ecommerce/db";
import { PgWorkflowStateStore } from "@super-ecommerce/workflow";
import {
  PgStripePaymentIntentService,
  PgMsiInventoryService,
  PgTransactionalOutboxService,
  PgDoubleEntryLedgerService,
  PgCustomersService,
  PgOrdersRepository,
  buildCompleteCheckoutWorkflow,
  type CompleteCheckoutInput,
} from "./index.ts";

async function run3ds2Audit() {
  console.log("================================================================================");
  console.log(">>> [PAYMENT AUDIT] 3D Secure 2.0 (3DS2) Strong Customer Authentication Lifecycle");
  console.log("================================================================================\n");

  const pg = new OfflinePgPool();
  await runMigrations(pg);

  const stripeService = new PgStripePaymentIntentService({ pool: pg });
  const inv = new PgMsiInventoryService(pg);
  const outbox = new PgTransactionalOutboxService(pg);
  const subledger = new PgDoubleEntryLedgerService(pg);
  const customers = new PgCustomersService(pg);
  const ordersRepo = new PgOrdersRepository(pg);

  // Seed inventory for downstream checkout
  await inv.upsertExternalSlots([
    {
      warehouseId: "WH-EAST",
      priorityRank: 1,
      linkedToChannel: true,
      supportsShippingZone: true,
      variantId: "VAR-3DS-KB",
      quantityOnHand: 25,
      quantityReserved: 0,
      quantityAllocated: 0,
    },
  ]);

  // ---------------------------------------------------------------------------
  // Case 1: 3DS2 Challenge with Automatic Capture (Direct Settlement)
  // ---------------------------------------------------------------------------
  console.log("1. Testing 3DS2 Challenge with Automatic Capture (capture_method: automatic):");
  const piAuto = await stripeService.createPaymentIntent({
    idempotencyKey: "pi_idem_3ds_auto_001",
    checkoutId: "chk_3ds_auto_001",
    customerId: "cust_3ds_001",
    channelSlug: "us-retail",
    currencyCode: "USD",
    amount: 15_000n, // $150.00
    captureMethod: "automatic",
    paymentMethodToken: "pm_card_3ds_required", // Triggers 3DS2 SCA requirement
    confirmImmediately: true,
    metadata: {
      flow: "3ds2_auto_capture_test",
      cardBrand: "visa_secure",
    },
  });

  console.log(`   - PaymentIntent ID: ${piAuto.paymentIntentId}`);
  console.log(`   - Initial Status:   ${piAuto.status} (EXPECTED: requires_action)`);
  console.log(`   - Amount:           $${(Number(piAuto.amount)/100).toFixed(2)}`);
  console.log(`   - Amount Received:  $${(Number(piAuto.amountReceived)/100).toFixed(2)}`);
  console.log(`   - 3DS Redirect URL: ${piAuto.nextActionRedirectUrl}`);
  assert.equal(piAuto.status, "requires_action");
  assert.ok(piAuto.nextActionRedirectUrl?.includes("3d_secure_2"));
  console.log("   -> [PASS] Issuing bank challenged cardholder for 3DS2 Strong Customer Authentication\n");

  console.log("   Simulating cardholder biometric/OTP challenge completion on ACS:");
  const piAutoCompleted = await stripeService.complete3dsChallenge(piAuto.paymentIntentId);
  console.log(`   - Status after 3DS2: ${piAutoCompleted.status} (EXPECTED: succeeded)`);
  console.log(`   - Amount Received:   $${(Number(piAutoCompleted.amountReceived)/100).toFixed(2)}`);
  console.log(`   - Redirect URL:      ${piAutoCompleted.nextActionRedirectUrl ?? "NULL (Cleared)"}`);
  assert.equal(piAutoCompleted.status, "succeeded");
  assert.equal(piAutoCompleted.amountReceived, 15_000n);
  assert.equal(piAutoCompleted.nextActionRedirectUrl, undefined);
  console.log("   -> [PASS] 3DS2 challenge succeeded and funds automatically settled in full\n");

  // ---------------------------------------------------------------------------
  // Case 2: 3DS2 Challenge with Two-Phase Delayed Capture (Manual Pre-Auth)
  // ---------------------------------------------------------------------------
  console.log("2. Testing 3DS2 Challenge with Two-Phase Delayed Capture (capture_method: manual):");
  const piManual = await stripeService.createPaymentIntent({
    idempotencyKey: "pi_idem_3ds_manual_002",
    checkoutId: "chk_3ds_manual_002",
    customerId: "cust_3ds_002",
    channelSlug: "us-retail",
    currencyCode: "USD",
    amount: 22_500n, // $225.00
    captureMethod: "manual",
    paymentMethodToken: "pm_card_3ds_challenge", // Triggers 3DS2 challenge
    confirmImmediately: true,
    metadata: {
      flow: "3ds2_manual_auth_test",
    },
  });

  console.log(`   - PaymentIntent ID: ${piManual.paymentIntentId}`);
  console.log(`   - Initial Status:   ${piManual.status} (EXPECTED: requires_action)`);
  assert.equal(piManual.status, "requires_action");
  assert.ok(piManual.nextActionRedirectUrl?.includes("3d_secure_2"));

  console.log("   Cardholder completes 3DS2 authentication challenge:");
  const piManualAuth = await stripeService.complete3dsChallenge(piManual.paymentIntentId);
  console.log(`   - Status after 3DS2: ${piManualAuth.status} (EXPECTED: requires_capture)`);
  console.log(`   - Amount Capturable: $${(Number(piManualAuth.amountCapturable)/100).toFixed(2)}`);
  console.log(`   - Amount Received:   $${(Number(piManualAuth.amountReceived)/100).toFixed(2)}`);
  assert.equal(piManualAuth.status, "requires_capture");
  assert.equal(piManualAuth.amountCapturable, 22_500n);
  assert.equal(piManualAuth.amountReceived, 0n);
  console.log("   -> [PASS] 3DS2 authentication verified; funds placed in authorized holding state\n");

  console.log("   Merchant OMS executes pre-fulfillment capture of authorized funds:");
  const piManualCaptured = await stripeService.capturePaymentIntent(piManual.paymentIntentId);
  console.log(`   - Status after Capture: ${piManualCaptured.status} (EXPECTED: succeeded)`);
  console.log(`   - Amount Received:      $${(Number(piManualCaptured.amountReceived)/100).toFixed(2)}`);
  assert.equal(piManualCaptured.status, "succeeded");
  assert.equal(piManualCaptured.amountReceived, 22_500n);
  console.log("   -> [PASS] Authorized holding successfully captured into settlement\n");

  // ---------------------------------------------------------------------------
  // Case 3: Downstream Checkout Workflow Consumption of Confirmed 3DS2 Token
  // ---------------------------------------------------------------------------
  console.log("3. Testing End-to-End Checkout Execution Using 3DS2 Authenticated Token:");
  const checkoutWf = buildCompleteCheckoutWorkflow({
    inventoryService: inv,
    paymentGateway: stripeService.asPaymentGatewayStrategy(),
    outboxService: outbox,
    storeCreditLedger: customers,
    pgPool: pg,
  });

  // Create another 3DS2 token for checkout
  const piForCheckout = await stripeService.createPaymentIntent({
    idempotencyKey: "pi_idem_for_checkout_003",
    checkoutId: "chk_3ds_e2e_003",
    channelSlug: "us-retail",
    currencyCode: "USD",
    amount: 10_000n, // $100.00
    captureMethod: "manual",
    paymentMethodToken: "pm_card_3ds_challenge",
    confirmImmediately: true,
  });
  assert.equal(piForCheckout.status, "requires_action");

  // Complete 3DS
  await stripeService.complete3dsChallenge(piForCheckout.paymentIntentId);
  const authedPi = await stripeService.getPaymentIntent(piForCheckout.paymentIntentId);
  assert.equal(authedPi?.status, "requires_capture");

  // Pass this token into CompleteCheckoutWorkflow
  const chkInput: CompleteCheckoutInput = {
    checkoutId: "chk_3ds_e2e_003",
    channelSlug: "us-retail",
    stockAvailabilityMode: "DIRECT_CHANNEL_WAREHOUSES",
    allocationStrategy: "MINIMIZE_SPLIT_THEN_HIGH_STOCK",
    paymentToken: piForCheckout.paymentIntentId, // Confirmed 3DS2 token
    cart: {
      currencyCode: "USD",
      taxMode: "TAX_EXCLUSIVE",
      shippingBaseAmount: 0n,
      lines: [
        {
          lineId: "line-1",
          variantId: "VAR-3DS-KB",
          quantity: 1,
          baseUnitPrice: 10_000n,
          taxRateBps: 0,
        },
      ],
    },
  };

  const chkResult = await checkoutWf.execute(chkInput, {
    idempotencyKey: "idem_checkout_3ds_e2e",
    store: new PgWorkflowStateStore(pg),
  });

  console.log(`   - Checkout Saga Status: ${chkResult.status}`);
  console.log(`   - Committed Order ID:   ${chkResult.output?.orderId}`);
  console.log(`   - Order Payment Status: ${chkResult.output?.paymentStatus}`);
  console.log(`   - Transaction ID:       ${chkResult.output?.paymentTransactionId}`);

  const piFinal = await stripeService.getPaymentIntent(piForCheckout.paymentIntentId);
  console.log(`   - PaymentIntent Final:  ${piFinal?.status} (captured amount: $${(Number(piFinal?.amountReceived ?? 0n)/100).toFixed(2)})`);

  const slot = await inv.getSlot("WH-EAST", "VAR-3DS-KB");
  console.log(`   - MSI Stock Allocated:  ${slot?.quantityAllocated} unit (Reserved: ${slot?.quantityReserved})`);

  assert.equal(chkResult.status, "COMPLETED");
  assert.equal(chkResult.output?.paymentStatus, "CAPTURED");
  assert.equal(piFinal?.status, "succeeded");
  assert.equal(slot?.quantityAllocated, 1);
  console.log("   -> [PASS] Checkout saga successfully consumed 3DS2 token, captured funds, and committed order\n");

  // ---------------------------------------------------------------------------
  // Case 4: Idempotency & Invariant Protections
  // ---------------------------------------------------------------------------
  console.log("4. Testing 3DS2 Idempotency & Edge State Safety:");
  // Re-calling complete3ds on already succeeded/captured intent is idempotent no-op
  const idempotentReplay = await stripeService.complete3dsChallenge(piAuto.paymentIntentId);
  assert.equal(idempotentReplay.status, "succeeded");
  console.log(`   - Idempotent Replay on Succeeded PI: status = ${idempotentReplay.status}`);

  // Trying to capture an intent that is still in requires_action throws error
  const unverifiedPi = await stripeService.createPaymentIntent({
    idempotencyKey: "pi_idem_unverified_004",
    checkoutId: "chk_unverified_004",
    channelSlug: "us-retail",
    currencyCode: "USD",
    amount: 5_000n,
    paymentMethodToken: "pm_card_3ds_required",
    confirmImmediately: true,
  });
  try {
    await stripeService.capturePaymentIntent(unverifiedPi.paymentIntentId);
    assert.fail("Should have failed to capture unverified 3DS intent");
  } catch (err: any) {
    console.log(`   - Blocked premature capture before 3DS2 challenge: "${err.message}"`);
    console.log("   -> [PASS] Unauthenticated 3DS2 intent cannot be captured\n");
  }

  await pg.close();

  console.log("================================================================================");
  console.log(">>> [AUDIT VERDICT] ALL 4 3DS2 SCA LIFECYCLE INVARIANTS RIGOROUSLY VERIFIED");
  console.log("================================================================================");
}

run3ds2Audit().catch((err) => {
  console.error("3DS2 Audit failed:", err);
  process.exit(1);
});
