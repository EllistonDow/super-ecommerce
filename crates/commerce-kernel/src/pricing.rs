//! Two-Pass Pricing, Discount Precedence, Per-Line Attribution & Tax Engine.
//!
//! Incorporates production battle-tested lessons from Saleor Core while fixing its
//! two biggest limitations:
//! 1. Uses Hare-Niemeyer largest-remainder allocation instead of dumping rounding error
//!    onto the last line.
//! 2. Computes and exposes exact **per-discount-record per-line attribution**
//!    (`LineDiscountAttribution`) so partial refunds, ERP sync, and price-waterfall
//!    explanations never have to guess.

use crate::allocation::{allocate_pro_rata, WeightedItem};
use crate::money::{apply_bps, div_round_half_up, resolve_tier_unit_price, Bps, MinorUnits, PriceTier, MAX_BPS};

/// How discount values are specified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscountValue {
    /// Fixed monetary amount in minor units (e.g. $10.00 = 1000).
    Fixed(MinorUnits),
    /// Basis points percentage (e.g. 20.00% = 2000 bps).
    Percentage(Bps),
}

impl DiscountValue {
    /// Computes the discount against `target_amount`, clamped to `[0, target_amount]`.
    pub fn compute_against(&self, target_amount: MinorUnits) -> MinorUnits {
        if target_amount <= 0 {
            return 0;
        }
        let raw = match *self {
            DiscountValue::Fixed(fixed) => fixed.max(0),
            DiscountValue::Percentage(bps) => apply_bps(target_amount, bps),
        };
        raw.min(target_amount)
    }
}

/// Line-level discount categories ordered by strict precedence:
/// `ManualLine` > `VoucherLine` > `CataloguePromotion`.
/// Gift lines (`is_gift = true`) carry `OrderPromotionGift` (100% off).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LineDiscountKind {
    CataloguePromotion = 1,
    VoucherLine = 2,
    ManualLine = 3,
    OrderPromotionGift = 4,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateLineDiscount {
    pub discount_id: String,
    pub name: String,
    pub kind: LineDiscountKind,
    pub value: DiscountValue,
}

/// Order-level discount categories ordered by strict precedence:
/// `ManualOrder` > `OrderVoucher` > `OrderPromotion`.
/// (`ShippingVoucher` applies only to shipping and can coexist with subtotal discounts.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum OrderDiscountKind {
    OrderPromotion = 1,
    OrderVoucher = 2,
    ManualOrder = 3,
    ShippingVoucher = 4,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateOrderDiscount {
    pub discount_id: String,
    pub name: String,
    pub kind: OrderDiscountKind,
    pub value: DiscountValue,
}

/// Whether catalog prices are entered inclusive or exclusive of tax.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaxInclusionMode {
    /// Prices exclude tax; tax is added on top of post-discount net (e.g. US).
    TaxExclusive,
    /// Prices include tax; net and tax are extracted from post-discount gross (e.g. EU/UK/CN VAT).
    TaxInclusive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CartLineInput {
    pub line_id: String,
    pub variant_id: String,
    pub quantity: u32,
    pub base_unit_price: MinorUnits,
    pub tier_prices: Vec<PriceTier>,
    pub tax_rate_bps: Bps,
    pub is_gift: bool,
    pub candidate_line_discounts: Vec<CandidateLineDiscount>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CartCalculationInput {
    pub currency_code: String,
    pub tax_mode: TaxInclusionMode,
    pub shipping_base_amount: MinorUnits,
    pub shipping_tax_rate_bps: Bps,
    pub lines: Vec<CartLineInput>,
    pub candidate_order_discounts: Vec<CandidateOrderDiscount>,
}

/// Exact attribution of how much a specific discount record reduced a specific line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineDiscountAttribution {
    pub discount_id: String,
    pub name: String,
    pub is_order_level: bool,
    pub amount: MinorUnits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalculatedLineResult {
    pub line_id: String,
    pub variant_id: String,
    pub quantity: u32,
    pub is_gift: bool,
    /// Effective unit price after B2B tier resolution (before discounts).
    pub effective_base_unit_price: MinorUnits,
    /// `effective_base_unit_price * quantity`.
    pub undiscounted_line_subtotal: MinorUnits,
    /// Pass 1 reduction from line-level discount (or 100% gift discount).
    pub line_level_discount_amount: MinorUnits,
    /// Subtotal after Pass 1 (`undiscounted_line_subtotal - line_level_discount_amount`).
    pub subtotal_after_line_discount: MinorUnits,
    /// Pass 2 reduction allocated from order-level discount(s) via Hare-Niemeyer.
    pub allocated_order_discount_amount: MinorUnits,
    /// Exact breakdown of every line-level and order-level discount applied to this line.
    pub discount_attributions: Vec<LineDiscountAttribution>,
    /// Final net amount (excluding tax).
    pub total_net_amount: MinorUnits,
    /// Final tax amount for this line.
    pub total_tax_amount: MinorUnits,
    /// Final gross amount (`total_net_amount + total_tax_amount`).
    pub total_gross_amount: MinorUnits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedOrderDiscountSummary {
    pub discount_id: String,
    pub name: String,
    pub kind: OrderDiscountKind,
    pub total_amount: MinorUnits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CartCalculationResult {
    pub currency_code: String,
    pub lines: Vec<CalculatedLineResult>,
    pub applied_order_discounts: Vec<AppliedOrderDiscountSummary>,
    pub shipping_undiscounted_amount: MinorUnits,
    pub shipping_discount_amount: MinorUnits,
    pub shipping_net_amount: MinorUnits,
    pub shipping_tax_amount: MinorUnits,
    pub shipping_gross_amount: MinorUnits,
    pub total_net_amount: MinorUnits,
    pub total_tax_amount: MinorUnits,
    pub total_gross_amount: MinorUnits,
}

/// Resolves taxes for a post-discount amount according to `TaxInclusionMode`.
fn compute_net_tax_gross(
    post_discount_amount: MinorUnits,
    tax_rate_bps: Bps,
    mode: TaxInclusionMode,
) -> (MinorUnits, MinorUnits, MinorUnits) {
    let amount = post_discount_amount.max(0);
    if amount == 0 || tax_rate_bps == 0 {
        return (amount, 0, amount);
    }
    match mode {
        TaxInclusionMode::TaxExclusive => {
            let net = amount;
            let tax = apply_bps(net, tax_rate_bps);
            let gross = net + tax;
            (net, tax, gross)
        }
        TaxInclusionMode::TaxInclusive => {
            // Gross is the stated amount; Net = Gross * 10000 / (10000 + rate_bps)
            let gross = amount;
            let net = div_round_half_up(
                (gross as i128) * (MAX_BPS as i128),
                (MAX_BPS as i128) + (tax_rate_bps as i128),
            );
            let tax = gross - net;
            (net, tax, gross)
        }
    }
}

/// Selects the winning line discount according to Saleor-compatible precedence:
/// - If `is_gift == true`, the line receives a 100% `OrderPromotionGift` discount.
/// - Otherwise, `ManualLine` overrides all others; if multiple discounts share the highest
///   precedence tier, the one yielding the largest monetary reduction wins (tie-broken by `discount_id`).
fn select_winning_line_discount(
    line: &CartLineInput,
    undiscounted_subtotal: MinorUnits,
) -> Option<(CandidateLineDiscount, MinorUnits)> {
    if line.is_gift {
        return Some((
            CandidateLineDiscount {
                discount_id: format!("gift-{}", line.line_id),
                name: "Free Gift Promotion".to_string(),
                kind: LineDiscountKind::OrderPromotionGift,
                value: DiscountValue::Fixed(undiscounted_subtotal),
            },
            undiscounted_subtotal,
        ));
    }

    if line.candidate_line_discounts.is_empty() || undiscounted_subtotal <= 0 {
        return None;
    }

    let highest_kind = line
        .candidate_line_discounts
        .iter()
        .map(|d| d.kind)
        .max()?;

    line.candidate_line_discounts
        .iter()
        .filter(|d| d.kind == highest_kind)
        .map(|d| {
            let amount = d.value.compute_against(undiscounted_subtotal);
            (d.clone(), amount)
        })
        .max_by(|(d_a, amt_a), (d_b, amt_b)| {
            amt_a.cmp(amt_b).then_with(|| d_b.discount_id.cmp(&d_a.discount_id))
        })
}

/// Evaluates the entire cart deterministically across Pass 1 (Line level),
/// Pass 2 (Order level + Hare-Niemeyer Pro-Rata Allocation), and Pass 3 (Tax).
pub fn calculate_cart(input: &CartCalculationInput) -> CartCalculationResult {
    // -------------------------------------------------------------------------
    // PASS 1: B2B Tier Resolution & Line-Level Discounts
    // -------------------------------------------------------------------------
    struct Pass1Line {
        effective_base_unit_price: MinorUnits,
        undiscounted_subtotal: MinorUnits,
        line_discount_amount: MinorUnits,
        subtotal_after_line_discount: MinorUnits,
        attributions: Vec<LineDiscountAttribution>,
    }

    let mut pass1_lines: Vec<Pass1Line> = Vec::with_capacity(input.lines.len());

    for line in &input.lines {
        let effective_unit = if line.is_gift {
            line.base_unit_price.max(0)
        } else {
            resolve_tier_unit_price(line.base_unit_price, line.quantity, &line.tier_prices)
        };
        let undiscounted_subtotal = effective_unit.saturating_mul(line.quantity as MinorUnits);

        let mut attributions = Vec::new();
        let line_discount_amount = match select_winning_line_discount(line, undiscounted_subtotal) {
            Some((winner, amt)) if amt > 0 => {
                attributions.push(LineDiscountAttribution {
                    discount_id: winner.discount_id,
                    name: winner.name,
                    is_order_level: false,
                    amount: amt,
                });
                amt
            }
            _ => 0,
        };

        let subtotal_after_line_discount = undiscounted_subtotal - line_discount_amount;
        pass1_lines.push(Pass1Line {
            effective_base_unit_price: effective_unit,
            undiscounted_subtotal,
            line_discount_amount,
            subtotal_after_line_discount,
            attributions,
        });
    }

    // -------------------------------------------------------------------------
    // PASS 2: Order-Level Precedence & Pro-Rata Line Allocation
    // -------------------------------------------------------------------------
    // Precedence rule: ManualOrder > OrderVoucher > OrderPromotion (exclusive).
    // ShippingVoucher applies to shipping independently.
    let subtotal_eligible_for_order_discount: MinorUnits = pass1_lines
        .iter()
        .map(|l| l.subtotal_after_line_discount)
        .sum();

    let highest_subtotal_kind = input
        .candidate_order_discounts
        .iter()
        .filter(|d| d.kind != OrderDiscountKind::ShippingVoucher)
        .map(|d| d.kind)
        .max();

    let winning_subtotal_discount = highest_subtotal_kind.and_then(|target_kind| {
        input
            .candidate_order_discounts
            .iter()
            .filter(|d| d.kind == target_kind)
            .map(|d| {
                let amt = d.value.compute_against(subtotal_eligible_for_order_discount);
                (d.clone(), amt)
            })
            .max_by(|(d_a, amt_a), (d_b, amt_b)| {
                amt_a.cmp(amt_b).then_with(|| d_b.discount_id.cmp(&d_a.discount_id))
            })
    });

    let mut applied_order_discounts = Vec::new();
    let mut allocated_per_line: Vec<MinorUnits> = vec![0; input.lines.len()];

    if let Some((winner, total_order_discount)) = winning_subtotal_discount {
        if total_order_discount > 0 {
            let weighted_items: Vec<WeightedItem> = input
                .lines
                .iter()
                .zip(pass1_lines.iter())
                .map(|(line_in, p1)| WeightedItem {
                    id: line_in.line_id.clone(),
                    weight: p1.subtotal_after_line_discount,
                })
                .collect();

            let shares = allocate_pro_rata(total_order_discount, &weighted_items);
            for (idx, share) in shares.into_iter().enumerate() {
                allocated_per_line[idx] = share.allocated;
                if share.allocated > 0 {
                    pass1_lines[idx].attributions.push(LineDiscountAttribution {
                        discount_id: winner.discount_id.clone(),
                        name: winner.name.clone(),
                        is_order_level: true,
                        amount: share.allocated,
                    });
                }
            }

            applied_order_discounts.push(AppliedOrderDiscountSummary {
                discount_id: winner.discount_id,
                name: winner.name,
                kind: winner.kind,
                total_amount: total_order_discount,
            });
        }
    }

    // Shipping voucher resolution
    let shipping_base = input.shipping_base_amount.max(0);
    let winning_shipping_discount = input
        .candidate_order_discounts
        .iter()
        .filter(|d| d.kind == OrderDiscountKind::ShippingVoucher)
        .map(|d| {
            let amt = d.value.compute_against(shipping_base);
            (d.clone(), amt)
        })
        .max_by(|(d_a, amt_a), (d_b, amt_b)| {
            amt_a.cmp(amt_b).then_with(|| d_b.discount_id.cmp(&d_a.discount_id))
        });

    let shipping_discount_amount = match winning_shipping_discount {
        Some((winner, amt)) if amt > 0 => {
            applied_order_discounts.push(AppliedOrderDiscountSummary {
                discount_id: winner.discount_id,
                name: winner.name,
                kind: winner.kind,
                total_amount: amt,
            });
            amt
        }
        _ => 0,
    };

    // -------------------------------------------------------------------------
    // PASS 3: Line & Shipping Tax Derivation
    // -------------------------------------------------------------------------
    let mut calculated_lines = Vec::with_capacity(input.lines.len());
    let mut sum_line_net: MinorUnits = 0;
    let mut sum_line_tax: MinorUnits = 0;
    let mut sum_line_gross: MinorUnits = 0;

    for ((line_in, p1), order_disc_slice) in input
        .lines
        .iter()
        .zip(pass1_lines.into_iter())
        .zip(allocated_per_line.into_iter())
    {
        let final_line_amount = p1.subtotal_after_line_discount - order_disc_slice;
        let (net, tax, gross) =
            compute_net_tax_gross(final_line_amount, line_in.tax_rate_bps, input.tax_mode);

        sum_line_net += net;
        sum_line_tax += tax;
        sum_line_gross += gross;

        calculated_lines.push(CalculatedLineResult {
            line_id: line_in.line_id.clone(),
            variant_id: line_in.variant_id.clone(),
            quantity: line_in.quantity,
            is_gift: line_in.is_gift,
            effective_base_unit_price: p1.effective_base_unit_price,
            undiscounted_line_subtotal: p1.undiscounted_subtotal,
            line_level_discount_amount: p1.line_discount_amount,
            subtotal_after_line_discount: p1.subtotal_after_line_discount,
            allocated_order_discount_amount: order_disc_slice,
            discount_attributions: p1.attributions,
            total_net_amount: net,
            total_tax_amount: tax,
            total_gross_amount: gross,
        });
    }

    let shipping_after_discount = shipping_base - shipping_discount_amount;
    let (shipping_net, shipping_tax, shipping_gross) = compute_net_tax_gross(
        shipping_after_discount,
        input.shipping_tax_rate_bps,
        input.tax_mode,
    );

    CartCalculationResult {
        currency_code: input.currency_code.clone(),
        lines: calculated_lines,
        applied_order_discounts,
        shipping_undiscounted_amount: shipping_base,
        shipping_discount_amount,
        shipping_net_amount: shipping_net,
        shipping_tax_amount: shipping_tax,
        shipping_gross_amount: shipping_gross,
        total_net_amount: sum_line_net + shipping_net,
        total_tax_amount: sum_line_tax + shipping_tax,
        total_gross_amount: sum_line_gross + shipping_gross,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_precedence_manual_suppresses_voucher_and_order_promotion() {
        let input = CartCalculationInput {
            currency_code: "USD".into(),
            tax_mode: TaxInclusionMode::TaxExclusive,
            shipping_base_amount: 1000,
            shipping_tax_rate_bps: 0,
            lines: vec![CartLineInput {
                line_id: "L1".into(),
                variant_id: "V1".into(),
                quantity: 1,
                base_unit_price: 10_000, // $100.00
                tier_prices: vec![],
                tax_rate_bps: 1000, // 10%
                is_gift: false,
                candidate_line_discounts: vec![],
            }],
            candidate_order_discounts: vec![
                CandidateOrderDiscount {
                    discount_id: "promo-50".into(),
                    name: "50% Off Order Promo".into(),
                    kind: OrderDiscountKind::OrderPromotion,
                    value: DiscountValue::Percentage(5000), // $50
                },
                CandidateOrderDiscount {
                    discount_id: "voucher-30".into(),
                    name: "$30 Voucher".into(),
                    kind: OrderDiscountKind::OrderVoucher,
                    value: DiscountValue::Fixed(3000), // $30
                },
                CandidateOrderDiscount {
                    discount_id: "manual-15".into(),
                    name: "$15 Manual Agent Discount".into(),
                    kind: OrderDiscountKind::ManualOrder,
                    value: DiscountValue::Fixed(1500), // $15 wins because ManualOrder > Voucher > Promo
                },
            ],
        };

        let result = calculate_cart(&input);
        assert_eq!(result.applied_order_discounts.len(), 1);
        assert_eq!(result.applied_order_discounts[0].discount_id, "manual-15");
        assert_eq!(result.lines[0].allocated_order_discount_amount, 1500);
        // Net = $100 - $15 = $85.00 (8500), Tax 10% = $8.50 (850), Gross = $93.50 (9350)
        assert_eq!(result.lines[0].total_net_amount, 8500);
        assert_eq!(result.lines[0].total_tax_amount, 850);
        assert_eq!(result.lines[0].total_gross_amount, 9350);
    }

    #[test]
    fn test_gift_line_excluded_from_order_discount_allocation() {
        let input = CartCalculationInput {
            currency_code: "EUR".into(),
            tax_mode: TaxInclusionMode::TaxInclusive,
            shipping_base_amount: 0,
            shipping_tax_rate_bps: 0,
            lines: vec![
                CartLineInput {
                    line_id: "paid-item".into(),
                    variant_id: "V-PAID".into(),
                    quantity: 1,
                    base_unit_price: 5000,
                    tier_prices: vec![],
                    tax_rate_bps: 2000, // 20% VAT included
                    is_gift: false,
                    candidate_line_discounts: vec![],
                },
                CartLineInput {
                    line_id: "free-gift".into(),
                    variant_id: "V-GIFT".into(),
                    quantity: 1,
                    base_unit_price: 2000,
                    tier_prices: vec![],
                    tax_rate_bps: 2000,
                    is_gift: true,
                    candidate_line_discounts: vec![],
                },
            ],
            candidate_order_discounts: vec![CandidateOrderDiscount {
                discount_id: "order-1000".into(),
                name: "10 EUR Off".into(),
                kind: OrderDiscountKind::OrderVoucher,
                value: DiscountValue::Fixed(1000),
            }],
        };

        let res = calculate_cart(&input);
        let paid = &res.lines[0];
        let gift = &res.lines[1];

        // Paid item absorbs 100% of the 10 EUR order voucher
        assert_eq!(paid.allocated_order_discount_amount, 1000);
        assert_eq!(paid.total_gross_amount, 4000);
        // 4000 gross at 20% VAT -> net = 4000 * 10000 / 12000 = 3333, tax = 667
        assert_eq!(paid.total_net_amount, 3333);
        assert_eq!(paid.total_tax_amount, 667);

        // Gift line has 100% line-level gift discount and 0 order-level allocation
        assert_eq!(gift.line_level_discount_amount, 2000);
        assert_eq!(gift.allocated_order_discount_amount, 0);
        assert_eq!(gift.total_gross_amount, 0);
    }
}
