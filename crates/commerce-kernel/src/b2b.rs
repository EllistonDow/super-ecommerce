//! Enterprise B2B Organization Hierarchy, Tax Exemption, Volume Tier & Net-Terms Credit Policy Kernel.
//!
//! Evaluates a B2B purchase order across the 3-tier corporate hierarchy:
//! 1. `Company`     — Net-30 / Net-60 credit pool (`credit_limit - credit_used - credit_reserved`),
//!                    negotiated contract discount (`contract_discount_bps`), and verified tax-exemption certificate.
//! 2. `CostCenter`  — Department monthly budget (`monthly_budget - monthly_spent - monthly_reserved`).
//! 3. `BuyerMember` — Role (`Buyer` | `Approver` | `CompanyAdmin`) and `single_order_auto_approve_limit`.
//!
//! All monetary calculations execute in deterministic integer `MinorUnits` (`i64` / `i128`).

use crate::money::{Bps, MinorUnits};
use crate::pricing::{
    calculate_cart, CandidateOrderDiscount, CartCalculationInput, CartCalculationResult,
    DiscountValue, OrderDiscountKind,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum B2bPaymentTerms {
    Net30,
    Net60,
    PrepaidOnly,
}

impl B2bPaymentTerms {
    pub fn due_days(self) -> u32 {
        match self {
            B2bPaymentTerms::Net30 => 30,
            B2bPaymentTerms::Net60 => 60,
            B2bPaymentTerms::PrepaidOnly => 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum B2bBuyerRole {
    Buyer,
    Approver,
    CompanyAdmin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum B2bPolicyDecisionStatus {
    ApprovedAuto,
    PendingApproval,
    RejectedCompanyCreditExceeded,
}

#[derive(Debug, Clone)]
pub struct B2bCompanyPolicyInput {
    pub company_id: String,
    pub payment_terms: B2bPaymentTerms,
    pub credit_limit: MinorUnits,
    pub credit_used: MinorUnits,
    pub credit_reserved: MinorUnits,
    pub contract_discount_bps: Bps,
    pub tax_exempt_verified: bool,
}

#[derive(Debug, Clone)]
pub struct B2bCostCenterPolicyInput {
    pub cost_center_id: String,
    pub monthly_budget: MinorUnits,
    pub monthly_spent: MinorUnits,
    pub monthly_reserved: MinorUnits,
}

#[derive(Debug, Clone)]
pub struct B2bBuyerPolicyInput {
    pub buyer_id: String,
    pub role: B2bBuyerRole,
    pub single_order_auto_approve_limit: MinorUnits,
}

#[derive(Debug, Clone)]
pub struct B2bPurchasePolicyInput {
    pub company: B2bCompanyPolicyInput,
    pub cost_center: B2bCostCenterPolicyInput,
    pub buyer: B2bBuyerPolicyInput,
    pub cart: CartCalculationInput,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct B2bPurchasePolicyResult {
    pub decision: B2bPolicyDecisionStatus,
    pub approval_reasons: Vec<String>,
    pub pricing: CartCalculationResult,
    pub standard_tax_amount_without_exemption: MinorUnits,
    pub tax_exempt_savings_amount: MinorUnits,
    pub available_company_credit_before: MinorUnits,
    pub available_company_credit_after: MinorUnits,
    pub available_cost_center_budget_before: MinorUnits,
    pub available_cost_center_budget_after: MinorUnits,
    pub net_terms_due_days: u32,
    pub recommended_reservation_ttl_seconds: u32,
}

/// Evaluates a B2B purchase order against corporate credit pool, cost-center monthly budget,
/// buyer auto-approval threshold, negotiated contract discount, and tax-exemption status.
pub fn evaluate_b2b_purchase_policy(input: &B2bPurchasePolicyInput) -> B2bPurchasePolicyResult {
    // 1. Build a B2B-enriched cart with negotiated contract discount (if configured)
    let mut cart_with_contract = input.cart.clone();
    if input.company.contract_discount_bps > 0 {
        let contract_discount_id = format!("b2b-contract-{}", input.company.company_id);
        let already_present = cart_with_contract
            .candidate_order_discounts
            .iter()
            .any(|d| d.discount_id == contract_discount_id);
        if !already_present {
            cart_with_contract
                .candidate_order_discounts
                .push(CandidateOrderDiscount {
                    discount_id: contract_discount_id,
                    name: format!(
                        "B2B Contract Discount ({:.2}%)",
                        (input.company.contract_discount_bps as f64) / 100.0
                    ),
                    kind: OrderDiscountKind::OrderPromotion,
                    value: DiscountValue::Percentage(input.company.contract_discount_bps),
                });
        }
    }

    // Calculate baseline tax before B2B tax-exemption certificate is applied
    let baseline_pricing = calculate_cart(&cart_with_contract);
    let standard_tax_amount = baseline_pricing.total_tax_amount;

    // 2. If the company holds a verified B2B tax-exemption certificate, zero out all tax rates
    let pricing = if input.company.tax_exempt_verified {
        let mut exempt_cart = cart_with_contract;
        for line in &mut exempt_cart.lines {
            line.tax_rate_bps = 0;
        }
        exempt_cart.shipping_tax_rate_bps = 0;
        calculate_cart(&exempt_cart)
    } else {
        baseline_pricing
    };

    let tax_exempt_savings_amount = (standard_tax_amount - pricing.total_tax_amount).max(0);
    let order_gross = pricing.total_gross_amount;

    // 3. Compute available corporate credit and cost-center budget in MinorUnits
    let available_company_credit_before = (input.company.credit_limit
        - input.company.credit_used
        - input.company.credit_reserved)
        .max(0);

    let available_cost_center_budget_before = (input.cost_center.monthly_budget
        - input.cost_center.monthly_spent
        - input.cost_center.monthly_reserved)
        .max(0);

    // 4. Hard gate: Net-30 / Net-60 orders cannot exceed the company's available credit pool
    if input.company.payment_terms != B2bPaymentTerms::PrepaidOnly
        && order_gross > available_company_credit_before
    {
        return B2bPurchasePolicyResult {
            decision: B2bPolicyDecisionStatus::RejectedCompanyCreditExceeded,
            approval_reasons: vec![format!(
                "COMPANY_CREDIT_EXCEEDED: order {} > available credit {}",
                order_gross, available_company_credit_before
            )],
            pricing,
            standard_tax_amount_without_exemption: standard_tax_amount,
            tax_exempt_savings_amount,
            available_company_credit_before,
            available_company_credit_after: available_company_credit_before,
            available_cost_center_budget_before,
            available_cost_center_budget_after: available_cost_center_budget_before,
            net_terms_due_days: input.company.payment_terms.due_days(),
            recommended_reservation_ttl_seconds: 0,
        };
    }

    // 5. Supervisory PO approval check for Buyer role
    let mut approval_reasons = Vec::new();
    if input.buyer.role == B2bBuyerRole::Buyer {
        if order_gross > input.buyer.single_order_auto_approve_limit {
            approval_reasons.push(format!(
                "BUYER_AUTO_APPROVE_LIMIT_EXCEEDED: order {} > limit {}",
                order_gross, input.buyer.single_order_auto_approve_limit
            ));
        }
        if order_gross > available_cost_center_budget_before {
            approval_reasons.push(format!(
                "COST_CENTER_BUDGET_EXCEEDED: order {} > remaining budget {}",
                order_gross, available_cost_center_budget_before
            ));
        }
    } else if input.buyer.role == B2bBuyerRole::Approver
        && order_gross > available_cost_center_budget_before
    {
        // Department Approvers still require CompanyAdmin sign-off if department monthly budget is exceeded
        approval_reasons.push(format!(
            "COST_CENTER_BUDGET_EXCEEDED: order {} > remaining budget {}",
            order_gross, available_cost_center_budget_before
        ));
    }

    let decision = if approval_reasons.is_empty() {
        B2bPolicyDecisionStatus::ApprovedAuto
    } else {
        B2bPolicyDecisionStatus::PendingApproval
    };

    let available_company_credit_after = if input.company.payment_terms != B2bPaymentTerms::PrepaidOnly
    {
        (available_company_credit_before - order_gross).max(0)
    } else {
        available_company_credit_before
    };

    let available_cost_center_budget_after =
        (available_cost_center_budget_before - order_gross).max(0);

    let recommended_reservation_ttl_seconds = match decision {
        B2bPolicyDecisionStatus::ApprovedAuto => 900,         // 15 minutes standard checkout lock
        B2bPolicyDecisionStatus::PendingApproval => 259_200,  // 72 hours supervisory PO approval lock
        B2bPolicyDecisionStatus::RejectedCompanyCreditExceeded => 0,
    };

    B2bPurchasePolicyResult {
        decision,
        approval_reasons,
        pricing,
        standard_tax_amount_without_exemption: standard_tax_amount,
        tax_exempt_savings_amount,
        available_company_credit_before,
        available_company_credit_after,
        available_cost_center_budget_before,
        available_cost_center_budget_after,
        net_terms_due_days: input.company.payment_terms.due_days(),
        recommended_reservation_ttl_seconds,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::money::PriceTier;
    use crate::pricing::{CartLineInput, TaxInclusionMode};

    fn sample_b2b_cart(quantity: u32) -> CartCalculationInput {
        CartCalculationInput {
            currency_code: "USD".to_string(),
            tax_mode: TaxInclusionMode::TaxExclusive,
            lines: vec![CartLineInput {
                line_id: "L-B2B-1".to_string(),
                variant_id: "KR-KB75-TI".to_string(),
                quantity,
                base_unit_price: 24_000, // $240.00 retail
                tier_prices: vec![
                    PriceTier {
                        min_quantity: 5,
                        unit_amount: 21_000, // $210.00 tier-1
                    },
                    PriceTier {
                        min_quantity: 20,
                        unit_amount: 18_000, // $180.00 tier-2
                    },
                ],
                tax_rate_bps: 825, // 8.25%
                is_gift: false,
                candidate_line_discounts: vec![],
            }],
            candidate_order_discounts: vec![],
            shipping_base_amount: 0,
            shipping_tax_rate_bps: 825,
        }
    }

    #[test]
    fn test_b2b_auto_approve_with_tier_pricing_contract_discount_and_tax_exemption() {
        // 5 units -> $210.00 tier price = $1,050.00 (105_000 cents)
        // 5% contract discount (500 bps) -> -5_250 cents -> net 99_750 cents ($997.50)
        // Tax exempt verified -> $0.00 tax (saves 8.25% of 99_750 = 8_229 cents)
        let input = B2bPurchasePolicyInput {
            company: B2bCompanyPolicyInput {
                company_id: "comp-acme-ind".to_string(),
                payment_terms: B2bPaymentTerms::Net30,
                credit_limit: 5_000_000, // $50,000.00
                credit_used: 1_000_000,  // $10,000.00
                credit_reserved: 0,
                contract_discount_bps: 500, // 5%
                tax_exempt_verified: true,
            },
            cost_center: B2bCostCenterPolicyInput {
                cost_center_id: "cc-hw-eng".to_string(),
                monthly_budget: 1_500_000, // $15,000.00
                monthly_spent: 200_000,
                monthly_reserved: 0,
            },
            buyer: B2bBuyerPolicyInput {
                buyer_id: "buyer-alice".to_string(),
                role: B2bBuyerRole::Buyer,
                single_order_auto_approve_limit: 250_000, // $2,500.00
            },
            cart: sample_b2b_cart(5),
        };

        let res = evaluate_b2b_purchase_policy(&input);
        assert_eq!(res.decision, B2bPolicyDecisionStatus::ApprovedAuto);
        assert_eq!(res.pricing.lines[0].effective_base_unit_price, 21_000);
        assert_eq!(res.pricing.lines[0].allocated_order_discount_amount, 5_250);
        assert_eq!(res.pricing.total_tax_amount, 0);
        assert_eq!(res.pricing.total_gross_amount, 99_750);
        assert_eq!(res.tax_exempt_savings_amount, 8_229);
        assert_eq!(res.net_terms_due_days, 30);
        assert_eq!(res.recommended_reservation_ttl_seconds, 900);
    }

    #[test]
    fn test_b2b_pending_po_approval_and_company_credit_rejection() {
        // 25 units -> $180.00 tier price = $4,500.00 (450_000 cents)
        // 5% contract discount -> -22_500 cents -> net/gross = 427_500 cents ($4,275.00)
        // Buyer auto-approve limit is $2,500.00 (250_000 cents) -> triggers PendingApproval + 72h TTL
        let mut input = B2bPurchasePolicyInput {
            company: B2bCompanyPolicyInput {
                company_id: "comp-acme-ind".to_string(),
                payment_terms: B2bPaymentTerms::Net30,
                credit_limit: 5_000_000,
                credit_used: 1_000_000,
                credit_reserved: 0,
                contract_discount_bps: 500,
                tax_exempt_verified: true,
            },
            cost_center: B2bCostCenterPolicyInput {
                cost_center_id: "cc-hw-eng".to_string(),
                monthly_budget: 1_500_000,
                monthly_spent: 200_000,
                monthly_reserved: 0,
            },
            buyer: B2bBuyerPolicyInput {
                buyer_id: "buyer-alice".to_string(),
                role: B2bBuyerRole::Buyer,
                single_order_auto_approve_limit: 250_000,
            },
            cart: sample_b2b_cart(25),
        };

        let pending = evaluate_b2b_purchase_policy(&input);
        assert_eq!(pending.decision, B2bPolicyDecisionStatus::PendingApproval);
        assert_eq!(pending.pricing.total_gross_amount, 427_500);
        assert_eq!(pending.recommended_reservation_ttl_seconds, 259_200);
        assert_eq!(pending.approval_reasons.len(), 1);

        // Now exhaust company credit so available credit is only $3,000.00 (300_000 cents)
        input.company.credit_used = 4_700_000;
        let rejected = evaluate_b2b_purchase_policy(&input);
        assert_eq!(
            rejected.decision,
            B2bPolicyDecisionStatus::RejectedCompanyCreditExceeded
        );
        assert_eq!(rejected.recommended_reservation_ttl_seconds, 0);
    }
}
