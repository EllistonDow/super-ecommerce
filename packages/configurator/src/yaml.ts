import type { StoreConfigDocument } from "./index.ts";

export const BIGINT_PRICE_KEYS = new Set([
  "priceAmount",
  "compareAtAmount",
  "unitAmount",
]);

export function serializeStoreConfigJson(value: unknown, pretty = true): string {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === "bigint" ? val.toString() : val),
    pretty ? 2 : undefined
  );
}

export function parseStoreConfigJson(rawJson: string): StoreConfigDocument {
  return JSON.parse(rawJson, (key, val) => {
    if (
      BIGINT_PRICE_KEYS.has(key) &&
      (typeof val === "string" || typeof val === "number")
    ) {
      if (typeof val === "string" && /^\d+$/.test(val)) {
        return BigInt(val);
      }
      if (typeof val === "number" && Number.isInteger(val) && val >= 0) {
        return BigInt(val);
      }
    }
    return val;
  }) as StoreConfigDocument;
}

function formatYamlScalar(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  const str = String(val);
  if (
    str.length === 0 ||
    /[:#\[\]\{\}&*!|>'"%@`\n\r]/.test(str) ||
    /^\s|\s$/.test(str) ||
    /^(true|false|null|yes|no|~|-?\d+(\.\d+)?)$/i.test(str)
  ) {
    return JSON.stringify(str);
  }
  return str;
}

function serializeYamlValue(val: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(val)) {
    if (val.length === 0) return [`${pad}[]`];
    const allPrimitive = val.every(
      (item) =>
        item === null ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean" ||
        typeof item === "bigint"
    );
    if (allPrimitive && val.length <= 6 && val.every((x) => String(x).length < 32)) {
      return [`[${val.map((x) => formatYamlScalar(x)).join(", ")}]`];
    }
    const lines: string[] = [];
    for (const item of val) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>).filter(
          ([, v]) => v !== undefined
        );
        if (entries.length === 0) {
          lines.push(`${pad}- {}`);
          continue;
        }
        const [firstKey, firstVal] = entries[0]!;
        if (isScalar(firstVal)) {
          lines.push(`${pad}- ${firstKey}: ${formatYamlScalar(firstVal)}`);
        } else {
          const nestedFirst = serializeYamlValue(firstVal, indent + 4);
          if (nestedFirst.length === 1 && nestedFirst[0]!.startsWith("[")) {
            lines.push(`${pad}- ${firstKey}: ${nestedFirst[0]!}`);
          } else {
            lines.push(`${pad}- ${firstKey}:`);
            lines.push(...nestedFirst);
          }
        }
        for (let i = 1; i < entries.length; i++) {
          const [k, v] = entries[i]!;
          if (isScalar(v)) {
            lines.push(`${pad}  ${k}: ${formatYamlScalar(v)}`);
          } else {
            const nested = serializeYamlValue(v, indent + 4);
            if (
              nested.length === 1 &&
              (nested[0]!.startsWith("[") || nested[0]!.trim() === "{}" || nested[0]!.trim() === "[]")
            ) {
              lines.push(`${pad}  ${k}: ${nested[0]!.trim()}`);
            } else {
              lines.push(`${pad}  ${k}:`);
              lines.push(...nested);
            }
          }
        }
      } else {
        lines.push(`${pad}- ${formatYamlScalar(item)}`);
      }
    }
    return lines;
  }

  if (val && typeof val === "object") {
    const entries = Object.entries(val as Record<string, unknown>).filter(
      ([, v]) => v !== undefined
    );
    if (entries.length === 0) return [`${pad}{}`];
    const lines: string[] = [];
    for (const [k, v] of entries) {
      if (isScalar(v)) {
        lines.push(`${pad}${k}: ${formatYamlScalar(v)}`);
      } else {
        const nested = serializeYamlValue(v, indent + 2);
        if (
          nested.length === 1 &&
          (nested[0]!.startsWith("[") || nested[0]!.trim() === "{}" || nested[0]!.trim() === "[]")
        ) {
          lines.push(`${pad}${k}: ${nested[0]!.trim()}`);
        } else {
          lines.push(`${pad}${k}:`);
          lines.push(...nested);
        }
      }
    }
    return lines;
  }

  return [`${pad}${formatYamlScalar(val)}`];
}

function isScalar(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean" ||
    typeof v === "bigint"
  );
}

export function serializeStoreConfigYaml(doc: StoreConfigDocument): string {
  const lines = [
    "# Super Ecommerce Store Configuration (YAML)",
    "# Universal immutable slug identity: warehouses -> channels -> productTypes -> products",
    ...serializeYamlValue(doc, 0),
  ];
  return lines.join("\n") + "\n";
}

interface YamlTokenLine {
  readonly lineNum: number;
  readonly indent: number;
  readonly text: string;
}

function stripYamlComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && raw[i - 1] !== "\\") {
      inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(raw[i - 1]!)) {
        return raw.slice(0, i);
      }
    }
  }
  return raw;
}

function parseYamlScalar(raw: string, keyHint?: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed = JSON.parse(trimmed) as string;
      if (keyHint && BIGINT_PRICE_KEYS.has(keyHint) && /^\d+$/.test(parsed)) {
        return BigInt(parsed);
      }
      return parsed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    const unquoted = trimmed.slice(1, -1).replaceAll("''", "'");
    if (keyHint && BIGINT_PRICE_KEYS.has(keyHint) && /^\d+$/.test(unquoted)) {
      return BigInt(unquoted);
    }
    return unquoted;
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    const items: unknown[] = [];
    let cur = "";
    let inS = false;
    let inD = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]!;
      if (ch === "'" && !inD) inS = !inS;
      else if (ch === '"' && !inS && inner[i - 1] !== "\\") inD = !inD;
      else if (ch === "," && !inS && !inD) {
        items.push(parseYamlScalar(cur));
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim().length > 0) {
      items.push(parseYamlScalar(cur));
    }
    return items;
  }

  if (/^-?\d+$/.test(trimmed)) {
    if (keyHint && BIGINT_PRICE_KEYS.has(keyHint) && !trimmed.startsWith("-")) {
      return BigInt(trimmed);
    }
    return Number(trimmed);
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed;
}

function splitKeyVal(text: string): { key: string; rest: string } | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && text[i - 1] !== "\\") inDouble = !inDouble;
    else if (ch === ":" && !inSingle && !inDouble) {
      if (i + 1 === text.length || /\s/.test(text[i + 1]!)) {
        const rawKey = text.slice(0, i).trim();
        const key =
          (rawKey.startsWith('"') && rawKey.endsWith('"')) ||
          (rawKey.startsWith("'") && rawKey.endsWith("'"))
            ? rawKey.slice(1, -1)
            : rawKey;
        const rest = text.slice(i + 1).trim();
        return { key, rest };
      }
    }
  }
  return null;
}

function parseYamlBlock(
  tokens: readonly YamlTokenLine[],
  startIdx: number,
  expectedIndent: number
): { value: unknown; nextIdx: number } {
  if (startIdx >= tokens.length) {
    return { value: {}, nextIdx: startIdx };
  }
  const first = tokens[startIdx]!;
  if (first.indent < expectedIndent) {
    return { value: {}, nextIdx: startIdx };
  }
  if (first.text.startsWith("- ") || first.text === "-") {
    return parseYamlSequence(tokens, startIdx, first.indent);
  }
  return parseYamlMapping(tokens, startIdx, first.indent);
}

function parseYamlSequence(
  tokens: readonly YamlTokenLine[],
  startIdx: number,
  seqIndent: number
): { value: unknown[]; nextIdx: number } {
  const arr: unknown[] = [];
  let idx = startIdx;

  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (tok.indent < seqIndent) break;
    if (tok.indent > seqIndent) {
      throw new Error(`Unexpected indentation at YAML line ${tok.lineNum}`);
    }
    if (!(tok.text.startsWith("- ") || tok.text === "-")) {
      break;
    }

    const afterDash = tok.text === "-" ? "" : tok.text.slice(2).trim();
    if (afterDash.length === 0) {
      if (idx + 1 < tokens.length && tokens[idx + 1]!.indent > seqIndent) {
        const nested = parseYamlBlock(tokens, idx + 1, tokens[idx + 1]!.indent);
        arr.push(nested.value);
        idx = nested.nextIdx;
      } else {
        arr.push(null);
        idx += 1;
      }
      continue;
    }

    const kv = splitKeyVal(afterDash);
    if (!kv) {
      arr.push(parseYamlScalar(afterDash));
      idx += 1;
      continue;
    }

    const obj: Record<string, unknown> = {};
    const itemFieldIndent = seqIndent + 2;
    if (kv.rest.length > 0) {
      obj[kv.key] = parseYamlScalar(kv.rest, kv.key);
      idx += 1;
    } else if (idx + 1 < tokens.length && tokens[idx + 1]!.indent > itemFieldIndent) {
      const nested = parseYamlBlock(tokens, idx + 1, tokens[idx + 1]!.indent);
      obj[kv.key] = nested.value;
      idx = nested.nextIdx;
    } else if (
      idx + 1 < tokens.length &&
      tokens[idx + 1]!.indent === itemFieldIndent &&
      tokens[idx + 1]!.text.startsWith("- ")
    ) {
      const nested = parseYamlSequence(tokens, idx + 1, itemFieldIndent);
      obj[kv.key] = nested.value;
      idx = nested.nextIdx;
    } else {
      obj[kv.key] = {};
      idx += 1;
    }

    while (idx < tokens.length) {
      const nextTok = tokens[idx]!;
      if (nextTok.indent < itemFieldIndent) break;
      if (nextTok.indent > itemFieldIndent) {
        throw new Error(`Unexpected indentation inside sequence item at YAML line ${nextTok.lineNum}`);
      }
      if (nextTok.text.startsWith("- ") || nextTok.text === "-") break;
      const moreKv = splitKeyVal(nextTok.text);
      if (!moreKv) {
        throw new Error(`Expected key: value at YAML line ${nextTok.lineNum}`);
      }
      if (moreKv.rest.length > 0) {
        obj[moreKv.key] = parseYamlScalar(moreKv.rest, moreKv.key);
        idx += 1;
      } else if (idx + 1 < tokens.length && tokens[idx + 1]!.indent > itemFieldIndent) {
        const nested = parseYamlBlock(tokens, idx + 1, tokens[idx + 1]!.indent);
        obj[moreKv.key] = nested.value;
        idx = nested.nextIdx;
      } else if (
        idx + 1 < tokens.length &&
        tokens[idx + 1]!.indent === itemFieldIndent &&
        tokens[idx + 1]!.text.startsWith("- ")
      ) {
        const nested = parseYamlSequence(tokens, idx + 1, itemFieldIndent);
        obj[moreKv.key] = nested.value;
        idx = nested.nextIdx;
      } else {
        obj[moreKv.key] = {};
        idx += 1;
      }
    }

    arr.push(obj);
  }

  return { value: arr, nextIdx: idx };
}

function parseYamlMapping(
  tokens: readonly YamlTokenLine[],
  startIdx: number,
  mapIndent: number
): { value: Record<string, unknown>; nextIdx: number } {
  const obj: Record<string, unknown> = {};
  let idx = startIdx;

  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (tok.indent < mapIndent) break;
    if (tok.indent > mapIndent) {
      throw new Error(`Unexpected indentation at YAML line ${tok.lineNum}`);
    }
    if (tok.text.startsWith("- ") || tok.text === "-") break;

    const kv = splitKeyVal(tok.text);
    if (!kv) {
      throw new Error(`Expected key: value syntax at YAML line ${tok.lineNum}: "${tok.text}"`);
    }

    if (kv.rest.length > 0) {
      obj[kv.key] = parseYamlScalar(kv.rest, kv.key);
      idx += 1;
    } else if (idx + 1 < tokens.length && tokens[idx + 1]!.indent > mapIndent) {
      const nested = parseYamlBlock(tokens, idx + 1, tokens[idx + 1]!.indent);
      obj[kv.key] = nested.value;
      idx = nested.nextIdx;
    } else if (
      idx + 1 < tokens.length &&
      tokens[idx + 1]!.indent === mapIndent &&
      tokens[idx + 1]!.text.startsWith("- ")
    ) {
      const nested = parseYamlSequence(tokens, idx + 1, mapIndent);
      obj[kv.key] = nested.value;
      idx = nested.nextIdx;
    } else {
      obj[kv.key] = {};
      idx += 1;
    }
  }

  return { value: obj, nextIdx: idx };
}

function normalizeStoreConfigDocument(raw: unknown): StoreConfigDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Store config root document must be an object/mapping");
  }
  const obj = raw as Record<string, unknown>;
  const asArray = <T>(key: string): T[] => {
    const v = obj[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      throw new Error(`Top-level '${key}' must be an array/sequence`);
    }
    return v as T[];
  };

  return {
    warehouses: asArray("warehouses"),
    channels: asArray("channels"),
    productTypes: asArray("productTypes"),
    products: asArray("products"),
  };
}

export function parseStoreConfigText(rawText: string): {
  readonly format: "json" | "yaml";
  readonly document: StoreConfigDocument;
} {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("Configuration input is empty");
  }
  if (trimmed.startsWith("{")) {
    return {
      format: "json",
      document: normalizeStoreConfigDocument(parseStoreConfigJson(trimmed)),
    };
  }

  const lines = rawText.split(/\r?\n/);
  const tokens: YamlTokenLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cleaned = stripYamlComment(lines[i]!);
    if (cleaned.trim().length === 0) continue;
    const indent = cleaned.length - cleaned.trimStart().length;
    tokens.push({
      lineNum: i + 1,
      indent,
      text: cleaned.trim(),
    });
  }
  if (tokens.length === 0) {
    throw new Error("YAML configuration contains no key/value entries");
  }

  const parsed = parseYamlBlock(tokens, 0, tokens[0]!.indent);
  return {
    format: "yaml",
    document: normalizeStoreConfigDocument(parsed.value),
  };
}
