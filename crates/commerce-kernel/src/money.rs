//! Zero-float monetary primitives, ISO-4217 multi-currency precision, VAT derivation,
//! and B2B tier-price resolution.
//!
//! All monetary values are represented in integer `MinorUnits` (e.g. cents for USD/EUR,
//! yen for JPY, fils for KWD/BHD). Intermediate multiplications and ratios use `i128`
//! to prevent overflow even on multi-billion-dollar B2B carts.

/// Monetary amount in the currency's smallest subdivision (minor units).
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

/// Returns the official ISO-4217 minor-unit decimal exponent for `currency_code`:
/// - `0`: Zero-decimal currencies (`JPY`, `KRW`, `VND`, `CLP`, `ISK`, `PYG`, `RWF`, `UGX`, `XAF`, `XOF`, `XPF`, etc.)
/// - `3`: Three-decimal currencies (`BHD`, `IQD`, `JOD`, `KWD`, `LYD`, `OMR`, `TND`)
/// - `4`: Four-decimal accounting units (`CLF`, `UYW`)
/// - `2`: Standard two-decimal currencies (`USD`, `EUR`, `GBP`, `CNY`, `CAD`, `AUD`, `SGD`, etc.)
#[inline]
pub fn currency_exponent(currency_code: &str) -> u8 {
    let mut upper = [0u8; 3];
    let bytes = currency_code.trim().as_bytes();
    if bytes.len() != 3 {
        return 2;
    }
    upper[0] = bytes[0].to_ascii_uppercase();
    upper[1] = bytes[1].to_ascii_uppercase();
    upper[2] = bytes[2].to_ascii_uppercase();

    match &upper {
        b"BIF" | b"CLP" | b"DJF" | b"GNF" | b"ISK" | b"JPY" | b"KMF" | b"KRW" | b"PYG"
        | b"RWF" | b"UGX" | b"VND" | b"VUV" | b"XAF" | b"XOF" | b"XPF" => 0,
        b"BHD" | b"IQD" | b"JOD" | b"KWD" | b"LYD" | b"OMR" | b"TND" => 3,
        b"CLF" | b"UYW" => 4,
        _ => 2,
    }
}

/// Returns `10 ^ currency_exponent(currency_code)` (e.g. `1` for JPY, `100` for USD, `1000` for KWD).
#[inline]
pub fn currency_scale_factor(currency_code: &str) -> MinorUnits {
    match currency_exponent(currency_code) {
        0 => 1,
        3 => 1_000,
        4 => 10_000,
        _ => 100,
    }
}

/// Formats `amount` in `MinorUnits` into an exact decimal string without IEEE-754 floating-point
/// conversion (e.g. `(15800, "JPY") -> "15800"`, `(1999, "USD") -> "19.99"`, `(12345, "KWD") -> "12.345"`).
pub fn format_minor_units(amount: MinorUnits, currency_code: &str) -> String {
    let exp = currency_exponent(currency_code) as usize;
    let is_neg = amount < 0;
    let abs_val: u128 = amount.unsigned_abs() as u128;
    let sign = if is_neg { "-" } else { "" };

    if exp == 0 {
        return format!("{}{}", sign, abs_val);
    }

    let scale = 10u128.pow(exp as u32);
    let major = abs_val / scale;
    let minor = abs_val % scale;
    format!("{}{}.{:0width$}", sign, major, minor, width = exp)
}

/// Divides `numerator / denominator` using deterministic Round-Half-Up (commercial rounding).
///
/// Both `numerator` and `denominator` must be non-negative, and `denominator > 0`.
#[inline]
pub fn div_round_half_up(numerator: i128, denominator: i128) -> MinorUnits {
    if numerator <= 0 || denominator <= 0 {
        return 0;
    }
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

/// Extracts pre-tax net amount from a VAT-inclusive `gross` amount at `tax_rate_bps`
/// using Round-Half-Up: `round(gross * 10_000 / (10_000 + tax_rate_bps))`.
#[inline]
pub fn extract_vat_net(gross: MinorUnits, tax_rate_bps: Bps) -> MinorUnits {
    if gross <= 0 {
        return 0;
    }
    if tax_rate_bps == 0 {
        return gross;
    }
    div_round_half_up(
        (gross as i128) * (MAX_BPS as i128),
        (MAX_BPS as i128) + (tax_rate_bps as i128),
    )
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

    #[test]
    fn test_iso4217_exponents_and_exact_formatting() {
        assert_eq!(currency_exponent("JPY"), 0);
        assert_eq!(currency_exponent("krw"), 0);
        assert_eq!(currency_exponent("USD"), 2);
        assert_eq!(currency_exponent("EUR"), 2);
        assert_eq!(currency_exponent("KWD"), 3);
        assert_eq!(currency_exponent("BHD"), 3);

        assert_eq!(format_minor_units(15800, "JPY"), "15800");
        assert_eq!(format_minor_units(5, "USD"), "0.05");
        assert_eq!(format_minor_units(-1999, "USD"), "-19.99");
        assert_eq!(format_minor_units(12005, "KWD"), "12.005");
    }
}
