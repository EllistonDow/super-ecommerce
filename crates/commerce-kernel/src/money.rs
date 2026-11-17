//! Zero-float monetary primitives and B2B tier-price resolution.
//!
//! All monetary values are represented in integer `MinorUnits` (e.g. cents for USD/EUR,
//! yen for JPY). Intermediate multiplications and ratios use `i128` to prevent overflow
//! even on multi-billion-dollar B2B carts.

/// Monetary amount in the currency's smallest subdivision (e.g. cents).
pub type MinorUnits = i64;

/// Basis points where `10_000` bps = `100.00%` (e.g. `825` = `8.25%`).
pub type Bps = u32;

pub const MAX_BPS: Bps = 10_000;

/// B2B quantity-break price tier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriceTier {
    pub min_quantity: u32,
    pub unit_amount: MinorUnits,
}

/// Divides `numerator / denominator` using deterministic Round-Half-Up (commercial rounding).
///
/// Both `numerator` and `denominator` must be non-negative, and `denominator > 0`.
#[inline]
pub fn div_round_half_up(numerator: i128, denominator: i128) -> MinorUnits {
    debug_assert!(numerator >= 0, "numerator must be non-negative");
    debug_assert!(denominator > 0, "denominator must be positive");
    let quotient = (numerator + (denominator / 2)) / denominator;
    quotient as MinorUnits
}

/// Applies a basis-point percentage (`bps` out of `10_000`) to `amount` using Round-Half-Up.
#[inline]
pub fn apply_bps(amount: MinorUnits, bps: Bps) -> MinorUnits {
    if amount <= 0 || bps == 0 {
        return 0;
    }
    let clamped_bps = bps.min(MAX_BPS) as i128;
    div_round_half_up((amount as i128) * clamped_bps, MAX_BPS as i128)
}

/// Resolves the effective base unit price considering B2B quantity tiers.
///
/// Picks the lowest `unit_amount` among all tiers whose `min_quantity <= quantity`,
/// capped at `base_unit_price`.
pub fn resolve_tier_unit_price(
    base_unit_price: MinorUnits,
    quantity: u32,
    tiers: &[PriceTier],
) -> MinorUnits {
    let mut best = base_unit_price.max(0);
    for tier in tiers {
        if quantity >= tier.min_quantity && tier.unit_amount >= 0 && tier.unit_amount < best {
            best = tier.unit_amount;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_bps_half_up() {
        // $19.99 * 8.25% (825 bps) = 1999 * 825 / 10000 = 164.9175 -> 165 cents
        assert_eq!(apply_bps(1999, 825), 165);
        // $10.00 * 50% (5000 bps) = 500 cents
        assert_eq!(apply_bps(1000, 5000), 500);
        // $0.01 * 50% (5000 bps) = 0.5 -> rounds half up to 1 cent
        assert_eq!(apply_bps(1, 5000), 1);
    }

    #[test]
    fn test_resolve_tier_unit_price() {
        let tiers = vec![
            PriceTier {
                min_quantity: 10,
                unit_amount: 1800,
            },
            PriceTier {
                min_quantity: 100,
                unit_amount: 1500,
            },
        ];
        assert_eq!(resolve_tier_unit_price(2000, 1, &tiers), 2000);
        assert_eq!(resolve_tier_unit_price(2000, 10, &tiers), 1800);
        assert_eq!(resolve_tier_unit_price(2000, 55, &tiers), 1800);
        assert_eq!(resolve_tier_unit_price(2000, 100, &tiers), 1500);
    }
}
