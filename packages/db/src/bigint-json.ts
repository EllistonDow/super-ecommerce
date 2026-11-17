/**
 * Lossless JSON serialization preserving `bigint` (`MinorUnits`) across PostgreSQL JSONB columns.
 */

export function serializeWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    typeof val === "bigint" ? { __bigint__: val.toString() } : val
  );
}

export function deserializeWithBigInt<T>(rawJson: string): T {
  return JSON.parse(rawJson, (_key, val) => {
    if (
      val &&
      typeof val === "object" &&
      "__bigint__" in val &&
      typeof (val as { __bigint__: unknown }).__bigint__ === "string"
    ) {
      return BigInt((val as { __bigint__: string }).__bigint__);
    }
    return val;
  }) as T;
}
