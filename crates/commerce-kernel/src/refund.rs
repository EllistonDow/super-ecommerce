//! Deterministic RMA Return & Partial Refund Calculation Engine (`refund.rs`).
//!
//! Solves the hardest post-checkout financial invariant in multi-line commerce:
//! When an order has line-level and order-level discounts (allocated via Hare-Niemeyer
//! in [`crate::pricing`]), partial returns across one or multiple RMA waves must:
//! 1. Never refund more than the line's original captured net, tax, or gross ceiling.
//! 2. Reconcile exact penny remainders on the final returned unit of any line so that
//!    cumulative refunds across $K$ partial returns sum to 100% of the line's paid amount.
//! 3. Preserve `refund_net + refund_tax == refund_gross` on every individual RMA wave.
//! 4. Enforce zero refund on free-gift lines (`is_gift = true`).
//! 5. Deterministically split the refund total across Payment Gateway Cash and Store Credit.

use crate::money::{apply_bps, div_round_half_up, Bps, MinorUnits};

/// Priority order when splitting a refund across multiple original payment tenders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefundTenderPriority {
    /// Refund external payment gateway (card/bank) first up to remaining captured cash,
    /// then restore store credit / gift card balance.
    GatewayCashFirst,
    /// Restore store credit / gift card balance first up to remaining redeemed credit,
    /// then refund external payment gateway.
    StoreCreditFirst,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefundLineInput {
    pub line_id: String,
    pub variant_id: String,
    pub original_quantity: u32,
    pub already_returned_quantity: u32,
    pub return_quantity_requested: u32,
    pub is_gift: bool,
    /// Final post-discount net amount paid for the entire line (`CalculatedLineResult.total_net_amount`).
    pub original_net_amount: MinorUnits,
    /// Final tax amount paid for the entire line (`CalculatedLineResult.total_tax_amount`).
    pub original_tax_amount: MinorUnits,
    /// Final gross amount paid for the entire line (`CalculatedLineResult.total_gross_amount`).
    pub original_gross_amount: MinorUnits,
    /// Cumulative net ceiling already consumed by prior RMA waves on this line.
    pub already_refunded_net_amount: MinorUnits,
    /// Cumulative tax ceiling already consumed by prior RMA waves on this line.
    pub already_refunded_tax_amount: MinorUnits,
    /// Cumulative gross ceiling already consumed by prior RMA waves on this line.
    pub already_refunded_gross_amount: MinorUnits,
    /// Optional restocking fee in basis points (e.g. `1500` = 15.00% fee deducted from refund).
    pub restocking_fee_bps: Bps,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefundCalculationInput {
    pub currency_code: String,
    pub lines: Vec<RefundLineInput>,
    pub refund_shipping: bool,
    pub shipping_original_net_amount: MinorUnits,
    pub shipping_original_tax_amount: MinorUnits,
    pub shipping_original_gross_amount: MinorUnits,
    pub shipping_already_refunded_gross_amount: MinorUnits,
    pub payment_gateway_originally_captured: MinorUnits,
    pub payment_gateway_already_refunded: MinorUnits,
    pub store_credit_originally_redeemed: MinorUnits,
    pub store_credit_already_refunded: MinorUnits,
    pub tender_priority: RefundTenderPriority,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalculatedRefundLineResult {
    pub line_id: String,
    pub variant_id: String,
    pub is_gift: bool,
    pub original_quantity: u32,
    pub already_returned_quantity: u32,
    pub accepted_return_quantity: u32,
    pub remaining_returnable_quantity: u32,
    /// True when this wave returns the last remaining unit(s) of the line, triggering
    /// exact ceiling remainder reconciliation (`original - already_refunded`).
    pub is_final_unit_reconciliation: bool,
    /// Share of original line net amount consumed by the returned units (before restocking fee).
    pub net_ceiling_consumed: MinorUnits,
    /// Share of original line tax amount consumed by the returned units (before restocking fee).
    pub tax_ceiling_consumed: MinorUnits,
    /// Share of original line gross amount consumed by the returned units (before restocking fee).
    pub gross_ceiling_consumed: MinorUnits,
    /// Monetary restocking fee withheld on this line.
    pub restocking_fee_amount: MinorUnits,
    /// Net amount to refund to the customer for this line.
    pub refund_net_amount: MinorUnits,
    /// Tax amount to refund to the customer for this line.
    pub refund_tax_amount: MinorUnits,
    /// Gross amount to refund to the customer for this line (`refund_net_amount + refund_tax_amount`).
    pub refund_gross_amount: MinorUnits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefundCalculationResult {
    pub currency_code: String,
    pub lines: Vec<CalculatedRefundLineResult>,
    pub shipping_refund_net_amount: MinorUnits,
    pub shipping_refund_tax_amount: MinorUnits,
    pub shipping_refund_gross_amount: MinorUnits,
    pub total_gross_ceiling_consumed: MinorUnits,
    pub total_restocking_fee_amount: MinorUnits,
    pub total_refund_net_amount: MinorUnits,
    pub total_refund_tax_amount: MinorUnits,
    pub total_refund_gross_amount: MinorUnits,
    pub payment_gateway_refund_amount: MinorUnits,
    pub store_credit_refund_amount: MinorUnits,
    pub unallocated_refund_overflow: MinorUnits,
}

/// Slices `remaining_amount` across `remaining_units` equal-weight units via closed-form
/// Hare-Niemeyer largest-remainder arithmetic and sums the first `take_units` shares in O(1).
fn slice_equal_units_pro_rata(
    remaining_amount: MinorUnits,
    remaining_units: u32,
    take_units: u32,
) -> MinorUnits {
    let rem_amt = remaining_amount.max(0);
    if rem_amt == 0 || remaining_units == 0 || take_units == 0 {
        return 0;
    }
    if take_units >= remaining_units {
        return rem_amt;
    }
    let rem_u = remaining_units as MinorUnits;
    let take_u = take_units as MinorUnits;
    let floor_per_unit = rem_amt / rem_u;
    let extra_pennies = rem_amt % rem_u;
    take_u * floor_per_unit + take_u.min(extra_pennies)
}

/// Splits a gross amount into `(net, tax)` proportionally to `(reference_net, reference_tax)`
/// in O(1) using `i128` half-up rounding so `net + tax == target_gross` always holds.
fn split_net_and_tax_exact(
    target_gross: MinorUnits,
    reference_net: MinorUnits,
    reference_tax: MinorUnits,
) -> (MinorUnits, MinorUnits) {
    let gross = target_gross.max(0);
    if gross == 0 {
        return (0, 0);
    }
    let net_weight = reference_net.max(0);
    let tax_weight = reference_tax.max(0);
    if tax_weight == 0 {
        return (gross, 0);
    }
    if net_weight == 0 {
        return (0, gross);
    }
    let total_weight = (net_weight as i128) + (tax_weight as i128);
    let net = div_round_half_up((gross as i128) * (net_weight as i128), total_weight)
        .min(gross)
        .max(0);
    let tax = gross - net;
    (net, tax)
}

/// Executes deterministic multi-wave partial return and refund calculation.
pub fn calculate_return_refund(input: &RefundCalculationInput) -> RefundCalculationResult {
    let mut line_results = Vec::with_capacity(input.lines.len());
    let mut total_gross_ceiling_consumed: MinorUnits = 0;
    let mut total_restocking_fee_amount: MinorUnits = 0;
    let mut total_refund_net_amount: MinorUnits = 0;
    let mut total_refund_tax_amount: MinorUnits = 0;
    let mut total_refund_gross_amount: MinorUnits = 0;

    for line in &input.lines {
        let already_ret = line.already_returned_quantity.min(line.original_quantity);
        let max_returnable_qty = line.original_quantity.saturating_sub(already_ret);
        let accepted_qty = line.return_quantity_requested.min(max_returnable_qty);
        let remaining_after = max_returnable_qty.saturating_sub(accepted_qty);

        if line.is_gift || accepted_qty == 0 || line.original_quantity == 0 {
            line_results.push(CalculatedRefundLineResult {
                line_id: line.line_id.clone(),
                variant_id: line.variant_id.clone(),
                is_gift: line.is_gift,
                original_quantity: line.original_quantity,
                already_returned_quantity: already_ret,
                accepted_return_quantity: accepted_qty,
                remaining_returnable_quantity: remaining_after,
                is_final_unit_reconciliation: accepted_qty > 0 && remaining_after == 0,
                net_ceiling_consumed: 0,
                tax_ceiling_consumed: 0,
                gross_ceiling_consumed: 0,
                restocking_fee_amount: 0,
                refund_net_amount: 0,
                refund_tax_amount: 0,
                refund_gross_amount: 0,
            });
            continue;
        }

        let rem_net = (line.original_net_amount - line.already_refunded_net_amount).max(0);
        let rem_tax = (line.original_tax_amount - line.already_refunded_tax_amount).max(0);
        let rem_gross = (line.original_gross_amount - line.already_refunded_gross_amount).max(0);

        let is_final_unit = remaining_after == 0;

        let (net_ceiling_consumed, tax_ceiling_consumed, gross_ceiling_consumed) = if is_final_unit
        {
            // Exact ceiling reconciliation on the final unit(s): zero penny drift guaranteed.
            let gross_c = rem_gross;
            if rem_net + rem_tax == gross_c {
                (rem_net, rem_tax, gross_c)
            } else {
                let (n, t) = split_net_and_tax_exact(gross_c, rem_net, rem_tax);
                (n, t, gross_c)
            }
        } else {
            // Partial return of `accepted_qty` out of `max_returnable_qty` remaining units.
            let gross_c = slice_equal_units_pro_rata(rem_gross, max_returnable_qty, accepted_qty);
            let (n, t) = split_net_and_tax_exact(gross_c, rem_net, rem_tax);
            (n, t, gross_c)
        };

        let clamped_fee_bps = line.restocking_fee_bps.min(10_000);
        let restocking_fee_amount = apply_bps(gross_ceiling_consumed, clamped_fee_bps)
            .min(gross_ceiling_consumed)
            .max(0);
        let refund_gross_amount = gross_ceiling_consumed - restocking_fee_amount;
        let (refund_net_amount, refund_tax_amount) = split_net_and_tax_exact(
            refund_gross_amount,
            net_ceiling_consumed,
            tax_ceiling_consumed,
        );

        total_gross_ceiling_consumed += gross_ceiling_consumed;
        total_restocking_fee_amount += restocking_fee_amount;
        total_refund_net_amount += refund_net_amount;
        total_refund_tax_amount += refund_tax_amount;
        total_refund_gross_amount += refund_gross_amount;

        line_results.push(CalculatedRefundLineResult {
            line_id: line.line_id.clone(),
            variant_id: line.variant_id.clone(),
            is_gift: false,
            original_quantity: line.original_quantity,
            already_returned_quantity: already_ret,
            accepted_return_quantity: accepted_qty,
            remaining_returnable_quantity: remaining_after,
            is_final_unit_reconciliation: is_final_unit,
            net_ceiling_consumed,
            tax_ceiling_consumed,
            gross_ceiling_consumed,
            restocking_fee_amount,
            refund_net_amount,
            refund_tax_amount,
            refund_gross_amount,
        });
    }

    // Shipping refund calculation
    let (shipping_refund_net_amount, shipping_refund_tax_amount, shipping_refund_gross_amount) =
        if input.refund_shipping {
            let rem_ship_gross = (input.shipping_original_gross_amount
                - input.shipping_already_refunded_gross_amount)
                .max(0);
            let (s_net, s_tax) = split_net_and_tax_exact(
                rem_ship_gross,
                input.shipping_original_net_amount,
                input.shipping_original_tax_amount,
            );
            (s_net, s_tax, rem_ship_gross)
        } else {
            (0, 0, 0)
        };

    total_gross_ceiling_consumed += shipping_refund_gross_amount;
    total_refund_net_amount += shipping_refund_net_amount;
    total_refund_tax_amount += shipping_refund_tax_amount;
    total_refund_gross_amount += shipping_refund_gross_amount;

    // Tender allocation across Payment Gateway Cash and Store Credit
    let rem_gateway_cash = (input.payment_gateway_originally_captured
        - input.payment_gateway_already_refunded)
        .max(0);
    let rem_store_credit = (input.store_credit_originally_redeemed
        - input.store_credit_already_refunded)
        .max(0);

    let (payment_gateway_refund_amount, store_credit_refund_amount) = match input.tender_priority {
        RefundTenderPriority::GatewayCashFirst => {
            let gw = total_refund_gross_amount.min(rem_gateway_cash);
            let sc = (total_refund_gross_amount - gw).min(rem_store_credit);
            (gw, sc)
        }
        RefundTenderPriority::StoreCreditFirst => {
            let sc = total_refund_gross_amount.min(rem_store_credit);
            let gw = (total_refund_gross_amount - sc).min(rem_gateway_cash);
            (gw, sc)
        }
    };

    let unallocated_refund_overflow = (total_refund_gross_amount
        - payment_gateway_refund_amount
        - store_credit_refund_amount)
        .max(0);

    RefundCalculationResult {
        currency_code: input.currency_code.clone(),
        lines: line_results,
        shipping_refund_net_amount,
        shipping_refund_tax_amount,
        shipping_refund_gross_amount,
        total_gross_ceiling_consumed,
        total_restocking_fee_amount,
        total_refund_net_amount,
        total_refund_tax_amount,
        total_refund_gross_amount,
        payment_gateway_refund_amount,
        store_credit_refund_amount,
        unallocated_refund_overflow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_three_wave_single_unit_returns_reconcile_to_exact_line_total() {
        // 3 units of an item paid $10.00 total (1000 cents net, 0 tax, 1000 gross) after discounts.
        let mut already_ret_qty = 0;
        let mut already_ref_net = 0;
        let mut already_ref_tax = 0;
        let mut already_ref_gross = 0;
        let mut wave_refunds = Vec::new();

        for wave in 1..=3 {
            let res = calculate_return_refund(&RefundCalculationInput {
                currency_code: "USD".to_string(),
                lines: vec![RefundLineInput {
                    line_id: "L-1".to_string(),
                    variant_id: "KR-KB75-TI".to_string(),
                    original_quantity: 3,
                    already_returned_quantity: already_ret_qty,
                    return_quantity_requested: 1,
                    is_gift: false,
                    original_net_amount: 1000,
                    original_tax_amount: 0,
                    original_gross_amount: 1000,
                    already_refunded_net_amount: already_ref_net,
                    already_refunded_tax_amount: already_ref_tax,
                    already_refunded_gross_amount: already_ref_gross,
                    restocking_fee_bps: 0,
                }],
                refund_shipping: false,
                shipping_original_net_amount: 0,
                shipping_original_tax_amount: 0,
                shipping_original_gross_amount: 0,
                shipping_already_refunded_gross_amount: 0,
                payment_gateway_originally_captured: 1000,
                payment_gateway_already_refunded: already_ref_gross,
                store_credit_originally_redeemed: 0,
                store_credit_already_refunded: 0,
                tender_priority: RefundTenderPriority::GatewayCashFirst,
            });

            let line_res = &res.lines[0];
            assert_eq!(line_res.accepted_return_quantity, 1);
            assert_eq!(line_res.is_final_unit_reconciliation, wave == 3);

            wave_refunds.push(line_res.refund_gross_amount);
            already_ret_qty += line_res.accepted_return_quantity;
            already_ref_net += line_res.net_ceiling_consumed;
            already_ref_tax += line_res.tax_ceiling_consumed;
            already_ref_gross += line_res.gross_ceiling_consumed;
        }

        // Wave 1: 334, Wave 2: 333, Wave 3: 333 -> Exact sum = 1000 cents!
        assert_eq!(wave_refunds, vec![334, 333, 333]);
        assert_eq!(wave_refunds.iter().sum::<MinorUnits>(), 1000);
        assert_eq!(already_ref_gross, 1000);
    }

    #[test]
    fn test_gift_line_zero_refund_and_restocking_fee_with_multi_tender_split() {
        // Line 1: 2 units, paid 2000 net + 200 tax = 2200 gross; return 1 unit with 10% restocking fee (1000 bps)
        // Line 2 (gift): 1 unit, paid 0; return 1 unit -> 0 refund
        // Original payment: 600 cash + 1600 store credit = 2200
        let res = calculate_return_refund(&RefundCalculationInput {
            currency_code: "USD".to_string(),
            lines: vec![
                RefundLineInput {
                    line_id: "L-PAID".to_string(),
                    variant_id: "SKU-1".to_string(),
                    original_quantity: 2,
                    already_returned_quantity: 0,
                    return_quantity_requested: 1,
                    is_gift: false,
                    original_net_amount: 2000,
                    original_tax_amount: 200,
                    original_gross_amount: 2200,
                    already_refunded_net_amount: 0,
                    already_refunded_tax_amount: 0,
                    already_refunded_gross_amount: 0,
                    restocking_fee_bps: 1000, // 10% fee
                },
                RefundLineInput {
                    line_id: "L-GIFT".to_string(),
                    variant_id: "SKU-GIFT".to_string(),
                    original_quantity: 1,
                    already_returned_quantity: 0,
                    return_quantity_requested: 1,
                    is_gift: true,
                    original_net_amount: 0,
                    original_tax_amount: 0,
                    original_gross_amount: 0,
                    already_refunded_net_amount: 0,
                    already_refunded_tax_amount: 0,
                    already_refunded_gross_amount: 0,
                    restocking_fee_bps: 0,
                },
            ],
            refund_shipping: false,
            shipping_original_net_amount: 0,
            shipping_original_tax_amount: 0,
            shipping_original_gross_amount: 0,
            shipping_already_refunded_gross_amount: 0,
            payment_gateway_originally_captured: 600,
            payment_gateway_already_refunded: 0,
            store_credit_originally_redeemed: 1600,
            store_credit_already_refunded: 0,
            tender_priority: RefundTenderPriority::GatewayCashFirst,
        });

        let paid_line = &res.lines[0];
        assert_eq!(paid_line.gross_ceiling_consumed, 1100);
        assert_eq!(paid_line.restocking_fee_amount, 110);
        assert_eq!(paid_line.refund_gross_amount, 990);
        assert_eq!(paid_line.refund_net_amount + paid_line.refund_tax_amount, 990);

        let gift_line = &res.lines[1];
        assert_eq!(gift_line.refund_gross_amount, 0);

        // Tender split: 600 to Gateway Cash (exhausting captured cash), 390 to Store Credit
        assert_eq!(res.total_refund_gross_amount, 990);
        assert_eq!(res.payment_gateway_refund_amount, 600);
        assert_eq!(res.store_credit_refund_amount, 390);
        assert_eq!(res.unallocated_refund_overflow, 0);
    }
}
