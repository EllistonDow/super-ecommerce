/**
 * Enterprise B2B Organization Hierarchy, Net-Terms Credit Pool & Supervisory PO Approval Engine
 * (`packages/core/src/b2b-organization.ts`).
 *
 * Implements:
 * - 3-Tier Corporate Hierarchy (`B2bCompanyRecord` -> `B2bCostCenterRecord` -> `B2bBuyerMemberRecord`)
 * - Deterministic Rust N-API Policy Evaluation (`evaluateB2bPurchasePolicy`: Volume Tiers +
 *   Contract Discount BPS + Verified Tax-Exemption Certificate + Net-30/Net-60 Credit Pool)
 * - Auto-Approve Durable Saga (`APPROVED_AUTO`) vs. 72-Hour MSI Reservation Hold (`PENDING_APPROVAL`)
 * - Supervisory PO Approval / Rejection Durable Saga with strict LIFO reverse compensation
 */

import {
  evaluateB2bPurchasePolicy,
  type B2bBuyerRole,
  type B2bPaymentTerms,
  type B2bPolicyDecisionStatus,
  type B2bPurchasePolicyResult,
  type Bps,
  type CartCalculationInput,
  type CartCalculationResult,
  type MinorUnits,
} from "@super-ecommerce/kernel";
import {
  deserializeWithBigInt,
  serializeWithBigInt,
  type AllocationStrategy,
  type PgPoolLike,
  type PgQueryable,
  type PgTxClient,
  type StockAvailabilityMode,
} from "@super-ecommerce/db";
import { createStep, createWorkflow, type WorkflowStateStore } from "@super-ecommerce/workflow";
import type { OrderRecord } from "./complete-checkout-workflow.ts";
import {
  MsiInventoryService,
  type MsiInventoryServiceLike,
  type ShipmentSlice,
} from "./inventory-service.ts";
import {
  TransactionalOutboxService,
  type OutboxStoreLike,
} from "./outbox-service.ts";

export interface B2bCompanyRecord {
  readonly companyId: string;
  readonly name: string;
  readonly taxId: string;
  readonly taxExemptVerified: boolean;
  readonly paymentTerms: B2bPaymentTerms;
  readonly currencyCode: string;
  creditLimit: MinorUnits;
  creditUsed: MinorUnits;
  creditReserved: MinorUnits;
  readonly contractDiscountBps: Bps;
  readonly createdAt: string;
}

export interface B2bCostCenterRecord {
  readonly costCenterId: string;
  readonly companyId: string;
  readonly name: string;
  readonly departmentCode: string;
  monthlyBudget: MinorUnits;
  monthlySpent: MinorUnits;
  monthlyReserved: MinorUnits;
  readonly createdAt: string;
}

export interface B2bBuyerMemberRecord {
  readonly buyerId: string;
  readonly companyId: string;
  readonly costCenterId: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: B2bBuyerRole;
  readonly singleOrderAutoApproveLimit: MinorUnits;
  readonly createdAt: string;
}

export type B2bPurchaseOrderStatus =
  | "PENDING_APPROVAL"
  | "APPROVED_AUTO"
  | "APPROVED_BY_SUPERVISOR"
  | "REJECTED_COMPANY_CREDIT_EXCEEDED"
  | "REJECTED_BY_SUPERVISOR"
  | "EXPIRED_TTL";

export interface B2bPurchaseOrderRecord {
  readonly poId: string;
  readonly poNumber: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly costCenterId: string;
  readonly costCenterName: string;
  readonly buyerId: string;
  readonly buyerName: string;
  readonly buyerRole: B2bBuyerRole;
  approverId?: string;
  approverName?: string;
  orderId?: string;
  readonly channelSlug: string;
  readonly stockAvailabilityMode: StockAvailabilityMode;
  readonly allocationStrategy: AllocationStrategy;
  status: B2bPurchaseOrderStatus;
  readonly approvalReasons: readonly string[];
  readonly cart: CartCalculationInput;
  readonly pricing: CartCalculationResult;
  readonly standardTaxAmountWithoutExemption: MinorUnits;
  readonly taxExemptSavingsAmount: MinorUnits;
  readonly netTermsDueDays: number;
  readonly reservationTtlSeconds: number;
  reservationExpiresAt?: string;
  reservedShipments: readonly ShipmentSlice[];
  readonly createdAt: string;
  updatedAt: string;
}

export interface SubmitB2bPurchaseOrderInput {
  readonly poId: string;
  readonly poNumber: string;
  readonly companyId: string;
  readonly costCenterId: string;
  readonly buyerId: string;
  readonly channelSlug: string;
  readonly stockAvailabilityMode?: StockAvailabilityMode;
  readonly allocationStrategy?: AllocationStrategy;
  readonly cart: CartCalculationInput;
  readonly simulateCommitFault?: boolean;
  readonly ttlSecondsOverride?: number;
  readonly nowMs?: number;
}

export interface SubmitB2bPurchaseOrderOutput {
  readonly po: B2bPurchaseOrderRecord;
  readonly policyEvaluation: B2bPurchasePolicyResult;
  readonly order?: OrderRecord;
}

export interface SupervisorDecisionInput {
  readonly poId: string;
  readonly approverId: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly note?: string;
  readonly simulateCommitFault?: boolean;
}

export interface B2bServiceDeps {
  readonly inventoryService: MsiInventoryService;
  readonly outboxService: TransactionalOutboxService;
  readonly orderStore: Map<string, OrderRecord>;
  readonly workflowStateStore?: WorkflowStateStore;
}

export class B2bOrganizationService {
  private readonly companies = new Map<string, B2bCompanyRecord>();
  private readonly costCenters = new Map<string, B2bCostCenterRecord>();
  private readonly buyers = new Map<string, B2bBuyerMemberRecord>();
  private readonly purchaseOrders = new Map<string, B2bPurchaseOrderRecord>();
  private readonly deps: B2bServiceDeps;

  constructor(deps: B2bServiceDeps, seedDefaults = true) {
    this.deps = deps;
    if (seedDefaults) {
      this.seedDefaultEnterpriseHierarchy();
    }
  }

  seedDefaultEnterpriseHierarchy(): void {
    const now = "2026-11-15T08:00:00.000Z";
    const company: B2bCompanyRecord = {
      companyId: "comp-kronos-b2b",
      name: "Kronos Robotics & Defense Corp",
      taxId: "US-EIN-94-8821044",
      taxExemptVerified: true,
      paymentTerms: "NET_30",
      currencyCode: "USD",
      creditLimit: 5_000_000n, // $50,000.00 Net-30 credit limit
      creditUsed: 800_000n,    // $8,000.00 currently drawn
      creditReserved: 0n,
      contractDiscountBps: 500, // 5.00% negotiated corporate discount
      createdAt: now,
    };

    const costCenters: B2bCostCenterRecord[] = [
      {
        costCenterId: "cc-hw-lab",
        companyId: company.companyId,
        name: "Autonomous Hardware Lab",
        departmentCode: "ENG-HW-401",
        monthlyBudget: 1_500_000n, // $15,000.00 monthly budget
        monthlySpent: 200_000n,    // $2,000.00 spent
        monthlyReserved: 0n,
        createdAt: now,
      },
      {
        costCenterId: "cc-exec-ops",
        companyId: company.companyId,
        name: "Global Fleet Operations",
        departmentCode: "OPS-FLT-102",
        monthlyBudget: 3_000_000n, // $30,000.00 monthly budget
        monthlySpent: 100_000n,
        monthlyReserved: 0n,
        createdAt: now,
      },
    ];

    const members: B2bBuyerMemberRecord[] = [
      {
        buyerId: "buyer-elena",
        companyId: company.companyId,
        costCenterId: "cc-hw-lab",
        email: "elena.vance@kronos-robotics.io",
        fullName: "Elena Vance (Procurement Buyer)",
        role: "BUYER",
        singleOrderAutoApproveLimit: 250_000n, // $2,500.00 auto-approve ceiling
        createdAt: now,
      },
      {
        buyerId: "approver-marcus",
        companyId: company.companyId,
        costCenterId: "cc-hw-lab",
        email: "marcus.sterling@kronos-robotics.io",
        fullName: "Marcus Sterling (VP Hardware Eng)",
        role: "APPROVER",
        singleOrderAutoApproveLimit: 1_500_000n, // $15,000.00 ceiling
        createdAt: now,
      },
      {
        buyerId: "admin-victoria",
        companyId: company.companyId,
        costCenterId: "cc-exec-ops",
        email: "victoria.chen@kronos-robotics.io",
        fullName: "Victoria Chen (CFO & Company Admin)",
        role: "COMPANY_ADMIN",
        singleOrderAutoApproveLimit: 5_000_000n, // $50,000.00 ceiling
        createdAt: now,
      },
    ];

    this.upsertCompany(company);
    for (const cc of costCenters) {
      this.upsertCostCenter(cc);
    }
    for (const m of members) {
      this.upsertBuyerMember(m);
    }
  }

  upsertCompany(company: B2bCompanyRecord): void {
    this.companies.set(company.companyId, { ...company });
  }

  upsertCostCenter(cc: B2bCostCenterRecord): void {
    this.costCenters.set(cc.costCenterId, { ...cc });
  }

  upsertBuyerMember(member: B2bBuyerMemberRecord): void {
    this.buyers.set(member.buyerId, { ...member });
  }

  getCompany(companyId: string): B2bCompanyRecord | undefined {
    const c = this.companies.get(companyId);
    return c ? { ...c } : undefined;
  }

  getCostCenter(costCenterId: string): B2bCostCenterRecord | undefined {
    const cc = this.costCenters.get(costCenterId);
    return cc ? { ...cc } : undefined;
  }

  getBuyerMember(buyerId: string): B2bBuyerMemberRecord | undefined {
    const b = this.buyers.get(buyerId);
    return b ? { ...b } : undefined;
  }

  getPurchaseOrder(poId: string): B2bPurchaseOrderRecord | undefined {
    const po = this.purchaseOrders.get(poId);
    return po ? { ...po } : undefined;
  }

  upsertPurchaseOrder(po: B2bPurchaseOrderRecord): void {
    this.purchaseOrders.set(po.poId, { ...po });
  }

  listCompanies(): B2bCompanyRecord[] {
    return Array.from(this.companies.values()).map((c) => ({ ...c }));
  }

  listCostCenters(companyId?: string): B2bCostCenterRecord[] {
    return Array.from(this.costCenters.values())
      .filter((cc) => !companyId || cc.companyId === companyId)
      .map((cc) => ({ ...cc }));
  }

  listBuyerMembers(companyId?: string): B2bBuyerMemberRecord[] {
    return Array.from(this.buyers.values())
      .filter((b) => !companyId || b.companyId === companyId)
      .map((b) => ({ ...b }));
  }

  listPurchaseOrders(limit = 20): B2bPurchaseOrderRecord[] {
    return Array.from(this.purchaseOrders.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((po) => ({ ...po }));
  }

  private persistPurchaseOrder(po: B2bPurchaseOrderRecord): void {
    this.purchaseOrders.set(po.poId, { ...po });
  }

  private adjustCreditAndBudget(params: {
    companyId: string;
    costCenterId: string;
    creditUsedDelta?: MinorUnits;
    creditReservedDelta?: MinorUnits;
    monthlySpentDelta?: MinorUnits;
    monthlyReservedDelta?: MinorUnits;
  }): void {
    const company = this.companies.get(params.companyId);
    const cc = this.costCenters.get(params.costCenterId);
    if (!company || !cc) {
      throw new Error(`B2B Company or CostCenter not found`);
    }

    const nextCreditUsed = company.creditUsed + (params.creditUsedDelta ?? 0n);
    const nextCreditReserved =
      company.creditReserved + (params.creditReservedDelta ?? 0n);
    const nextMonthlySpent = cc.monthlySpent + (params.monthlySpentDelta ?? 0n);
    const nextMonthlyReserved =
      cc.monthlyReserved + (params.monthlyReservedDelta ?? 0n);

    company.creditUsed = nextCreditUsed < 0n ? 0n : nextCreditUsed;
    company.creditReserved = nextCreditReserved < 0n ? 0n : nextCreditReserved;
    cc.monthlySpent = nextMonthlySpent < 0n ? 0n : nextMonthlySpent;
    cc.monthlyReserved = nextMonthlyReserved < 0n ? 0n : nextMonthlyReserved;
  }

  /**
   * Submits a B2B Purchase Order (`submitB2bPurchaseOrder`).
   *
   * 1. Evaluates B2B Volume Tiers, Corporate Contract Discount, Tax-Exemption Certificate,
   *    Department Budget, Buyer Auto-Approve Limit, and Net-30 Credit Pool via Native Rust N-API.
   * 2. Routes according to `decision`:
   *    - `REJECTED_COMPANY_CREDIT_EXCEEDED`: Blocks PO, leaves MSI stock & credit unchanged.
   *    - `PENDING_APPROVAL`: Places a 72-hour MSI `quantity_reserved` hold and reserves
   *      company credit + department budget until a supervisor (`APPROVER` / `COMPANY_ADMIN`) acts.
   *    - `APPROVED_AUTO`: Executes the 3-step Durable B2B Saga (`allocate-b2b-msi-inventory` ->
   *      `draw-b2b-net-terms-credit` -> `commit-b2b-order-and-po`) with LIFO compensation.
   */
  async submitPurchaseOrder(params: {
    idempotencyKey: string;
    input: SubmitB2bPurchaseOrderInput;
  }): Promise<SubmitB2bPurchaseOrderOutput> {
    const { input } = params;
    const company = this.companies.get(input.companyId);
    if (!company) {
      throw new Error(`B2B Company '${input.companyId}' not found`);
    }
    const costCenter = this.costCenters.get(input.costCenterId);
    if (!costCenter || costCenter.companyId !== company.companyId) {
      throw new Error(`B2B Cost Center '${input.costCenterId}' not found`);
    }
    const buyer = this.buyers.get(input.buyerId);
    if (!buyer || buyer.companyId !== company.companyId) {
      throw new Error(`B2B Buyer '${input.buyerId}' not found`);
    }

    const availabilityMode =
      input.stockAvailabilityMode ?? "DIRECT_CHANNEL_WAREHOUSES";
    const allocationStrategy =
      input.allocationStrategy ?? "MINIMIZE_SPLIT_THEN_HIGH_STOCK";

    const policyEvaluation = evaluateB2bPurchasePolicy({
      company: {
        companyId: company.companyId,
        paymentTerms: company.paymentTerms,
        creditLimit: company.creditLimit,
        creditUsed: company.creditUsed,
        creditReserved: company.creditReserved,
        contractDiscountBps: company.contractDiscountBps,
        taxExemptVerified: company.taxExemptVerified,
      },
      costCenter: {
        costCenterId: costCenter.costCenterId,
        monthlyBudget: costCenter.monthlyBudget,
        monthlySpent: costCenter.monthlySpent,
        monthlyReserved: costCenter.monthlyReserved,
      },
      buyer: {
        buyerId: buyer.buyerId,
        role: buyer.role,
        singleOrderAutoApproveLimit: buyer.singleOrderAutoApproveLimit,
      },
      cart: input.cart,
    });

    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // Case 1: Hard credit ceiling exceeded -> reject immediately without touching stock or credit
    if (policyEvaluation.decision === "REJECTED_COMPANY_CREDIT_EXCEEDED") {
      const rejectedPo: B2bPurchaseOrderRecord = {
        poId: input.poId,
        poNumber: input.poNumber,
        companyId: company.companyId,
        companyName: company.name,
        costCenterId: costCenter.costCenterId,
        costCenterName: costCenter.name,
        buyerId: buyer.buyerId,
        buyerName: buyer.fullName,
        buyerRole: buyer.role,
        channelSlug: input.channelSlug,
        stockAvailabilityMode: availabilityMode,
        allocationStrategy,
        status: "REJECTED_COMPANY_CREDIT_EXCEEDED",
        approvalReasons: policyEvaluation.approvalReasons,
        cart: input.cart,
        pricing: policyEvaluation.pricing,
        standardTaxAmountWithoutExemption:
          policyEvaluation.standardTaxAmountWithoutExemption,
        taxExemptSavingsAmount: policyEvaluation.taxExemptSavingsAmount,
        netTermsDueDays: policyEvaluation.netTermsDueDays,
        reservationTtlSeconds: 0,
        reservedShipments: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.persistPurchaseOrder(rejectedPo);
      this.deps.outboxService.enqueue({
        eventType: "b2b.po.rejected_credit_limit.v1",
        aggregateType: "B2bPurchaseOrder",
        aggregateId: rejectedPo.poId,
        channelSlug: input.channelSlug,
        payload: {
          poId: rejectedPo.poId,
          poNumber: rejectedPo.poNumber,
          companyId: company.companyId,
          requestedGrossAmount: policyEvaluation.pricing.totalGrossAmount.toString(),
          availableCompanyCredit:
            policyEvaluation.availableCompanyCreditBefore.toString(),
        },
      });
      return { po: rejectedPo, policyEvaluation };
    }

    // Case 2: Exceeds buyer auto-approve limit or department monthly budget -> PENDING_APPROVAL + 72h MSI hold
    if (policyEvaluation.decision === "PENDING_APPROVAL") {
      const demands = input.cart.lines.map((l) => ({
        lineId: l.lineId,
        variantId: l.variantId,
        quantity: l.quantity,
      }));
      const effectiveTtlSeconds =
        input.ttlSecondsOverride ?? policyEvaluation.recommendedReservationTtlSeconds;
      const reservation = this.deps.inventoryService.reserveForPurchaseOrder({
        holderId: input.poId,
        demands,
        availabilityMode,
        strategy: allocationStrategy,
        ttlSeconds: effectiveTtlSeconds,
        nowMs,
      });

      const gross = policyEvaluation.pricing.totalGrossAmount;
      this.adjustCreditAndBudget({
        companyId: company.companyId,
        costCenterId: costCenter.costCenterId,
        creditReservedDelta: gross,
        monthlyReservedDelta: gross,
      });

      const pendingPo: B2bPurchaseOrderRecord = {
        poId: input.poId,
        poNumber: input.poNumber,
        companyId: company.companyId,
        companyName: company.name,
        costCenterId: costCenter.costCenterId,
        costCenterName: costCenter.name,
        buyerId: buyer.buyerId,
        buyerName: buyer.fullName,
        buyerRole: buyer.role,
        channelSlug: input.channelSlug,
        stockAvailabilityMode: availabilityMode,
        allocationStrategy,
        status: "PENDING_APPROVAL",
        approvalReasons: policyEvaluation.approvalReasons,
        cart: input.cart,
        pricing: policyEvaluation.pricing,
        standardTaxAmountWithoutExemption:
          policyEvaluation.standardTaxAmountWithoutExemption,
        taxExemptSavingsAmount: policyEvaluation.taxExemptSavingsAmount,
        netTermsDueDays: policyEvaluation.netTermsDueDays,
        reservationTtlSeconds: effectiveTtlSeconds,
        reservationExpiresAt: reservation.expiresAt,
        reservedShipments: reservation.reservationSlices,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.persistPurchaseOrder(pendingPo);
      this.deps.outboxService.enqueue({
        eventType: "b2b.po.pending_approval.v1",
        aggregateType: "B2bPurchaseOrder",
        aggregateId: pendingPo.poId,
        channelSlug: input.channelSlug,
        payload: {
          poId: pendingPo.poId,
          poNumber: pendingPo.poNumber,
          buyerId: buyer.buyerId,
          totalGrossAmount: gross.toString(),
          approvalReasons: policyEvaluation.approvalReasons,
          reservationTtlSeconds: policyEvaluation.recommendedReservationTtlSeconds,
          reservationExpiresAt: reservation.expiresAt,
        },
      });
      return { po: pendingPo, policyEvaluation };
    }

    // Case 3: APPROVED_AUTO -> Execute 3-Step Durable B2B Net-Terms Checkout Saga
    const allocateStep = createStep({
      name: "allocate-b2b-msi-inventory",
      invoke: async () => {
        const demands = input.cart.lines.map((l) => ({
          lineId: l.lineId,
          variantId: l.variantId,
          quantity: l.quantity,
        }));
        return this.deps.inventoryService.allocateForCheckout({
          demands,
          availabilityMode,
          strategy: allocationStrategy,
        });
      },
      compensate: async (allocOut) => {
        this.deps.inventoryService.releaseAllocations(allocOut.allocations);
      },
    });

    const drawCreditStep = createStep({
      name: "draw-b2b-net-terms-credit",
      invoke: async (grossAmount: MinorUnits) => {
        this.adjustCreditAndBudget({
          companyId: company.companyId,
          costCenterId: costCenter.costCenterId,
          creditUsedDelta: grossAmount,
          monthlySpentDelta: grossAmount,
        });
        return {
          drawnAmount: grossAmount,
          invoiceTxId: `net${policyEvaluation.netTermsDueDays}_inv_${input.poNumber}`,
        };
      },
      compensate: async (creditOut) => {
        this.adjustCreditAndBudget({
          companyId: company.companyId,
          costCenterId: costCenter.costCenterId,
          creditUsedDelta: -creditOut.drawnAmount,
          monthlySpentDelta: -creditOut.drawnAmount,
        });
      },
    });

    const commitStep = createStep({
      name: "commit-b2b-order-and-po",
      invoke: async (stepParams: {
        shipments: readonly ShipmentSlice[];
        invoiceTxId: string;
      }): Promise<{ order: OrderRecord; po: B2bPurchaseOrderRecord }> => {
        if (input.simulateCommitFault) {
          throw new Error("B2B_PO_ERP_COMPLIANCE_COMMIT_FAULT");
        }
        const orderId = `ord_${input.poId}`;
        const order: OrderRecord = {
          orderId,
          checkoutId: input.poId,
          channelSlug: input.channelSlug,
          customerId: `${company.companyId}:${buyer.buyerId}`,
          currencyCode: policyEvaluation.pricing.currencyCode,
          pricing: policyEvaluation.pricing,
          shipments: stepParams.shipments,
          paymentStatus: "AUTHORIZED",
          paymentTransactionId: stepParams.invoiceTxId,
          paymentCapturedAmount: policyEvaluation.pricing.totalGrossAmount,
          createdAt: nowIso,
        };

        const approvedPo: B2bPurchaseOrderRecord = {
          poId: input.poId,
          poNumber: input.poNumber,
          companyId: company.companyId,
          companyName: company.name,
          costCenterId: costCenter.costCenterId,
          costCenterName: costCenter.name,
          buyerId: buyer.buyerId,
          buyerName: buyer.fullName,
          buyerRole: buyer.role,
          orderId,
          channelSlug: input.channelSlug,
          stockAvailabilityMode: availabilityMode,
          allocationStrategy,
          status: "APPROVED_AUTO",
          approvalReasons: [],
          cart: input.cart,
          pricing: policyEvaluation.pricing,
          standardTaxAmountWithoutExemption:
            policyEvaluation.standardTaxAmountWithoutExemption,
          taxExemptSavingsAmount: policyEvaluation.taxExemptSavingsAmount,
          netTermsDueDays: policyEvaluation.netTermsDueDays,
          reservationTtlSeconds: policyEvaluation.recommendedReservationTtlSeconds,
          reservedShipments: stepParams.shipments,
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        this.deps.orderStore.set(orderId, order);
        this.persistPurchaseOrder(approvedPo);
        this.deps.outboxService.enqueue({
          eventType: "b2b.po.approved_auto.v1",
          aggregateType: "B2bPurchaseOrder",
          aggregateId: approvedPo.poId,
          channelSlug: input.channelSlug,
          payload: {
            poId: approvedPo.poId,
            poNumber: approvedPo.poNumber,
            orderId,
            totalGrossAmount: policyEvaluation.pricing.totalGrossAmount.toString(),
            taxExemptSavingsAmount:
              policyEvaluation.taxExemptSavingsAmount.toString(),
            netTermsDueDays: policyEvaluation.netTermsDueDays,
          },
        });

        return { order, po: approvedPo };
      },
    });

    const workflow = createWorkflow(
      "b2bAutoApproveCheckoutWorkflow",
      async (_wfInput: SubmitB2bPurchaseOrderInput, ctx) => {
        const alloc = await ctx.run(allocateStep, undefined);
        const credit = await ctx.run(
          drawCreditStep,
          policyEvaluation.pricing.totalGrossAmount
        );
        const committed = await ctx.run(commitStep, {
          shipments: alloc.allocations,
          invoiceTxId: credit.invoiceTxId,
        });
        return committed;
      }
    );

    const wfRes = await workflow.execute(input, {
      idempotencyKey: params.idempotencyKey,
      store: this.deps.workflowStateStore,
    });

    if (wfRes.status !== "COMPLETED" || !wfRes.output) {
      throw new Error(
        `B2B Auto-Approve Saga failed (${wfRes.status}): ${wfRes.errorMessage ?? "unknown error"}`
      );
    }

    return {
      po: wfRes.output.po,
      policyEvaluation,
      order: wfRes.output.order,
    };
  }

  /**
   * Supervisor (`APPROVER` / `COMPANY_ADMIN`) approves or rejects a `PENDING_APPROVAL`
   * Purchase Order.
   *
   * - On `REJECT`: Releases the 72-hour MSI `quantity_reserved` lock back to `Available`
   *   and releases `creditReserved` / `monthlyReserved`.
   * - On `APPROVE`: Runs a 3-step Durable Saga (`convert-po-reservation-to-allocation` ->
   *   `settle-po-reserved-credit-to-used` -> `commit-approved-po-order`) with LIFO compensation.
   */
  async decidePendingPurchaseOrder(params: {
    idempotencyKey: string;
    poId: string;
    approverId: string;
    decision: "APPROVE" | "REJECT";
    simulateCommitFault?: boolean;
  }): Promise<{
    po: B2bPurchaseOrderRecord;
    order?: OrderRecord;
    workflowStatus?: string;
    compensatedSteps?: readonly string[];
  }> {
    const po = this.purchaseOrders.get(params.poId);
    if (!po) {
      throw new Error(`B2B Purchase Order '${params.poId}' not found`);
    }
    if (po.status !== "PENDING_APPROVAL") {
      throw new Error(
        `B2B Purchase Order '${params.poId}' is in status '${po.status}', expected 'PENDING_APPROVAL'`
      );
    }

    const approver = this.buyers.get(params.approverId);
    if (!approver || approver.companyId !== po.companyId) {
      throw new Error(`B2B Approver '${params.approverId}' not found`);
    }
    if (approver.role !== "APPROVER" && approver.role !== "COMPANY_ADMIN") {
      throw new Error(
        `Member '${approver.fullName}' has role '${approver.role}' and cannot approve Purchase Orders`
      );
    }

    const gross = po.pricing.totalGrossAmount;
    const nowIso = new Date().toISOString();

    if (params.decision === "REJECT") {
      this.deps.inventoryService.releaseReservation(po.poId, po.reservedShipments);
      this.adjustCreditAndBudget({
        companyId: po.companyId,
        costCenterId: po.costCenterId,
        creditReservedDelta: -gross,
        monthlyReservedDelta: -gross,
      });

      const rejectedPo: B2bPurchaseOrderRecord = {
        ...po,
        approverId: approver.buyerId,
        approverName: approver.fullName,
        status: "REJECTED_BY_SUPERVISOR",
        updatedAt: nowIso,
      };
      this.persistPurchaseOrder(rejectedPo);
      this.deps.outboxService.enqueue({
        eventType: "b2b.po.rejected_by_supervisor.v1",
        aggregateType: "B2bPurchaseOrder",
        aggregateId: rejectedPo.poId,
        channelSlug: po.channelSlug,
        payload: {
          poId: rejectedPo.poId,
          poNumber: rejectedPo.poNumber,
          approverId: approver.buyerId,
          releasedGrossAmount: gross.toString(),
        },
      });
      return { po: rejectedPo, workflowStatus: "COMPLETED" };
    }

    // Supervisor APPROVE -> 3-Step Durable Saga with LIFO reverse compensation
    const convertStockStep = createStep({
      name: "convert-po-reservation-to-allocation",
      invoke: async () => {
        this.deps.inventoryService.convertReservationToAllocation(
          po.poId,
          po.reservedShipments
        );
        return { convertedSlices: po.reservedShipments };
      },
      compensate: async (out) => {
        this.deps.inventoryService.revertReservationConversion(
          po.poId,
          out.convertedSlices
        );
      },
    });

    const settleCreditStep = createStep({
      name: "settle-po-reserved-credit-to-used",
      invoke: async () => {
        this.adjustCreditAndBudget({
          companyId: po.companyId,
          costCenterId: po.costCenterId,
          creditReservedDelta: -gross,
          creditUsedDelta: gross,
          monthlyReservedDelta: -gross,
          monthlySpentDelta: gross,
        });
        return {
          settledAmount: gross,
          invoiceTxId: `net${po.netTermsDueDays}_inv_${po.poNumber}`,
        };
      },
      compensate: async (out) => {
        this.adjustCreditAndBudget({
          companyId: po.companyId,
          costCenterId: po.costCenterId,
          creditUsedDelta: -out.settledAmount,
          creditReservedDelta: out.settledAmount,
          monthlySpentDelta: -out.settledAmount,
          monthlyReservedDelta: out.settledAmount,
        });
      },
    });

    const commitApprovedOrderStep = createStep({
      name: "commit-approved-po-order",
      invoke: async (stepIn: {
        invoiceTxId: string;
      }): Promise<{ po: B2bPurchaseOrderRecord; order: OrderRecord }> => {
        if (params.simulateCommitFault) {
          throw new Error("B2B_SUPERVISOR_APPROVAL_COMMIT_FAULT");
        }
        const orderId = `ord_${po.poId}`;
        const order: OrderRecord = {
          orderId,
          checkoutId: po.poId,
          channelSlug: po.channelSlug,
          customerId: `${po.companyId}:${po.buyerId}`,
          currencyCode: po.pricing.currencyCode,
          pricing: po.pricing,
          shipments: po.reservedShipments,
          paymentStatus: "AUTHORIZED",
          paymentTransactionId: stepIn.invoiceTxId,
          paymentCapturedAmount: gross,
          createdAt: nowIso,
        };

        const approvedPo: B2bPurchaseOrderRecord = {
          ...po,
          approverId: approver.buyerId,
          approverName: approver.fullName,
          orderId,
          status: "APPROVED_BY_SUPERVISOR",
          updatedAt: nowIso,
        };

        this.deps.orderStore.set(orderId, order);
        this.persistPurchaseOrder(approvedPo);
        this.deps.outboxService.enqueue({
          eventType: "b2b.po.approved_by_supervisor.v1",
          aggregateType: "B2bPurchaseOrder",
          aggregateId: approvedPo.poId,
          channelSlug: po.channelSlug,
          payload: {
            poId: approvedPo.poId,
            poNumber: approvedPo.poNumber,
            orderId,
            approverId: approver.buyerId,
            totalGrossAmount: gross.toString(),
          },
        });

        return { po: approvedPo, order };
      },
    });

    const workflow = createWorkflow(
      "b2bSupervisorApprovalWorkflow",
      async (_wfInput: { poId: string }, ctx) => {
        await ctx.run(convertStockStep, undefined);
        const credit = await ctx.run(settleCreditStep, undefined);
        return await ctx.run(commitApprovedOrderStep, {
          invoiceTxId: credit.invoiceTxId,
        });
      }
    );

    const wfRes = await workflow.execute(
      { poId: po.poId },
      {
        idempotencyKey: params.idempotencyKey,
        store: this.deps.workflowStateStore,
      }
    );

    if (wfRes.status !== "COMPLETED" || !wfRes.output) {
      return {
        po: this.purchaseOrders.get(po.poId)!,
        workflowStatus: wfRes.status,
        compensatedSteps: wfRes.compensatedSteps,
      };
    }

    return {
      po: wfRes.output.po,
      order: wfRes.output.order,
      workflowStatus: wfRes.status,
      compensatedSteps: wfRes.compensatedSteps,
    };
  }

  /**
   * Releases reserved Net-30 credit and department budget for `PENDING_APPROVAL` Purchase
   * Orders whose MSI stock reservations exceeded their TTL window.
   */
  expirePurchaseOrdersByIds(
    holderIds: readonly string[],
    nowMs = Date.now()
  ): B2bPurchaseOrderRecord[] {
    const expiredPos: B2bPurchaseOrderRecord[] = [];
    const nowIso = new Date(nowMs).toISOString();

    for (const poId of holderIds) {
      const po = this.purchaseOrders.get(poId);
      if (!po || po.status !== "PENDING_APPROVAL") continue;

      const gross = po.pricing.totalGrossAmount;
      this.adjustCreditAndBudget({
        companyId: po.companyId,
        costCenterId: po.costCenterId,
        creditReservedDelta: -gross,
        monthlyReservedDelta: -gross,
      });

      const expiredPo: B2bPurchaseOrderRecord = {
        ...po,
        status: "EXPIRED_TTL",
        updatedAt: nowIso,
      };
      this.persistPurchaseOrder(expiredPo);
      this.deps.outboxService.enqueue({
        eventType: "b2b.po.expired_ttl.v1",
        aggregateType: "B2bPurchaseOrder",
        aggregateId: expiredPo.poId,
        channelSlug: po.channelSlug,
        payload: {
          poId: expiredPo.poId,
          poNumber: expiredPo.poNumber,
          releasedGrossAmount: gross.toString(),
          expiredAt: nowIso,
        },
      });
      expiredPos.push(expiredPo);
    }

    return expiredPos;
  }
}

export interface PgB2bServiceDeps {
  readonly pool: PgPoolLike;
  readonly inventoryService: MsiInventoryServiceLike;
  readonly outboxService: OutboxStoreLike;
  readonly workflowStateStore: WorkflowStateStore;
}

interface PgB2bCompanyRow {
  company_id: string;
  name: string;
  tax_id: string;
  tax_exempt_verified: string | boolean;
  payment_terms: B2bPaymentTerms;
  currency_code: string;
  credit_limit: string;
  credit_used: string;
  credit_reserved: string;
  contract_discount_bps: string;
  created_at: string;
}

interface PgB2bCostCenterRow {
  cost_center_id: string;
  company_id: string;
  name: string;
  department_code: string;
  monthly_budget: string;
  monthly_spent: string;
  monthly_reserved: string;
  created_at: string;
}

interface PgB2bBuyerRow {
  buyer_id: string;
  company_id: string;
  cost_center_id: string;
  email: string;
  full_name: string;
  role: B2bBuyerRole;
  single_order_auto_approve_limit: string;
  created_at: string;
}

function parseB2bBool(v: string | boolean | null | undefined): boolean {
  return v === true || v === "t" || v === "true" || v === "1";
}

function normalizeB2bIso(raw: string): string {
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? raw : dt.toISOString();
}

/**
 * PostgreSQL 17-backed Enterprise B2B Organization, Net-Terms Credit Pool & PO Approval Engine.
 * Persists `b2b_companies`, `b2b_cost_centers`, `b2b_buyer_members`, `b2b_purchase_orders`,
 * `orders`, and `transactional_outbox_events` atomically using `FOR UPDATE` locks and TypeScript
 * `BigInt` precision arithmetic.
 */
export class PgB2bOrganizationService {
  private readonly deps: PgB2bServiceDeps;

  constructor(deps: PgB2bServiceDeps) {
    this.deps = deps;
  }

  private runner(tx?: PgTxClient): PgQueryable {
    return tx ?? this.deps.pool;
  }

  private hydrateCompany(row: PgB2bCompanyRow): B2bCompanyRecord {
    return {
      companyId: row.company_id,
      name: row.name,
      taxId: row.tax_id,
      taxExemptVerified: parseB2bBool(row.tax_exempt_verified),
      paymentTerms: row.payment_terms,
      currencyCode: row.currency_code,
      creditLimit: BigInt(row.credit_limit),
      creditUsed: BigInt(row.credit_used),
      creditReserved: BigInt(row.credit_reserved),
      contractDiscountBps: Number(row.contract_discount_bps),
      createdAt: normalizeB2bIso(row.created_at),
    };
  }

  private hydrateCostCenter(row: PgB2bCostCenterRow): B2bCostCenterRecord {
    return {
      costCenterId: row.cost_center_id,
      companyId: row.company_id,
      name: row.name,
      departmentCode: row.department_code,
      monthlyBudget: BigInt(row.monthly_budget),
      monthlySpent: BigInt(row.monthly_spent),
      monthlyReserved: BigInt(row.monthly_reserved),
      createdAt: normalizeB2bIso(row.created_at),
    };
  }

  private hydrateBuyer(row: PgB2bBuyerRow): B2bBuyerMemberRecord {
    return {
      buyerId: row.buyer_id,
      companyId: row.company_id,
      costCenterId: row.cost_center_id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      singleOrderAutoApproveLimit: BigInt(row.single_order_auto_approve_limit),
      createdAt: normalizeB2bIso(row.created_at),
    };
  }

  async seedDefaultEnterpriseHierarchy(): Promise<void> {
    const now = "2026-11-15T08:00:00.000Z";
    await this.deps.pool.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO b2b_companies (
           company_id, name, tax_id, tax_exempt_verified, payment_terms,
           currency_code, credit_limit, credit_used, credit_reserved,
           contract_discount_bps, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
         ON CONFLICT (company_id) DO NOTHING`,
        [
          "comp-kronos-b2b",
          "Kronos Robotics & Defense Corp",
          "US-EIN-94-8821044",
          true,
          "NET_30",
          "USD",
          "5000000",
          "800000",
          "0",
          500,
          now,
        ]
      );

      const costCenters = [
        [
          "cc-hw-lab",
          "comp-kronos-b2b",
          "Autonomous Hardware Lab",
          "ENG-HW-401",
          "1500000",
          "200000",
          "0",
          now,
        ],
        [
          "cc-exec-ops",
          "comp-kronos-b2b",
          "Global Fleet Operations",
          "OPS-FLT-102",
          "3000000",
          "100000",
          "0",
          now,
        ],
      ];
      for (const cc of costCenters) {
        await tx.query(
          `INSERT INTO b2b_cost_centers (
             cost_center_id, company_id, name, department_code,
             monthly_budget, monthly_spent, monthly_reserved, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
           ON CONFLICT (cost_center_id) DO NOTHING`,
          cc
        );
      }

      const members = [
        [
          "buyer-elena",
          "comp-kronos-b2b",
          "cc-hw-lab",
          "elena.vance@kronos-robotics.io",
          "Elena Vance (Procurement Buyer)",
          "BUYER",
          "250000",
          now,
        ],
        [
          "approver-marcus",
          "comp-kronos-b2b",
          "cc-hw-lab",
          "marcus.sterling@kronos-robotics.io",
          "Marcus Sterling (VP Hardware Eng)",
          "APPROVER",
          "1500000",
          now,
        ],
        [
          "admin-victoria",
          "comp-kronos-b2b",
          "cc-exec-ops",
          "victoria.chen@kronos-robotics.io",
          "Victoria Chen (CFO & Company Admin)",
          "COMPANY_ADMIN",
          "5000000",
          now,
        ],
      ];
      for (const m of members) {
        await tx.query(
          `INSERT INTO b2b_buyer_members (
             buyer_id, company_id, cost_center_id, email, full_name,
             role, single_order_auto_approve_limit, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
           ON CONFLICT (buyer_id) DO NOTHING`,
          m
        );
      }
    });
  }

  async upsertCompany(
    company: B2bCompanyRecord,
    tx?: PgTxClient
  ): Promise<void> {
    await this.runner(tx).query(
      `INSERT INTO b2b_companies (
         company_id, name, tax_id, tax_exempt_verified, payment_terms,
         currency_code, credit_limit, credit_used, credit_reserved,
         contract_discount_bps, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
       ON CONFLICT (company_id) DO UPDATE SET
         name = excluded.name,
         tax_id = excluded.tax_id,
         tax_exempt_verified = excluded.tax_exempt_verified,
         payment_terms = excluded.payment_terms,
         credit_limit = excluded.credit_limit,
         credit_used = excluded.credit_used,
         credit_reserved = excluded.credit_reserved,
         contract_discount_bps = excluded.contract_discount_bps`,
      [
        company.companyId,
        company.name,
        company.taxId,
        company.taxExemptVerified,
        company.paymentTerms,
        company.currencyCode,
        company.creditLimit.toString(),
        company.creditUsed.toString(),
        company.creditReserved.toString(),
        company.contractDiscountBps,
        company.createdAt,
      ]
    );
  }

  async upsertCostCenter(
    cc: B2bCostCenterRecord,
    tx?: PgTxClient
  ): Promise<void> {
    await this.runner(tx).query(
      `INSERT INTO b2b_cost_centers (
         cost_center_id, company_id, name, department_code,
         monthly_budget, monthly_spent, monthly_reserved, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       ON CONFLICT (cost_center_id) DO UPDATE SET
         name = excluded.name,
         department_code = excluded.department_code,
         monthly_budget = excluded.monthly_budget,
         monthly_spent = excluded.monthly_spent,
         monthly_reserved = excluded.monthly_reserved`,
      [
        cc.costCenterId,
        cc.companyId,
        cc.name,
        cc.departmentCode,
        cc.monthlyBudget.toString(),
        cc.monthlySpent.toString(),
        cc.monthlyReserved.toString(),
        cc.createdAt,
      ]
    );
  }

  async upsertBuyerMember(
    member: B2bBuyerMemberRecord,
    tx?: PgTxClient
  ): Promise<void> {
    await this.runner(tx).query(
      `INSERT INTO b2b_buyer_members (
         buyer_id, company_id, cost_center_id, email, full_name,
         role, single_order_auto_approve_limit, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       ON CONFLICT (buyer_id) DO UPDATE SET
         cost_center_id = excluded.cost_center_id,
         full_name = excluded.full_name,
         role = excluded.role,
         single_order_auto_approve_limit = excluded.single_order_auto_approve_limit`,
      [
        member.buyerId,
        member.companyId,
        member.costCenterId,
        member.email,
        member.fullName,
        member.role,
        member.singleOrderAutoApproveLimit.toString(),
        member.createdAt,
      ]
    );
  }

  async getCompany(
    companyId: string,
    tx?: PgTxClient
  ): Promise<B2bCompanyRecord | undefined> {
    const res = await this.runner(tx).query<PgB2bCompanyRow>(
      `SELECT company_id, name, tax_id, tax_exempt_verified, payment_terms,
              currency_code, credit_limit, credit_used, credit_reserved,
              contract_discount_bps, created_at
       FROM b2b_companies
       WHERE company_id = $1`,
      [companyId]
    );
    return res.rows[0] ? this.hydrateCompany(res.rows[0]) : undefined;
  }

  async getCostCenter(
    costCenterId: string,
    tx?: PgTxClient
  ): Promise<B2bCostCenterRecord | undefined> {
    const res = await this.runner(tx).query<PgB2bCostCenterRow>(
      `SELECT cost_center_id, company_id, name, department_code,
              monthly_budget, monthly_spent, monthly_reserved, created_at
       FROM b2b_cost_centers
       WHERE cost_center_id = $1`,
      [costCenterId]
    );
    return res.rows[0] ? this.hydrateCostCenter(res.rows[0]) : undefined;
  }

  async getBuyerMember(
    buyerId: string,
    tx?: PgTxClient
  ): Promise<B2bBuyerMemberRecord | undefined> {
    const res = await this.runner(tx).query<PgB2bBuyerRow>(
      `SELECT buyer_id, company_id, cost_center_id, email, full_name,
              role, single_order_auto_approve_limit, created_at
       FROM b2b_buyer_members
       WHERE buyer_id = $1`,
      [buyerId]
    );
    return res.rows[0] ? this.hydrateBuyer(res.rows[0]) : undefined;
  }

  async getPurchaseOrder(
    poId: string,
    tx?: PgTxClient
  ): Promise<B2bPurchaseOrderRecord | undefined> {
    const res = await this.runner(tx).query<{ payload_json: string }>(
      `SELECT payload_json FROM b2b_purchase_orders WHERE po_id = $1`,
      [poId]
    );
    return res.rows[0]
      ? deserializeWithBigInt<B2bPurchaseOrderRecord>(res.rows[0].payload_json)
      : undefined;
  }

  async listCompanies(): Promise<B2bCompanyRecord[]> {
    const res = await this.deps.pool.query<PgB2bCompanyRow>(
      `SELECT company_id, name, tax_id, tax_exempt_verified, payment_terms,
              currency_code, credit_limit, credit_used, credit_reserved,
              contract_discount_bps, created_at
       FROM b2b_companies
       ORDER BY created_at ASC`
    );
    return res.rows.map((r) => this.hydrateCompany(r));
  }

  async listCostCenters(companyId?: string): Promise<B2bCostCenterRecord[]> {
    const res = companyId
      ? await this.deps.pool.query<PgB2bCostCenterRow>(
          `SELECT cost_center_id, company_id, name, department_code,
                  monthly_budget, monthly_spent, monthly_reserved, created_at
           FROM b2b_cost_centers
           WHERE company_id = $1
           ORDER BY created_at ASC`,
          [companyId]
        )
      : await this.deps.pool.query<PgB2bCostCenterRow>(
          `SELECT cost_center_id, company_id, name, department_code,
                  monthly_budget, monthly_spent, monthly_reserved, created_at
           FROM b2b_cost_centers
           ORDER BY created_at ASC`
        );
    return res.rows.map((r) => this.hydrateCostCenter(r));
  }

  async listBuyerMembers(companyId?: string): Promise<B2bBuyerMemberRecord[]> {
    const res = companyId
      ? await this.deps.pool.query<PgB2bBuyerRow>(
          `SELECT buyer_id, company_id, cost_center_id, email, full_name,
                  role, single_order_auto_approve_limit, created_at
           FROM b2b_buyer_members
           WHERE company_id = $1
           ORDER BY created_at ASC`,
          [companyId]
        )
      : await this.deps.pool.query<PgB2bBuyerRow>(
          `SELECT buyer_id, company_id, cost_center_id, email, full_name,
                  role, single_order_auto_approve_limit, created_at
           FROM b2b_buyer_members
           ORDER BY created_at ASC`
        );
    return res.rows.map((r) => this.hydrateBuyer(r));
  }

  async listPurchaseOrders(limit = 20): Promise<B2bPurchaseOrderRecord[]> {
    const res = await this.deps.pool.query<{ payload_json: string }>(
      `SELECT payload_json FROM b2b_purchase_orders ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) =>
      deserializeWithBigInt<B2bPurchaseOrderRecord>(r.payload_json)
    );
  }

  private async persistPurchaseOrder(
    po: B2bPurchaseOrderRecord,
    tx: PgTxClient
  ): Promise<void> {
    await tx.query(
      `INSERT INTO b2b_purchase_orders (
         po_id, po_number, company_id, cost_center_id, buyer_id,
         approver_id, order_id, status, currency_code, total_gross_amount,
         tax_exempt_savings_amount, net_terms_due_days, reservation_ttl_seconds,
         reservation_expires_at, payload_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10,
         $11, $12, $13,
         $14::timestamptz, $15::jsonb, $16::timestamptz, $17::timestamptz
       )
       ON CONFLICT (po_id) DO UPDATE SET
         approver_id = excluded.approver_id,
         order_id = excluded.order_id,
         status = excluded.status,
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      [
        po.poId,
        po.poNumber,
        po.companyId,
        po.costCenterId,
        po.buyerId,
        po.approverId ?? null,
        po.orderId ?? null,
        po.status,
        po.pricing.currencyCode,
        po.pricing.totalGrossAmount.toString(),
        po.taxExemptSavingsAmount.toString(),
        po.netTermsDueDays,
        po.reservationTtlSeconds,
        po.reservationExpiresAt ?? null,
        serializeWithBigInt(po),
        po.createdAt,
        po.updatedAt,
      ]
    );
  }

  private async adjustCreditAndBudget(
    tx: PgTxClient,
    params: {
      companyId: string;
      costCenterId: string;
      creditUsedDelta?: MinorUnits;
      creditReservedDelta?: MinorUnits;
      monthlySpentDelta?: MinorUnits;
      monthlyReservedDelta?: MinorUnits;
    }
  ): Promise<void> {
    const compRes = await tx.query<PgB2bCompanyRow>(
      `SELECT company_id, name, tax_id, tax_exempt_verified, payment_terms,
              currency_code, credit_limit, credit_used, credit_reserved,
              contract_discount_bps, created_at
       FROM b2b_companies
       WHERE company_id = $1
       FOR UPDATE`,
      [params.companyId]
    );
    const ccRes = await tx.query<PgB2bCostCenterRow>(
      `SELECT cost_center_id, company_id, name, department_code,
              monthly_budget, monthly_spent, monthly_reserved, created_at
       FROM b2b_cost_centers
       WHERE cost_center_id = $1
       FOR UPDATE`,
      [params.costCenterId]
    );
    const compRow = compRes.rows[0];
    const ccRow = ccRes.rows[0];
    if (!compRow || !ccRow) {
      throw new Error(`B2B Company or CostCenter not found`);
    }

    const company = this.hydrateCompany(compRow);
    const cc = this.hydrateCostCenter(ccRow);

    const nextCreditUsedRaw = company.creditUsed + (params.creditUsedDelta ?? 0n);
    const nextCreditReservedRaw =
      company.creditReserved + (params.creditReservedDelta ?? 0n);
    const nextMonthlySpentRaw = cc.monthlySpent + (params.monthlySpentDelta ?? 0n);
    const nextMonthlyReservedRaw =
      cc.monthlyReserved + (params.monthlyReservedDelta ?? 0n);

    const nextCreditUsed = nextCreditUsedRaw < 0n ? 0n : nextCreditUsedRaw;
    const nextCreditReserved =
      nextCreditReservedRaw < 0n ? 0n : nextCreditReservedRaw;
    const nextMonthlySpent =
      nextMonthlySpentRaw < 0n ? 0n : nextMonthlySpentRaw;
    const nextMonthlyReserved =
      nextMonthlyReservedRaw < 0n ? 0n : nextMonthlyReservedRaw;

    await tx.query(
      `UPDATE b2b_companies
       SET credit_used = $1, credit_reserved = $2
       WHERE company_id = $3`,
      [nextCreditUsed.toString(), nextCreditReserved.toString(), company.companyId]
    );

    await tx.query(
      `UPDATE b2b_cost_centers
       SET monthly_spent = $1, monthly_reserved = $2
       WHERE cost_center_id = $3`,
      [nextMonthlySpent.toString(), nextMonthlyReserved.toString(), cc.costCenterId]
    );
  }

  private async insertB2bOrder(
    tx: PgTxClient,
    order: OrderRecord
  ): Promise<void> {
    await tx.query(
      `INSERT INTO orders (
         id, checkout_id, channel_slug, customer_id,
         currency_code, total_gross_amount, payment_transaction_id,
         payment_status, allocations_json, payload_json,
         fulfillment_status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, $9::jsonb, $10::jsonb,
         'UNFULFILLED', $11::timestamptz, $11::timestamptz
       )`,
      [
        order.orderId,
        order.checkoutId,
        order.channelSlug,
        order.customerId ?? null,
        order.currencyCode,
        order.pricing.totalGrossAmount.toString(),
        order.paymentTransactionId ?? null,
        order.paymentStatus ?? "AUTHORIZED",
        serializeWithBigInt(order.shipments),
        serializeWithBigInt(order),
        order.createdAt,
      ]
    );
  }

  async submitPurchaseOrder(params: {
    idempotencyKey: string;
    input: SubmitB2bPurchaseOrderInput;
  }): Promise<SubmitB2bPurchaseOrderOutput> {
    const { input } = params;
    const company = await this.getCompany(input.companyId);
    if (!company) {
      throw new Error(`B2B Company '${input.companyId}' not found`);
    }
    const costCenter = await this.getCostCenter(input.costCenterId);
    if (!costCenter || costCenter.companyId !== company.companyId) {
      throw new Error(`B2B Cost Center '${input.costCenterId}' not found`);
    }
    const buyer = await this.getBuyerMember(input.buyerId);
    if (!buyer || buyer.companyId !== company.companyId) {
      throw new Error(`B2B Buyer '${input.buyerId}' not found`);
    }

    const availabilityMode =
      input.stockAvailabilityMode ?? "DIRECT_CHANNEL_WAREHOUSES";
    const allocationStrategy =
      input.allocationStrategy ?? "MINIMIZE_SPLIT_THEN_HIGH_STOCK";

    const policyEvaluation = evaluateB2bPurchasePolicy({
      company: {
        companyId: company.companyId,
        paymentTerms: company.paymentTerms,
        creditLimit: company.creditLimit,
        creditUsed: company.creditUsed,
        creditReserved: company.creditReserved,
        contractDiscountBps: company.contractDiscountBps,
        taxExemptVerified: company.taxExemptVerified,
      },
      costCenter: {
        costCenterId: costCenter.costCenterId,
        monthlyBudget: costCenter.monthlyBudget,
        monthlySpent: costCenter.monthlySpent,
        monthlyReserved: costCenter.monthlyReserved,
      },
      buyer: {
        buyerId: buyer.buyerId,
        role: buyer.role,
        singleOrderAutoApproveLimit: buyer.singleOrderAutoApproveLimit,
      },
      cart: input.cart,
    });

    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();

    if (policyEvaluation.decision === "REJECTED_COMPANY_CREDIT_EXCEEDED") {
      const rejectedPo: B2bPurchaseOrderRecord = {
        poId: input.poId,
        poNumber: input.poNumber,
        companyId: company.companyId,
        companyName: company.name,
        costCenterId: costCenter.costCenterId,
        costCenterName: costCenter.name,
        buyerId: buyer.buyerId,
        buyerName: buyer.fullName,
        buyerRole: buyer.role,
        channelSlug: input.channelSlug,
        stockAvailabilityMode: availabilityMode,
        allocationStrategy,
        status: "REJECTED_COMPANY_CREDIT_EXCEEDED",
        approvalReasons: policyEvaluation.approvalReasons,
        cart: input.cart,
        pricing: policyEvaluation.pricing,
        standardTaxAmountWithoutExemption:
          policyEvaluation.standardTaxAmountWithoutExemption,
        taxExemptSavingsAmount: policyEvaluation.taxExemptSavingsAmount,
        netTermsDueDays: policyEvaluation.netTermsDueDays,
        reservationTtlSeconds: 0,
        reservedShipments: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await this.deps.pool.withTransaction(async (tx) => {
        await this.persistPurchaseOrder(rejectedPo, tx);
        await this.deps.outboxService.enqueue(
          {
            eventType: "b2b.po.rejected_credit_limit.v1",
            aggregateType: "B2bPurchaseOrder",
            aggregateId: rejectedPo.poId,
            channelSlug: input.channelSlug,
            payload: {
              poId: rejectedPo.poId,
              poNumber: rejectedPo.poNumber,
              companyId: company.companyId,
              requestedGrossAmount:
                policyEvaluation.pricing.totalGrossAmount.toString(),
              availableCompanyCredit:
                policyEvaluation.availableCompanyCreditBefore.toString(),
            },
            nowIso,
          },
          tx
        );
      });
      return { po: rejectedPo, policyEvaluation };
    }

    if (policyEvaluation.decision === "PENDING_APPROVAL") {
      const demands = input.cart.lines.map((l) => ({
        lineId: l.lineId,
        variantId: l.variantId,
        quantity: l.quantity,
      }));
      const effectiveTtlSeconds =
        input.ttlSecondsOverride ?? policyEvaluation.recommendedReservationTtlSeconds;
      const gross = policyEvaluation.pricing.totalGrossAmount;

      const pendingPo = await this.deps.pool.withTransaction(async (tx) => {
        const reservation = await this.deps.inventoryService.reserveForPurchaseOrder(
          {
            holderId: input.poId,
            demands,
            availabilityMode,
            strategy: allocationStrategy,
            ttlSeconds: effectiveTtlSeconds,
            nowMs,
          },
          tx
        );

        await this.adjustCreditAndBudget(tx, {
          companyId: company.companyId,
          costCenterId: costCenter.costCenterId,
          creditReservedDelta: gross,
          monthlyReservedDelta: gross,
        });

        const record: B2bPurchaseOrderRecord = {
          poId: input.poId,
          poNumber: input.poNumber,
          companyId: company.companyId,
          companyName: company.name,
          costCenterId: costCenter.costCenterId,
          costCenterName: costCenter.name,
          buyerId: buyer.buyerId,
          buyerName: buyer.fullName,
          buyerRole: buyer.role,
          channelSlug: input.channelSlug,
          stockAvailabilityMode: availabilityMode,
          allocationStrategy,
          status: "PENDING_APPROVAL",
          approvalReasons: policyEvaluation.approvalReasons,
          cart: input.cart,
          pricing: policyEvaluation.pricing,
          standardTaxAmountWithoutExemption:
            policyEvaluation.standardTaxAmountWithoutExemption,
          taxExemptSavingsAmount: policyEvaluation.taxExemptSavingsAmount,
          netTermsDueDays: policyEvaluation.netTermsDueDays,
          reservationTtlSeconds: effectiveTtlSeconds,
          reservationExpiresAt: reservation.expiresAt,
          reservedShipments: reservation.reservationSlices,
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        await this.persistPurchaseOrder(record, tx);
        await this.deps.outboxService.enqueue(
          {
            eventType: "b2b.po.pending_approval.v1",
            aggregateType: "B2bPurchaseOrder",
            aggregateId: record.poId,
            channelSlug: input.channelSlug,
            payload: {
              poId: record.poId,
              poNumber: record.poNumber,
              buyerId: buyer.buyerId,
              totalGrossAmount: gross.toString(),
              approvalReasons: policyEvaluation.approvalReasons,
              reservationTtlSeconds: policyEvaluation.recommendedReservationTtlSeconds,
              reservationExpiresAt: reservation.expiresAt,
            },
            nowIso,
          },
          tx
        );
        return record;
      });

      return { po: pendingPo, policyEvaluation };
    }

    // APPROVED_AUTO -> 3-Step Durable B2B Net-Terms Checkout Saga
    const allocateStep = createStep({
      name: "allocate-b2b-msi-inventory",
      invoke: async () => {
        const demands = input.cart.lines.map((l) => ({
          lineId: l.lineId,
          variantId: l.variantId,
          quantity: l.quantity,
        }));
        return await this.deps.inventoryService.allocateForCheckout({
          demands,
          availabilityMode,
          strategy: allocationStrategy,
        });
      },
      compensate: async (allocOut) => {
        await this.deps.inventoryService.releaseAllocations(allocOut.allocations);
      },
    });

    const drawCreditStep = createStep({
      name: "draw-b2b-net-terms-credit",
      invoke: async (grossAmount: MinorUnits) => {
        await this.deps.pool.withTransaction(async (tx) => {
          await this.adjustCreditAndBudget(tx, {
            companyId: company.companyId,
            costCenterId: costCenter.costCenterId,
            creditUsedDelta: grossAmount,
            monthlySpentDelta: grossAmount,
          });
        });
        return {
          drawnAmount: grossAmount,
          invoiceTxId: `net${policyEvaluation.netTermsDueDays}_inv_${input.poNumber}`,
        };
      },
      compensate: async (creditOut) => {
        await this.deps.pool.withTransaction(async (tx) => {
          await this.adjustCreditAndBudget(tx, {
            companyId: company.companyId,
            costCenterId: costCenter.costCenterId,
            creditUsedDelta: -creditOut.drawnAmount,
            monthlySpentDelta: -creditOut.drawnAmount,
          });
        });
      },
    });

    const commitStep = createStep({
      name: "commit-b2b-order-and-po",
      invoke: async (stepParams: {
        shipments: readonly ShipmentSlice[];
        invoiceTxId: string;
      }): Promise<{ order: OrderRecord; po: B2bPurchaseOrderRecord }> => {
        if (input.simulateCommitFault) {
          throw new Error("B2B_PO_ERP_COMPLIANCE_COMMIT_FAULT");
        }
        const orderId = `ord_${input.poId}`;
        const order: OrderRecord = {
          orderId,
          checkoutId: input.poId,
          channelSlug: input.channelSlug,
          customerId: `${company.companyId}:${buyer.buyerId}`,
          currencyCode: policyEvaluation.pricing.currencyCode,
          pricing: policyEvaluation.pricing,
          shipments: stepParams.shipments,
          paymentStatus: "AUTHORIZED",
          paymentTransactionId: stepParams.invoiceTxId,
          paymentCapturedAmount: policyEvaluation.pricing.totalGrossAmount,
          createdAt: nowIso,
        };

        const approvedPo: B2bPurchaseOrderRecord = {
          poId: input.poId,
          poNumber: input.poNumber,
          companyId: company.companyId,
          companyName: company.name,
          costCenterId: costCenter.costCenterId,
          costCenterName: costCenter.name,
          buyerId: buyer.buyerId,
          buyerName: buyer.fullName,
          buyerRole: buyer.role,
          orderId,
          channelSlug: input.channelSlug,
          stockAvailabilityMode: availabilityMode,
          allocationStrategy,
          status: "APPROVED_AUTO",
          approvalReasons: [],
          cart: input.cart,
          pricing: policyEvaluation.pricing,
          standardTaxAmountWithoutExemption:
            policyEvaluation.standardTaxAmountWithoutExemption,
          taxExemptSavingsAmount: policyEvaluation.taxExemptSavingsAmount,
          netTermsDueDays: policyEvaluation.netTermsDueDays,
          reservationTtlSeconds: policyEvaluation.recommendedReservationTtlSeconds,
          reservedShipments: stepParams.shipments,
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        await this.deps.pool.withTransaction(async (tx) => {
          await this.insertB2bOrder(tx, order);
          await this.persistPurchaseOrder(approvedPo, tx);
          await this.deps.outboxService.enqueue(
            {
              eventType: "b2b.po.approved_auto.v1",
              aggregateType: "B2bPurchaseOrder",
              aggregateId: approvedPo.poId,
              channelSlug: input.channelSlug,
              payload: {
                poId: approvedPo.poId,
                poNumber: approvedPo.poNumber,
                orderId,
                totalGrossAmount:
                  policyEvaluation.pricing.totalGrossAmount.toString(),
                taxExemptSavingsAmount:
                  policyEvaluation.taxExemptSavingsAmount.toString(),
                netTermsDueDays: policyEvaluation.netTermsDueDays,
              },
              nowIso,
            },
            tx
          );
        });

        return { order, po: approvedPo };
      },
    });

    const workflow = createWorkflow(
      "b2bAutoApproveCheckoutWorkflow",
      async (_wfInput: SubmitB2bPurchaseOrderInput, ctx) => {
        const alloc = await ctx.run(allocateStep, undefined);
        const credit = await ctx.run(
          drawCreditStep,
          policyEvaluation.pricing.totalGrossAmount
        );
        return await ctx.run(commitStep, {
          shipments: alloc.allocations,
          invoiceTxId: credit.invoiceTxId,
        });
      }
    );

    const wfRes = await workflow.execute(input, {
      idempotencyKey: params.idempotencyKey,
      store: this.deps.workflowStateStore,
    });

    if (wfRes.status !== "COMPLETED" || !wfRes.output) {
      throw new Error(
        `B2B Auto-Approve Saga failed (${wfRes.status}): ${wfRes.errorMessage ?? "unknown error"}`
      );
    }

    return {
      po: wfRes.output.po,
      policyEvaluation,
      order: wfRes.output.order,
    };
  }

  async decidePendingPurchaseOrder(params: {
    idempotencyKey: string;
    poId: string;
    approverId: string;
    approverDisplayName?: string;
    allowAdminPrincipal?: boolean;
    decision: "APPROVE" | "REJECT";
    simulateCommitFault?: boolean;
  }): Promise<{
    po: B2bPurchaseOrderRecord;
    order?: OrderRecord;
    workflowStatus?: string;
    compensatedSteps?: readonly string[];
  }> {
    const po = await this.getPurchaseOrder(params.poId);
    if (!po) {
      throw new Error(`B2B Purchase Order '${params.poId}' not found`);
    }
    if (po.status !== "PENDING_APPROVAL") {
      throw new Error(
        `B2B Purchase Order '${params.poId}' is in status '${po.status}', expected 'PENDING_APPROVAL'`
      );
    }

    const buyerApprover = await this.getBuyerMember(params.approverId);
    let approverId = params.approverId;
    let approverName = params.approverDisplayName ?? params.approverId;

    if (buyerApprover && buyerApprover.companyId === po.companyId) {
      if (
        buyerApprover.role !== "APPROVER" &&
        buyerApprover.role !== "COMPANY_ADMIN"
      ) {
        throw new Error(
          `Member '${buyerApprover.fullName}' has role '${buyerApprover.role}' and cannot approve Purchase Orders`
        );
      }
      approverId = buyerApprover.buyerId;
      approverName = buyerApprover.fullName;
    } else if (!params.allowAdminPrincipal) {
      throw new Error(`B2B Approver '${params.approverId}' not found`);
    }

    const gross = po.pricing.totalGrossAmount;
    const nowIso = new Date().toISOString();

    if (params.decision === "REJECT") {
      const rejectedPo: B2bPurchaseOrderRecord = {
        ...po,
        approverId,
        approverName,
        status: "REJECTED_BY_SUPERVISOR",
        updatedAt: nowIso,
      };
      await this.deps.pool.withTransaction(async (tx) => {
        await this.deps.inventoryService.releaseReservation(
          po.poId,
          po.reservedShipments,
          tx
        );
        await this.adjustCreditAndBudget(tx, {
          companyId: po.companyId,
          costCenterId: po.costCenterId,
          creditReservedDelta: -gross,
          monthlyReservedDelta: -gross,
        });
        await this.persistPurchaseOrder(rejectedPo, tx);
        await this.deps.outboxService.enqueue(
          {
            eventType: "b2b.po.rejected_by_supervisor.v1",
            aggregateType: "B2bPurchaseOrder",
            aggregateId: rejectedPo.poId,
            channelSlug: po.channelSlug,
            payload: {
              poId: rejectedPo.poId,
              poNumber: rejectedPo.poNumber,
              approverId,
              releasedGrossAmount: gross.toString(),
            },
            nowIso,
          },
          tx
        );
      });
      return { po: rejectedPo, workflowStatus: "COMPLETED" };
    }

    const convertStockStep = createStep({
      name: "convert-po-reservation-to-allocation",
      invoke: async () => {
        await this.deps.inventoryService.convertReservationToAllocation(
          po.poId,
          po.reservedShipments
        );
        return { convertedSlices: po.reservedShipments };
      },
      compensate: async (out) => {
        await this.deps.inventoryService.revertReservationConversion(
          po.poId,
          out.convertedSlices
        );
      },
    });

    const settleCreditStep = createStep({
      name: "settle-po-reserved-credit-to-used",
      invoke: async () => {
        await this.deps.pool.withTransaction(async (tx) => {
          await this.adjustCreditAndBudget(tx, {
            companyId: po.companyId,
            costCenterId: po.costCenterId,
            creditReservedDelta: -gross,
            creditUsedDelta: gross,
            monthlyReservedDelta: -gross,
            monthlySpentDelta: gross,
          });
        });
        return {
          settledAmount: gross,
          invoiceTxId: `net${po.netTermsDueDays}_inv_${po.poNumber}`,
        };
      },
      compensate: async (out) => {
        await this.deps.pool.withTransaction(async (tx) => {
          await this.adjustCreditAndBudget(tx, {
            companyId: po.companyId,
            costCenterId: po.costCenterId,
            creditUsedDelta: -out.settledAmount,
            creditReservedDelta: out.settledAmount,
            monthlySpentDelta: -out.settledAmount,
            monthlyReservedDelta: out.settledAmount,
          });
        });
      },
    });

    const commitApprovedOrderStep = createStep({
      name: "commit-approved-po-order",
      invoke: async (stepIn: {
        invoiceTxId: string;
      }): Promise<{ po: B2bPurchaseOrderRecord; order: OrderRecord }> => {
        if (params.simulateCommitFault) {
          throw new Error("B2B_SUPERVISOR_APPROVAL_COMMIT_FAULT");
        }
        const orderId = `ord_${po.poId}`;
        const order: OrderRecord = {
          orderId,
          checkoutId: po.poId,
          channelSlug: po.channelSlug,
          customerId: `${po.companyId}:${po.buyerId}`,
          currencyCode: po.pricing.currencyCode,
          pricing: po.pricing,
          shipments: po.reservedShipments,
          paymentStatus: "AUTHORIZED",
          paymentTransactionId: stepIn.invoiceTxId,
          paymentCapturedAmount: gross,
          createdAt: nowIso,
        };

        const approvedPo: B2bPurchaseOrderRecord = {
          ...po,
          approverId,
          approverName,
          orderId,
          status: "APPROVED_BY_SUPERVISOR",
          updatedAt: nowIso,
        };

        await this.deps.pool.withTransaction(async (tx) => {
          await this.insertB2bOrder(tx, order);
          await this.persistPurchaseOrder(approvedPo, tx);
          await this.deps.outboxService.enqueue(
            {
              eventType: "b2b.po.approved_by_supervisor.v1",
              aggregateType: "B2bPurchaseOrder",
              aggregateId: approvedPo.poId,
              channelSlug: po.channelSlug,
              payload: {
                poId: approvedPo.poId,
                poNumber: approvedPo.poNumber,
                orderId,
                approverId,
                totalGrossAmount: gross.toString(),
              },
              nowIso,
            },
            tx
          );
        });

        return { po: approvedPo, order };
      },
    });

    const workflow = createWorkflow(
      "b2bSupervisorApprovalWorkflow",
      async (_wfInput: { poId: string }, ctx) => {
        await ctx.run(convertStockStep, undefined);
        const credit = await ctx.run(settleCreditStep, undefined);
        return await ctx.run(commitApprovedOrderStep, {
          invoiceTxId: credit.invoiceTxId,
        });
      }
    );

    const wfRes = await workflow.execute(
      { poId: po.poId },
      {
        idempotencyKey: params.idempotencyKey,
        store: this.deps.workflowStateStore,
      }
    );

    if (wfRes.status !== "COMPLETED" || !wfRes.output) {
      return {
        po: (await this.getPurchaseOrder(po.poId))!,
        workflowStatus: wfRes.status,
        compensatedSteps: wfRes.compensatedSteps,
      };
    }

    return {
      po: wfRes.output.po,
      order: wfRes.output.order,
      workflowStatus: wfRes.status,
      compensatedSteps: wfRes.compensatedSteps,
    };
  }

  async expirePurchaseOrdersByIds(
    holderIds: readonly string[],
    nowMs = Date.now(),
    tx?: PgTxClient
  ): Promise<B2bPurchaseOrderRecord[]> {
    const uniqueIds = [...new Set(holderIds)];
    if (uniqueIds.length === 0) return [];
    const nowIso = new Date(nowMs).toISOString();

    const exec = async (q: PgTxClient): Promise<B2bPurchaseOrderRecord[]> => {
      const placeholders = uniqueIds.map((_, idx) => `$${idx + 1}`).join(", ");
      const res = await q.query<{ payload_json: string }>(
        `SELECT payload_json
         FROM b2b_purchase_orders
         WHERE po_id IN (${placeholders}) AND status = 'PENDING_APPROVAL'
         ORDER BY po_id ASC
         FOR UPDATE`,
        uniqueIds
      );

      const expiredPos: B2bPurchaseOrderRecord[] = [];
      for (const row of res.rows) {
        const po = deserializeWithBigInt<B2bPurchaseOrderRecord>(row.payload_json);
        const gross = po.pricing.totalGrossAmount;
        await this.adjustCreditAndBudget(q, {
          companyId: po.companyId,
          costCenterId: po.costCenterId,
          creditReservedDelta: -gross,
          monthlyReservedDelta: -gross,
        });

        const expiredPo: B2bPurchaseOrderRecord = {
          ...po,
          status: "EXPIRED_TTL",
          updatedAt: nowIso,
        };
        await this.persistPurchaseOrder(expiredPo, q);
        await this.deps.outboxService.enqueue(
          {
            eventType: "b2b.po.expired_ttl.v1",
            aggregateType: "B2bPurchaseOrder",
            aggregateId: expiredPo.poId,
            channelSlug: po.channelSlug,
            payload: {
              poId: expiredPo.poId,
              poNumber: expiredPo.poNumber,
              releasedGrossAmount: gross.toString(),
              expiredAt: nowIso,
            },
            nowIso,
          },
          q
        );
        expiredPos.push(expiredPo);
      }
      return expiredPos;
    };

    return tx ? tx.withTransaction(exec) : this.deps.pool.withTransaction(exec);
  }
}

export async function syncB2bToPostgres(
  b2b: B2bOrganizationService,
  options: { pool: PgPoolLike }
): Promise<{ companies: number; costCenters: number; buyers: number; purchaseOrders: number }> {
  const companies = b2b.listCompanies();
  const costCenters = b2b.listCostCenters();
  const buyers = b2b.listBuyerMembers();
  const purchaseOrders = b2b.listPurchaseOrders(100);

  for (const c of companies) {
    await options.pool.query(
      `INSERT INTO b2b_companies (
         company_id, name, tax_id, tax_exempt_verified, payment_terms,
         currency_code, credit_limit, credit_used, credit_reserved,
         contract_discount_bps, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
       ON CONFLICT (company_id) DO UPDATE SET
         name = EXCLUDED.name,
         tax_id = EXCLUDED.tax_id,
         tax_exempt_verified = EXCLUDED.tax_exempt_verified,
         payment_terms = EXCLUDED.payment_terms,
         currency_code = EXCLUDED.currency_code,
         credit_limit = EXCLUDED.credit_limit,
         credit_used = EXCLUDED.credit_used,
         credit_reserved = EXCLUDED.credit_reserved,
         contract_discount_bps = EXCLUDED.contract_discount_bps`,
      [
        c.companyId,
        c.name,
        c.taxId,
        c.taxExemptVerified,
        c.paymentTerms,
        c.currencyCode,
        c.creditLimit.toString(),
        c.creditUsed.toString(),
        c.creditReserved.toString(),
        c.contractDiscountBps,
        c.createdAt,
      ]
    );
  }

  for (const cc of costCenters) {
    await options.pool.query(
      `INSERT INTO b2b_cost_centers (
         cost_center_id, company_id, name, department_code,
         monthly_budget, monthly_spent, monthly_reserved, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       ON CONFLICT (cost_center_id) DO UPDATE SET
         name = EXCLUDED.name,
         department_code = EXCLUDED.department_code,
         monthly_budget = EXCLUDED.monthly_budget,
         monthly_spent = EXCLUDED.monthly_spent,
         monthly_reserved = EXCLUDED.monthly_reserved`,
      [
        cc.costCenterId,
        cc.companyId,
        cc.name,
        cc.departmentCode,
        cc.monthlyBudget.toString(),
        cc.monthlySpent.toString(),
        cc.monthlyReserved.toString(),
        cc.createdAt,
      ]
    );
  }

  for (const b of buyers) {
    await options.pool.query(
      `INSERT INTO b2b_buyer_members (
         buyer_id, company_id, cost_center_id, email, full_name,
         role, single_order_auto_approve_limit, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       ON CONFLICT (buyer_id) DO UPDATE SET
         cost_center_id = EXCLUDED.cost_center_id,
         email = EXCLUDED.email,
         full_name = EXCLUDED.full_name,
         role = EXCLUDED.role,
         single_order_auto_approve_limit = EXCLUDED.single_order_auto_approve_limit`,
      [
        b.buyerId,
        b.companyId,
        b.costCenterId,
        b.email,
        b.fullName,
        b.role,
        b.singleOrderAutoApproveLimit.toString(),
        b.createdAt,
      ]
    );
  }

  for (const po of purchaseOrders) {
    await options.pool.query(
      `INSERT INTO b2b_purchase_orders (
         po_id, po_number, company_id, cost_center_id, buyer_id,
         approver_id, order_id, status, currency_code, total_gross_amount,
         tax_exempt_savings_amount, net_terms_due_days, reservation_ttl_seconds,
         reservation_expires_at, payload_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10,
         $11, $12, $13,
         $14::timestamptz, $15::jsonb, $16::timestamptz, $17::timestamptz
       )
       ON CONFLICT (po_id) DO UPDATE SET
         approver_id = EXCLUDED.approver_id,
         order_id = EXCLUDED.order_id,
         status = EXCLUDED.status,
         total_gross_amount = EXCLUDED.total_gross_amount,
         payload_json = EXCLUDED.payload_json,
         updated_at = EXCLUDED.updated_at`,
      [
        po.poId,
        po.poNumber,
        po.companyId,
        po.costCenterId,
        po.buyerId,
        po.approverId ?? null,
        po.orderId ?? null,
        po.status,
        po.pricing.currencyCode,
        po.pricing.totalGrossAmount.toString(),
        po.taxExemptSavingsAmount.toString(),
        po.netTermsDueDays,
        po.reservationTtlSeconds,
        po.reservationExpiresAt ?? null,
        serializeWithBigInt(po),
        po.createdAt,
        po.updatedAt,
      ]
    );
  }

  return {
    companies: companies.length,
    costCenters: costCenters.length,
    buyers: buyers.length,
    purchaseOrders: purchaseOrders.length,
  };
}

export async function hydrateB2bFromPostgres(
  b2b: B2bOrganizationService,
  options: { pool: PgPoolLike }
): Promise<boolean> {
  const compRes = await options.pool.query<PgB2bCompanyRow>(
    `SELECT company_id, name, tax_id, tax_exempt_verified, payment_terms,
            currency_code, credit_limit, credit_used, credit_reserved,
            contract_discount_bps, created_at
     FROM b2b_companies
     ORDER BY created_at ASC`
  );
  if (compRes.rows.length === 0) return false;

  for (const r of compRes.rows) {
    b2b.upsertCompany({
      companyId: r.company_id,
      name: r.name,
      taxId: r.tax_id,
      taxExemptVerified:
        r.tax_exempt_verified === true ||
        r.tax_exempt_verified === "t" ||
        r.tax_exempt_verified === "true",
      paymentTerms: r.payment_terms,
      currencyCode: r.currency_code,
      creditLimit: BigInt(r.credit_limit),
      creditUsed: BigInt(r.credit_used),
      creditReserved: BigInt(r.credit_reserved),
      contractDiscountBps: Number(r.contract_discount_bps),
      createdAt: normalizeB2bIso(r.created_at),
    });
  }

  const ccRes = await options.pool.query<PgB2bCostCenterRow>(
    `SELECT cost_center_id, company_id, name, department_code,
            monthly_budget, monthly_spent, monthly_reserved, created_at
     FROM b2b_cost_centers
     ORDER BY created_at ASC`
  );
  for (const r of ccRes.rows) {
    b2b.upsertCostCenter({
      costCenterId: r.cost_center_id,
      companyId: r.company_id,
      name: r.name,
      departmentCode: r.department_code,
      monthlyBudget: BigInt(r.monthly_budget),
      monthlySpent: BigInt(r.monthly_spent),
      monthlyReserved: BigInt(r.monthly_reserved),
      createdAt: normalizeB2bIso(r.created_at),
    });
  }

  const bRes = await options.pool.query<PgB2bBuyerRow>(
    `SELECT buyer_id, company_id, cost_center_id, email, full_name,
            role, single_order_auto_approve_limit, created_at
     FROM b2b_buyer_members
     ORDER BY created_at ASC`
  );
  for (const r of bRes.rows) {
    b2b.upsertBuyerMember({
      buyerId: r.buyer_id,
      companyId: r.company_id,
      costCenterId: r.cost_center_id,
      email: r.email,
      fullName: r.full_name,
      role: r.role,
      singleOrderAutoApproveLimit: BigInt(r.single_order_auto_approve_limit),
      createdAt: normalizeB2bIso(r.created_at),
    });
  }

  const poRes = await options.pool.query<{ payload_json: string }>(
    `SELECT payload_json FROM b2b_purchase_orders ORDER BY created_at ASC`
  );
  for (const r of poRes.rows) {
    const po = deserializeWithBigInt<B2bPurchaseOrderRecord>(r.payload_json);
    b2b.upsertPurchaseOrder(po);
  }

  return true;
}
