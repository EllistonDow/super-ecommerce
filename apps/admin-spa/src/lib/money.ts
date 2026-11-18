/**
 * Zero-Float ISO-4217 Minor-Unit Money Formatter & Parser (`@super-ecommerce/admin-spa`).
 *
 * Strictly forbids `Number` floating-point arithmetic (`0.1 + 0.2`) on monetary values.
 * Operates exclusively on `BigInt` minor units and exact integer string slicing.
 */

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
  "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

const FOUR_DECIMAL_CURRENCIES = new Set(["CLF", "UYW"]);

export function currencyExponent(currencyCode: string): 0 | 2 | 3 | 4 {
  const code = currencyCode.trim().toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  if (FOUR_DECIMAL_CURRENCIES.has(code)) return 4;
  return 2;
}

export function parseBigIntMinor(raw: string | number | bigint | undefined | null): bigint {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number") return BigInt(Math.trunc(raw));
  if (!raw) return 0n;
  const cleaned = raw.trim().endsWith("n") ? raw.trim().slice(0, -1) : raw.trim();
  if (!cleaned) return 0n;
  return BigInt(cleaned);
}

export function formatMinorUnits(
  rawMinor: string | number | bigint,
  currencyCode = "USD"
): string {
  const code = currencyCode.trim().toUpperCase() || "USD";
  const exp = currencyExponent(code);
  const amount = parseBigIntMinor(rawMinor);
  const isNeg = amount < 0n;
  const abs = isNeg ? -amount : amount;

  if (exp === 0) {
    return `${isNeg ? "-" : ""}${code} ${abs.toString()}`;
  }

  const divisor = 10n ** BigInt(exp);
  const whole = abs / divisor;
  const frac = (abs % divisor).toString().padStart(exp, "0");
  return `${isNeg ? "-" : ""}${code} ${whole.toString()}.${frac}`;
}

/**
 * Parses a human decimal string (e.g. `"25.50"` in USD -> `2550n`) without `parseFloat`.
 */
export function parseDecimalToMinorUnits(decimalInput: string, currencyCode = "USD"): bigint {
  const trimmed = decimalInput.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid monetary amount '${decimalInput}'`);
  }
  const exp = currencyExponent(currencyCode);
  const isNeg = trimmed.startsWith("-");
  const unsigned = isNeg ? trimmed.slice(1) : trimmed;
  const [wholePart = "0", fracPart = ""] = unsigned.split(".");
  if (exp === 0 && fracPart.length > 0 && Number(fracPart) !== 0) {
    throw new Error(`Currency ${currencyCode} does not allow fractional minor units`);
  }
  const normalizedFrac = fracPart.slice(0, exp).padEnd(exp, "0");
  const combined = BigInt(wholePart) * 10n ** BigInt(exp) + BigInt(normalizedFrac || "0");
  return isNeg ? -combined : combined;
}
