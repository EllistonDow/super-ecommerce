//! Injection-Safe Deterministic Record Wire Codec (`wire_codec`).
//!
//! Shared identically across `crates/kernel-napi` (Node/Bun native C-ABI) and
//! `crates/kernel-wasm` (`wasm32-unknown-unknown` Edge/Browser WebAssembly),
//! guaranteeing 100% single-source parity with zero code duplication.
//!
//! Security Invariant:
//! All string fields are losslessly escaped (`\\`, `\t`, `\n`, `\r`) on serialization
//! and unescaped on parsing, preventing record-injection or column-shift attacks when
//! SKUs, voucher codes, or discount names contain control characters.

use crate::allocation::{allocate_pro_rata, WeightedItem};
use crate::b2b::{
    evaluate_b2b_purchase_policy, B2bBuyerPolicyInput, B2bBuyerRole, B2bCompanyPolicyInput,
    B2bCostCenterPolicyInput, B2bPaymentTerms, B2bPolicyDecisionStatus, B2bPurchasePolicyInput,
};
use crate::money::{Bps, MinorUnits, PriceTier};
use crate::msi::{
    plan_inventory_allocation, AllocationStrategy, OrderLineDemand, StockAvailabilityMode,
    WarehouseStockSlot,
};
use crate::pricing::{
    calculate_cart, CandidateLineDiscount, CandidateOrderDiscount, CartCalculationInput,
    CartLineInput, CartCalculationResult, DiscountValue, LineDiscountKind, OrderDiscountKind,
    TaxInclusionMode,
};
use crate::refund::{
    calculate_return_refund, RefundCalculationInput, RefundLineInput, RefundTenderPriority,
};

/// Escapes `\`, `\t`, `\n`, and `\r` so arbitrary user strings cannot break `\t`/`\n` framing.
pub fn escape_field(raw: &str) -> String {
    if !raw.contains(['\\', '\t', '\n', '\r']) {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len() + 8);
    for ch in raw.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(ch),
        }
    }
    out
}

/// Reverses `escape_field` losslessly.
pub fn unescape_field(escaped: &str) -> String {
    if !escaped.contains('\\') {
        return escaped.to_string();
    }
    let mut out = String::with_capacity(escaped.len());
    let mut chars = escaped.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('t') => out.push('\t'),
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn parse_discount_value(kind_str: &str, val: i64) -> DiscountValue {
    if kind_str == "PERCENTAGE" {
        DiscountValue::Percentage(val.max(0) as Bps)
    } else {
        DiscountValue::Fixed(val)
    }
}

fn parse_line_discount_kind(s: &str) -> LineDiscountKind {
    match s {
        "MANUAL_LINE" => LineDiscountKind::ManualLine,
        "VOUCHER_LINE" => LineDiscountKind::VoucherLine,
        "ORDER_PROMOTION_GIFT" => LineDiscountKind::OrderPromotionGift,
        _ => LineDiscountKind::CataloguePromotion,
    }
}

fn parse_order_discount_kind(s: &str) -> OrderDiscountKind {
    match s {
        "MANUAL_ORDER" => OrderDiscountKind::ManualOrder,
        "ORDER_VOUCHER" => OrderDiscountKind::OrderVoucher,
        "SHIPPING_VOUCHER" => OrderDiscountKind::ShippingVoucher,
        _ => OrderDiscountKind::OrderPromotion,
    }
}

fn format_order_discount_kind(k: OrderDiscountKind) -> &'static str {
    match k {
        OrderDiscountKind::ManualOrder => "MANUAL_ORDER",
        OrderDiscountKind::OrderVoucher => "ORDER_VOUCHER",
        OrderDiscountKind::ShippingVoucher => "SHIPPING_VOUCHER",
        OrderDiscountKind::OrderPromotion => "ORDER_PROMOTION",
    }
}

fn append_cart_result(out: &mut String, res: &CartCalculationResult) {
    out.push_str(&format!(
        "TOTALS\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
        escape_field(&res.currency_code),
        res.shipping_undiscounted_amount,
        res.shipping_discount_amount,
        res.shipping_net_amount,
        res.shipping_tax_amount,
        res.shipping_gross_amount,
        res.total_net_amount,
        res.total_tax_amount,
        res.total_gross_amount
    ));

    for od in &res.applied_order_discounts {
        out.push_str(&format!(
            "APPLIED_ODISC\t{}\t{}\t{}\t{}\n",
            escape_field(&od.discount_id),
            escape_field(&od.name),
            format_order_discount_kind(od.kind),
            od.total_amount
        ));
    }

    for line in &res.lines {
        out.push_str(&format!(
            "LINE_RES\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            escape_field(&line.line_id),
            escape_field(&line.variant_id),
            line.quantity,
            if line.is_gift { 1 } else { 0 },
            line.effective_base_unit_price,
            line.undiscounted_line_subtotal,
            line.line_level_discount_amount,
            line.subtotal_after_line_discount,
            line.allocated_order_discount_amount,
            line.total_net_amount,
            line.total_tax_amount,
            line.total_gross_amount,
            line.margin_guard_clamped_amount
        ));
        for attr in &line.discount_attributions {
            out.push_str(&format!(
                "LINE_ATTR\t{}\t{}\t{}\t{}\t{}\n",
                escape_field(&line.line_id),
                escape_field(&attr.discount_id),
                escape_field(&attr.name),
                if attr.is_order_level { 1 } else { 0 },
                attr.amount
            ));
        }
    }
}

pub fn exec_allocate_pro_rata(total: MinorUnits, payload: &str) -> String {
    let mut items = Vec::new();
    for line in payload.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let id = unescape_field(parts.next().unwrap_or(""));
        let weight: MinorUnits = parts.next().and_then(|w| w.parse().ok()).unwrap_or(0);
        items.push(WeightedItem { id, weight });
    }

    let shares = allocate_pro_rata(total, &items);
    let mut out_str = String::new();
    for (idx, share) in shares.iter().enumerate() {
        if idx > 0 {
            out_str.push('\n');
        }
        out_str.push_str(&format!("{}\t{}", escape_field(&share.id), share.allocated));
    }
    out_str
}

pub fn exec_calculate_cart(payload: &str) -> String {
    let mut currency_code = String::from("USD");
    let mut tax_mode = TaxInclusionMode::TaxExclusive;
    let mut shipping_base_amount: MinorUnits = 0;
    let mut shipping_tax_rate_bps: Bps = 0;
    let mut lines: Vec<CartLineInput> = Vec::new();
    let mut candidate_order_discounts: Vec<CandidateOrderDiscount> = Vec::new();

    for raw in payload.lines() {
        if raw.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = raw.split('\t').collect();
        match cols.first().copied().unwrap_or("") {
            "CART" if cols.len() >= 5 => {
                currency_code = unescape_field(cols[1]);
                tax_mode = if cols[2] == "TAX_INCLUSIVE" {
                    TaxInclusionMode::TaxInclusive
                } else {
                    TaxInclusionMode::TaxExclusive
                };
                shipping_base_amount = cols[3].parse().unwrap_or(0);
                shipping_tax_rate_bps = cols[4].parse().unwrap_or(0);
            }
            "LINE" if cols.len() >= 7 => {
                let unit_cost_amount = if cols.len() >= 8 && !cols[7].is_empty() {
                    cols[7].parse::<MinorUnits>().ok()
                } else {
                    None
                };
                let min_margin_bps = if cols.len() >= 9 {
                    cols[8].parse::<Bps>().unwrap_or(0)
                } else {
                    0
                };
                lines.push(CartLineInput {
                    line_id: unescape_field(cols[1]),
                    variant_id: unescape_field(cols[2]),
                    quantity: cols[3].parse().unwrap_or(1),
                    base_unit_price: cols[4].parse().unwrap_or(0),
                    tier_prices: Vec::new(),
                    tax_rate_bps: cols[5].parse().unwrap_or(0),
                    is_gift: cols[6] == "1",
                    candidate_line_discounts: Vec::new(),
                    unit_cost_amount,
                    min_margin_bps,
                });
            }
            "TIER" if cols.len() >= 4 => {
                let target_line_id = unescape_field(cols[1]);
                if let Some(line) = lines.iter_mut().find(|l| l.line_id == target_line_id) {
                    line.tier_prices.push(PriceTier {
                        min_quantity: cols[2].parse().unwrap_or(1),
                        unit_amount: cols[3].parse().unwrap_or(0),
                    });
                }
            }
            "LDISC" if cols.len() >= 7 => {
                let target_line_id = unescape_field(cols[1]);
                if let Some(line) = lines.iter_mut().find(|l| l.line_id == target_line_id) {
                    line.candidate_line_discounts.push(CandidateLineDiscount {
                        discount_id: unescape_field(cols[2]),
                        name: unescape_field(cols[3]),
                        kind: parse_line_discount_kind(cols[4]),
                        value: parse_discount_value(cols[5], cols[6].parse().unwrap_or(0)),
                    });
                }
            }
            "ODISC" if cols.len() >= 6 => {
                candidate_order_discounts.push(CandidateOrderDiscount {
                    discount_id: unescape_field(cols[1]),
                    name: unescape_field(cols[2]),
                    kind: parse_order_discount_kind(cols[3]),
                    value: parse_discount_value(cols[4], cols[5].parse().unwrap_or(0)),
                });
            }
            _ => {}
        }
    }

    let res = calculate_cart(&CartCalculationInput {
        currency_code,
        tax_mode,
        shipping_base_amount,
        shipping_tax_rate_bps,
        lines,
        candidate_order_discounts,
    });

    let mut out = String::new();
    append_cart_result(&mut out, &res);
    out
}

pub fn exec_plan_inventory(payload: &str) -> String {
    let mut avail_mode = StockAvailabilityMode::DirectChannelWarehouses;
    let mut strategy = AllocationStrategy::MinimizeSplitThenHighStock;
    let mut demands = Vec::new();
    let mut slots = Vec::new();

    for raw in payload.lines() {
        if raw.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = raw.split('\t').collect();
        match cols.first().copied().unwrap_or("") {
            "CFG" if cols.len() >= 3 => {
                avail_mode = if cols[1] == "SHIPPING_ZONE_INTERSECTION" {
                    StockAvailabilityMode::ShippingZoneIntersection
                } else {
                    StockAvailabilityMode::DirectChannelWarehouses
                };
                strategy = if cols[2] == "PRIORITIZE_RANK_ORDER" {
                    AllocationStrategy::PrioritizeRankOrder
                } else {
                    AllocationStrategy::MinimizeSplitThenHighStock
                };
            }
            "DEMAND" if cols.len() >= 4 => {
                demands.push(OrderLineDemand {
                    line_id: unescape_field(cols[1]),
                    variant_id: unescape_field(cols[2]),
                    quantity_requested: cols[3].parse().unwrap_or(0),
                });
            }
            "SLOT" if cols.len() >= 9 => {
                slots.push(WarehouseStockSlot {
                    warehouse_id: unescape_field(cols[1]),
                    priority_rank: cols[2].parse().unwrap_or(100),
                    linked_to_channel: cols[3] == "1",
                    supports_shipping_zone: cols[4] == "1",
                    variant_id: unescape_field(cols[5]),
                    quantity_on_hand: cols[6].parse().unwrap_or(0),
                    quantity_reserved: cols[7].parse().unwrap_or(0),
                    quantity_allocated: cols[8].parse().unwrap_or(0),
                });
            }
            _ => {}
        }
    }

    let plan = plan_inventory_allocation(&demands, &slots, avail_mode, strategy);
    let mut out = String::new();
    out.push_str(&format!(
        "PLAN\t{}\t{}\n",
        if plan.is_fully_allocated { 1 } else { 0 },
        plan.shipment_count
    ));
    for a in &plan.allocations {
        out.push_str(&format!(
            "ALLOC\t{}\t{}\t{}\t{}\n",
            escape_field(&a.warehouse_id),
            escape_field(&a.line_id),
            escape_field(&a.variant_id),
            a.quantity_allocated
        ));
    }
    for s in &plan.shortfalls {
        out.push_str(&format!(
            "SHORTFALL\t{}\t{}\t{}\t{}\t{}\n",
            escape_field(&s.line_id),
            escape_field(&s.variant_id),
            s.quantity_requested,
            s.quantity_available,
            s.quantity_missing
        ));
    }
    out
}

pub fn exec_calculate_return_refund(payload: &str) -> String {
    let mut currency_code = String::from("USD");
    let mut refund_shipping = false;
    let mut shipping_original_net_amount: MinorUnits = 0;
    let mut shipping_original_tax_amount: MinorUnits = 0;
    let mut shipping_original_gross_amount: MinorUnits = 0;
    let mut shipping_already_refunded_gross_amount: MinorUnits = 0;
    let mut payment_gateway_originally_captured: MinorUnits = 0;
    let mut payment_gateway_already_refunded: MinorUnits = 0;
    let mut store_credit_originally_redeemed: MinorUnits = 0;
    let mut store_credit_already_refunded: MinorUnits = 0;
    let mut tender_priority = RefundTenderPriority::GatewayCashFirst;
    let mut lines: Vec<RefundLineInput> = Vec::new();

    for raw in payload.lines() {
        if raw.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = raw.split('\t').collect();
        match cols.first().copied().unwrap_or("") {
            "RMA_CFG" if cols.len() >= 12 => {
                currency_code = unescape_field(cols[1]);
                refund_shipping = cols[2] == "1";
                shipping_original_net_amount = cols[3].parse().unwrap_or(0);
                shipping_original_tax_amount = cols[4].parse().unwrap_or(0);
                shipping_original_gross_amount = cols[5].parse().unwrap_or(0);
                shipping_already_refunded_gross_amount = cols[6].parse().unwrap_or(0);
                payment_gateway_originally_captured = cols[7].parse().unwrap_or(0);
                payment_gateway_already_refunded = cols[8].parse().unwrap_or(0);
                store_credit_originally_redeemed = cols[9].parse().unwrap_or(0);
                store_credit_already_refunded = cols[10].parse().unwrap_or(0);
                tender_priority = if cols[11] == "STORE_CREDIT_FIRST" {
                    RefundTenderPriority::StoreCreditFirst
                } else {
                    RefundTenderPriority::GatewayCashFirst
                };
            }
            "RMA_LINE" if cols.len() >= 14 => {
                lines.push(RefundLineInput {
                    line_id: unescape_field(cols[1]),
                    variant_id: unescape_field(cols[2]),
                    original_quantity: cols[3].parse().unwrap_or(0),
                    already_returned_quantity: cols[4].parse().unwrap_or(0),
                    return_quantity_requested: cols[5].parse().unwrap_or(0),
                    is_gift: cols[6] == "1",
                    original_net_amount: cols[7].parse().unwrap_or(0),
                    original_tax_amount: cols[8].parse().unwrap_or(0),
                    original_gross_amount: cols[9].parse().unwrap_or(0),
                    already_refunded_net_amount: cols[10].parse().unwrap_or(0),
                    already_refunded_tax_amount: cols[11].parse().unwrap_or(0),
                    already_refunded_gross_amount: cols[12].parse().unwrap_or(0),
                    restocking_fee_bps: cols[13].parse().unwrap_or(0),
                });
            }
            _ => {}
        }
    }

    let res = calculate_return_refund(&RefundCalculationInput {
        currency_code,
        lines,
        refund_shipping,
        shipping_original_net_amount,
        shipping_original_tax_amount,
        shipping_original_gross_amount,
        shipping_already_refunded_gross_amount,
        payment_gateway_originally_captured,
        payment_gateway_already_refunded,
        store_credit_originally_redeemed,
        store_credit_already_refunded,
        tender_priority,
    });

    let mut out = String::new();
    out.push_str(&format!(
        "RMA_TOTALS\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
        escape_field(&res.currency_code),
        res.shipping_refund_net_amount,
        res.shipping_refund_tax_amount,
        res.shipping_refund_gross_amount,
        res.total_gross_ceiling_consumed,
        res.total_restocking_fee_amount,
        res.total_refund_net_amount,
        res.total_refund_tax_amount,
        res.total_refund_gross_amount,
        res.payment_gateway_refund_amount,
        res.store_credit_refund_amount,
        res.unallocated_refund_overflow
    ));

    for line in &res.lines {
        out.push_str(&format!(
            "RMA_LINE_RES\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            escape_field(&line.line_id),
            escape_field(&line.variant_id),
            if line.is_gift { 1 } else { 0 },
            line.original_quantity,
            line.already_returned_quantity,
            line.accepted_return_quantity,
            line.remaining_returnable_quantity,
            if line.is_final_unit_reconciliation { 1 } else { 0 },
            line.net_ceiling_consumed,
            line.tax_ceiling_consumed,
            line.gross_ceiling_consumed,
            line.restocking_fee_amount,
            line.refund_net_amount,
            line.refund_tax_amount,
            line.refund_gross_amount
        ));
    }
    out
}

pub fn exec_evaluate_b2b_policy(payload: &str) -> String {
    let mut company = B2bCompanyPolicyInput {
        company_id: String::from("comp-default"),
        payment_terms: B2bPaymentTerms::Net30,
        credit_limit: 0,
        credit_used: 0,
        credit_reserved: 0,
        contract_discount_bps: 0,
        tax_exempt_verified: false,
    };
    let mut cost_center = B2bCostCenterPolicyInput {
        cost_center_id: String::from("cc-default"),
        monthly_budget: 0,
        monthly_spent: 0,
        monthly_reserved: 0,
    };
    let mut buyer = B2bBuyerPolicyInput {
        buyer_id: String::from("buyer-default"),
        role: B2bBuyerRole::Buyer,
        single_order_auto_approve_limit: 0,
    };

    let mut currency_code = String::from("USD");
    let mut tax_mode = TaxInclusionMode::TaxExclusive;
    let mut shipping_base_amount: MinorUnits = 0;
    let mut shipping_tax_rate_bps: Bps = 0;
    let mut lines: Vec<CartLineInput> = Vec::new();
    let mut candidate_order_discounts: Vec<CandidateOrderDiscount> = Vec::new();

    for raw in payload.lines() {
        if raw.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = raw.split('\t').collect();
        match cols.first().copied().unwrap_or("") {
            "B2B_COMPANY" if cols.len() >= 8 => {
                company.company_id = unescape_field(cols[1]);
                company.payment_terms = match cols[2] {
                    "NET_60" => B2bPaymentTerms::Net60,
                    "PREPAID_ONLY" => B2bPaymentTerms::PrepaidOnly,
                    _ => B2bPaymentTerms::Net30,
                };
                company.credit_limit = cols[3].parse().unwrap_or(0);
                company.credit_used = cols[4].parse().unwrap_or(0);
                company.credit_reserved = cols[5].parse().unwrap_or(0);
                company.contract_discount_bps = cols[6].parse().unwrap_or(0);
                company.tax_exempt_verified = cols[7] == "1";
            }
            "B2B_CC" if cols.len() >= 5 => {
                cost_center.cost_center_id = unescape_field(cols[1]);
                cost_center.monthly_budget = cols[2].parse().unwrap_or(0);
                cost_center.monthly_spent = cols[3].parse().unwrap_or(0);
                cost_center.monthly_reserved = cols[4].parse().unwrap_or(0);
            }
            "B2B_BUYER" if cols.len() >= 4 => {
                buyer.buyer_id = unescape_field(cols[1]);
                buyer.role = match cols[2] {
                    "APPROVER" => B2bBuyerRole::Approver,
                    "COMPANY_ADMIN" => B2bBuyerRole::CompanyAdmin,
                    _ => B2bBuyerRole::Buyer,
                };
                buyer.single_order_auto_approve_limit = cols[3].parse().unwrap_or(0);
            }
            "CART" if cols.len() >= 5 => {
                currency_code = unescape_field(cols[1]);
                tax_mode = if cols[2] == "TAX_INCLUSIVE" {
                    TaxInclusionMode::TaxInclusive
                } else {
                    TaxInclusionMode::TaxExclusive
                };
                shipping_base_amount = cols[3].parse().unwrap_or(0);
                shipping_tax_rate_bps = cols[4].parse().unwrap_or(0);
            }
            "LINE" if cols.len() >= 7 => {
                let unit_cost_amount = if cols.len() >= 8 && !cols[7].is_empty() {
                    cols[7].parse::<MinorUnits>().ok()
                } else {
                    None
                };
                let min_margin_bps = if cols.len() >= 9 {
                    cols[8].parse::<Bps>().unwrap_or(0)
                } else {
                    0
                };
                lines.push(CartLineInput {
                    line_id: unescape_field(cols[1]),
                    variant_id: unescape_field(cols[2]),
                    quantity: cols[3].parse().unwrap_or(1),
                    base_unit_price: cols[4].parse().unwrap_or(0),
                    tier_prices: Vec::new(),
                    tax_rate_bps: cols[5].parse().unwrap_or(0),
                    is_gift: cols[6] == "1",
                    candidate_line_discounts: Vec::new(),
                    unit_cost_amount,
                    min_margin_bps,
                });
            }
            "TIER" if cols.len() >= 4 => {
                let target_line_id = unescape_field(cols[1]);
                if let Some(line) = lines.iter_mut().find(|l| l.line_id == target_line_id) {
                    line.tier_prices.push(PriceTier {
                        min_quantity: cols[2].parse().unwrap_or(1),
                        unit_amount: cols[3].parse().unwrap_or(0),
                    });
                }
            }
            "LDISC" if cols.len() >= 7 => {
                let target_line_id = unescape_field(cols[1]);
                if let Some(line) = lines.iter_mut().find(|l| l.line_id == target_line_id) {
                    line.candidate_line_discounts.push(CandidateLineDiscount {
                        discount_id: unescape_field(cols[2]),
                        name: unescape_field(cols[3]),
                        kind: parse_line_discount_kind(cols[4]),
                        value: parse_discount_value(cols[5], cols[6].parse().unwrap_or(0)),
                    });
                }
            }
            "ODISC" if cols.len() >= 6 => {
                candidate_order_discounts.push(CandidateOrderDiscount {
                    discount_id: unescape_field(cols[1]),
                    name: unescape_field(cols[2]),
                    kind: parse_order_discount_kind(cols[3]),
                    value: parse_discount_value(cols[4], cols[5].parse().unwrap_or(0)),
                });
            }
            _ => {}
        }
    }

    let b2b_res = evaluate_b2b_purchase_policy(&B2bPurchasePolicyInput {
        company,
        cost_center,
        buyer,
        cart: CartCalculationInput {
            currency_code,
            tax_mode,
            shipping_base_amount,
            shipping_tax_rate_bps,
            lines,
            candidate_order_discounts,
        },
    });

    let decision_str = match b2b_res.decision {
        B2bPolicyDecisionStatus::ApprovedAuto => "APPROVED_AUTO",
        B2bPolicyDecisionStatus::PendingApproval => "PENDING_APPROVAL",
        B2bPolicyDecisionStatus::RejectedCompanyCreditExceeded => {
            "REJECTED_COMPANY_CREDIT_EXCEEDED"
        }
    };

    let mut out = String::new();
    out.push_str(&format!(
        "B2B_DECISION\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
        decision_str,
        b2b_res.standard_tax_amount_without_exemption,
        b2b_res.tax_exempt_savings_amount,
        b2b_res.available_company_credit_before,
        b2b_res.available_company_credit_after,
        b2b_res.available_cost_center_budget_before,
        b2b_res.available_cost_center_budget_after,
        b2b_res.net_terms_due_days,
        b2b_res.recommended_reservation_ttl_seconds
    ));
    for reason in &b2b_res.approval_reasons {
        out.push_str(&format!("B2B_REASON\t{}\n", escape_field(reason)));
    }
    append_cart_result(&mut out, &b2b_res.pricing);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wire_codec_escapes_tab_and_newline_injection_losslessly() {
        let hostile_name = "VIP\t999999\nODISC\tinjected\tHack\tMANUAL_ORDER\tFIXED\t99999";
        let escaped = escape_field(hostile_name);
        assert!(!escaped.contains('\t'));
        assert!(!escaped.contains('\n'));
        assert_eq!(unescape_field(&escaped), hostile_name);

        let payload = format!(
            "CART\tUSD\tTAX_EXCLUSIVE\t0\t0\n\
             LINE\tL1\tSKU\t1\t10000\t0\t0\n\
             LDISC\tL1\tdisc-1\t{}\tCATALOGUE_PROMOTION\tFIXED\t1000",
            escaped
        );
        let raw_out = exec_calculate_cart(&payload);
        // Must ONLY apply the legitimate 1000-cent line discount, NOT the injected 99999 manual order discount!
        assert!(raw_out.contains("TOTALS\tUSD\t0\t0\t0\t0\t0\t9000\t0\t9000"));
        assert!(!raw_out.contains("APPLIED_ODISC"));
    }
}
