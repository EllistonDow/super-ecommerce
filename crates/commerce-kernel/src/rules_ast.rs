//! Promotion Eligibility & Action Rule AST Solver (`rules_ast`).
//!
//! Evaluates arbitrarily nested boolean predicate trees (`All`, `Any`, `Not`) against a
//! strongly-typed cart evaluation context AND computes deterministic multi-line action
//! rewards (`BuyXGetYCheapestFree`, `PercentageOffMatchingLines`, `FixedOrderOff`) in
//! sub-microsecond time.

use crate::money::{apply_bps, div_round_half_up, Bps, MinorUnits};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleEvalLine {
    pub variant_id: String,
    pub product_id: String,
    pub category_ids: Vec<String>,
    pub collection_ids: Vec<String>,
    pub quantity: u32,
    pub line_subtotal: MinorUnits,
    pub is_on_sale: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleEvalContext {
    pub channel_slug: String,
    pub currency_code: String,
    pub customer_group_ids: Vec<String>,
    pub cart_subtotal: MinorUnits,
    pub total_item_quantity: u32,
    pub lines: Vec<RuleEvalLine>,
}

/// Declarative Promotion Rule AST node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RulePredicate {
    /// Logical AND: all child predicates must match.
    All(Vec<RulePredicate>),
    /// Logical OR: at least one child predicate must match.
    Any(Vec<RulePredicate>),
    /// Logical NOT: negates the inner predicate.
    Not(Box<RulePredicate>),
    /// Matches if the cart belongs to one of the specified channel slugs.
    ChannelIn(Vec<String>),
    /// Matches if `cart_subtotal >= min_amount`.
    MinCartSubtotal(MinorUnits),
    /// Matches if `total_item_quantity >= min_quantity`.
    MinTotalQuantity(u32),
    /// Matches if the customer belongs to at least one of the specified B2B/VIP groups.
    CustomerGroupIn(Vec<String>),
    /// Matches if the total quantity of lines matching a collection is `>= min_quantity`
    /// (optionally excluding items already on sale).
    CollectionQuantityAtLeast {
        collection_id: String,
        min_quantity: u32,
        exclude_on_sale: bool,
    },
    /// Matches if the cart contains any of the specified variant IDs.
    ContainsVariantIn(Vec<String>),
}

impl RulePredicate {
    /// Evaluates the predicate tree deterministically against `ctx`.
    pub fn evaluate(&self, ctx: &RuleEvalContext) -> bool {
        match self {
            RulePredicate::All(children) => children.iter().all(|c| c.evaluate(ctx)),
            RulePredicate::Any(children) => children.iter().any(|c| c.evaluate(ctx)),
            RulePredicate::Not(inner) => !inner.evaluate(ctx),
            RulePredicate::ChannelIn(allowed) => allowed.iter().any(|c| c == &ctx.channel_slug),
            RulePredicate::MinCartSubtotal(min_amt) => ctx.cart_subtotal >= *min_amt,
            RulePredicate::MinTotalQuantity(min_qty) => ctx.total_item_quantity >= *min_qty,
            RulePredicate::CustomerGroupIn(groups) => {
                groups.iter().any(|g| ctx.customer_group_ids.contains(g))
            }
            RulePredicate::CollectionQuantityAtLeast {
                collection_id,
                min_quantity,
                exclude_on_sale,
            } => {
                let matching_qty: u32 = ctx
                    .lines
                    .iter()
                    .filter(|l| !(*exclude_on_sale && l.is_on_sale))
                    .filter(|l| l.collection_ids.contains(collection_id))
                    .map(|l| l.quantity)
                    .sum();
                matching_qty >= *min_quantity
            }
            RulePredicate::ContainsVariantIn(variants) => ctx
                .lines
                .iter()
                .any(|l| variants.contains(&l.variant_id)),
        }
    }
}

/// Declarative Promotion Reward Action computed when `RulePredicate` matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleAction {
    /// Applies a percentage discount (`bps`) to matching lines (or all lines when `collection_id` is `None`).
    PercentageOffMatchingLines {
        collection_id: Option<String>,
        exclude_on_sale: bool,
        bps: Bps,
    },
    /// Cross-line BOGO / Buy-X-Get-Y: for every `(buy_quantity + free_quantity)` eligible units,
    /// discounts the `free_quantity` cheapest units by `discount_bps` (10_000 = 100% free).
    BuyXGetYCheapestDiscount {
        collection_id: Option<String>,
        exclude_on_sale: bool,
        buy_quantity: u32,
        free_quantity: u32,
        discount_bps: Bps,
        max_applications: Option<u32>,
    },
    /// Fixed monetary reduction at the order level, capped at `cart_subtotal`.
    FixedOrderDiscount { amount: MinorUnits },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputedLineReward {
    pub line_index: usize,
    pub variant_id: String,
    pub discounted_units: u32,
    pub discount_amount: MinorUnits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionActionEvaluation {
    pub rule_id: String,
    pub matched: bool,
    pub exclusivity_group: Option<String>,
    pub line_rewards: Vec<ComputedLineReward>,
    pub order_discount_amount: MinorUnits,
    pub total_savings_amount: MinorUnits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionRuleDefinition {
    pub rule_id: String,
    pub exclusivity_group: Option<String>,
    pub predicate: RulePredicate,
    pub action: RuleAction,
}

/// Evaluates both eligibility (`predicate`) and deterministic multi-line reward allocation (`action`).
pub fn evaluate_promotion_rule(
    rule: &PromotionRuleDefinition,
    ctx: &RuleEvalContext,
) -> PromotionActionEvaluation {
    if !rule.predicate.evaluate(ctx) {
        return PromotionActionEvaluation {
            rule_id: rule.rule_id.clone(),
            matched: false,
            exclusivity_group: rule.exclusivity_group.clone(),
            line_rewards: Vec::new(),
            order_discount_amount: 0,
            total_savings_amount: 0,
        };
    }

    match &rule.action {
        RuleAction::FixedOrderDiscount { amount } => {
            let capped = (*amount).max(0).min(ctx.cart_subtotal.max(0));
            PromotionActionEvaluation {
                rule_id: rule.rule_id.clone(),
                matched: true,
                exclusivity_group: rule.exclusivity_group.clone(),
                line_rewards: Vec::new(),
                order_discount_amount: capped,
                total_savings_amount: capped,
            }
        }
        RuleAction::PercentageOffMatchingLines {
            collection_id,
            exclude_on_sale,
            bps,
        } => {
            let mut rewards = Vec::new();
            let mut sum: MinorUnits = 0;
            for (idx, line) in ctx.lines.iter().enumerate() {
                if *exclude_on_sale && line.is_on_sale {
                    continue;
                }
                if let Some(col) = collection_id {
                    if !line.collection_ids.contains(col) {
                        continue;
                    }
                }
                let disc = apply_bps(line.line_subtotal.max(0), *bps).min(line.line_subtotal.max(0));
                if disc > 0 {
                    sum += disc;
                    rewards.push(ComputedLineReward {
                        line_index: idx,
                        variant_id: line.variant_id.clone(),
                        discounted_units: line.quantity,
                        discount_amount: disc,
                    });
                }
            }
            PromotionActionEvaluation {
                rule_id: rule.rule_id.clone(),
                matched: true,
                exclusivity_group: rule.exclusivity_group.clone(),
                line_rewards: rewards,
                order_discount_amount: 0,
                total_savings_amount: sum,
            }
        }
        RuleAction::BuyXGetYCheapestDiscount {
            collection_id,
            exclude_on_sale,
            buy_quantity,
            free_quantity,
            discount_bps,
            max_applications,
        } => {
            let group_size = buy_quantity.saturating_add(*free_quantity);
            if *buy_quantity == 0 || *free_quantity == 0 || group_size == 0 {
                return PromotionActionEvaluation {
                    rule_id: rule.rule_id.clone(),
                    matched: true,
                    exclusivity_group: rule.exclusivity_group.clone(),
                    line_rewards: Vec::new(),
                    order_discount_amount: 0,
                    total_savings_amount: 0,
                };
            }

            // Expand eligible units with deterministic (unit_price, line_index) ordering
            let mut unit_pool: Vec<(MinorUnits, usize)> = Vec::new();
            for (idx, line) in ctx.lines.iter().enumerate() {
                if line.quantity == 0 || line.line_subtotal <= 0 {
                    continue;
                }
                if *exclude_on_sale && line.is_on_sale {
                    continue;
                }
                if let Some(col) = collection_id {
                    if !line.collection_ids.contains(col) {
                        continue;
                    }
                }
                let approx_unit =
                    div_round_half_up(line.line_subtotal as i128, line.quantity as i128);
                for _ in 0..line.quantity {
                    unit_pool.push((approx_unit, idx));
                }
            }

            let total_eligible_units = unit_pool.len() as u32;
            let mut bundles = total_eligible_units / group_size;
            if let Some(cap) = max_applications {
                bundles = bundles.min(*cap);
            }
            let rewarded_unit_count = (bundles.saturating_mul(*free_quantity)) as usize;

            // Sort ascending by unit price so the cheapest items receive the free/discounted benefit
            unit_pool.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

            let mut per_line_units = vec![0u32; ctx.lines.len()];
            let mut per_line_discount = vec![0i64; ctx.lines.len()];

            for &(unit_price, line_idx) in unit_pool.iter().take(rewarded_unit_count) {
                per_line_units[line_idx] += 1;
                per_line_discount[line_idx] += apply_bps(unit_price, *discount_bps);
            }

            let mut rewards = Vec::new();
            let mut total_savings: MinorUnits = 0;
            for (idx, line) in ctx.lines.iter().enumerate() {
                let clamped = per_line_discount[idx].min(line.line_subtotal.max(0));
                if clamped > 0 {
                    total_savings += clamped;
                    rewards.push(ComputedLineReward {
                        line_index: idx,
                        variant_id: line.variant_id.clone(),
                        discounted_units: per_line_units[idx],
                        discount_amount: clamped,
                    });
                }
            }

            PromotionActionEvaluation {
                rule_id: rule.rule_id.clone(),
                matched: true,
                exclusivity_group: rule.exclusivity_group.clone(),
                line_rewards: rewards,
                order_discount_amount: 0,
                total_savings_amount: total_savings,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_buy_3_summer_items_exclude_clearance_rule() {
        let rule = RulePredicate::All(vec![
            RulePredicate::ChannelIn(vec!["us-retail".into()]),
            RulePredicate::MinCartSubtotal(10_000),
            RulePredicate::CollectionQuantityAtLeast {
                collection_id: "summer-2026".into(),
                min_quantity: 3,
                exclude_on_sale: true,
            },
        ]);

        let mut ctx = RuleEvalContext {
            channel_slug: "us-retail".into(),
            currency_code: "USD".into(),
            customer_group_ids: vec![],
            cart_subtotal: 12_000,
            total_item_quantity: 4,
            lines: vec![
                RuleEvalLine {
                    variant_id: "V1".into(),
                    product_id: "P1".into(),
                    category_ids: vec![],
                    collection_ids: vec!["summer-2026".into()],
                    quantity: 2,
                    line_subtotal: 8_000,
                    is_on_sale: false,
                },
                RuleEvalLine {
                    variant_id: "V2-SALE".into(),
                    product_id: "P2".into(),
                    category_ids: vec![],
                    collection_ids: vec!["summer-2026".into()],
                    quantity: 2,
                    line_subtotal: 4_000,
                    is_on_sale: true,
                },
            ],
        };

        assert!(!rule.evaluate(&ctx));
        ctx.lines[0].quantity = 3;
        assert!(rule.evaluate(&ctx));
    }

    #[test]
    fn test_bogo_buy_2_get_1_cheapest_free_across_lines() {
        // 2 keyboards @ $200 ($400) + 1 mouse @ $80 -> Buy 2 Get 1 Free makes the $80 mouse free!
        let promo = PromotionRuleDefinition {
            rule_id: "promo-bogo-3for2".into(),
            exclusivity_group: Some("SEASONAL_BUNDLE".into()),
            predicate: RulePredicate::MinTotalQuantity(3),
            action: RuleAction::BuyXGetYCheapestDiscount {
                collection_id: Some("peripherals".into()),
                exclude_on_sale: true,
                buy_quantity: 2,
                free_quantity: 1,
                discount_bps: 10_000, // 100% free
                max_applications: Some(1),
            },
        };

        let ctx = RuleEvalContext {
            channel_slug: "us-retail".into(),
            currency_code: "USD".into(),
            customer_group_ids: vec![],
            cart_subtotal: 48_000,
            total_item_quantity: 3,
            lines: vec![
                RuleEvalLine {
                    variant_id: "VAR-KB".into(),
                    product_id: "P-KB".into(),
                    category_ids: vec![],
                    collection_ids: vec!["peripherals".into()],
                    quantity: 2,
                    line_subtotal: 40_000,
                    is_on_sale: false,
                },
                RuleEvalLine {
                    variant_id: "VAR-MOUSE".into(),
                    product_id: "P-MOUSE".into(),
                    category_ids: vec![],
                    collection_ids: vec!["peripherals".into()],
                    quantity: 1,
                    line_subtotal: 8_000,
                    is_on_sale: false,
                },
            ],
        };

        let eval = evaluate_promotion_rule(&promo, &ctx);
        assert!(eval.matched);
        assert_eq!(eval.total_savings_amount, 8_000);
        assert_eq!(eval.line_rewards.len(), 1);
        assert_eq!(eval.line_rewards[0].variant_id, "VAR-MOUSE");
        assert_eq!(eval.line_rewards[0].discounted_units, 1);
        assert_eq!(eval.line_rewards[0].discount_amount, 8_000);
    }
}
