//! Promotion & Eligibility Rule AST Evaluator (`rules_ast`).
//!
//! Evaluates arbitrarily nested boolean predicate trees (`All`, `Any`, `Not`) against a
//! strongly-typed cart evaluation context in sub-microsecond time.

use crate::money::MinorUnits;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_buy_3_summer_items_exclude_clearance_rule() {
        // Rule: Channel is "us-retail" AND cart >= $100 AND at least 3 non-sale items in "summer-2026"
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
                    is_on_sale: true, // Excluded by exclude_on_sale!
                },
            ],
        };

        // Only 2 non-sale items in summer-2026 -> false
        assert!(!rule.evaluate(&ctx));

        // Add 1 more non-sale item -> 3 non-sale items -> true
        ctx.lines[0].quantity = 3;
        assert!(rule.evaluate(&ctx));
    }
}
