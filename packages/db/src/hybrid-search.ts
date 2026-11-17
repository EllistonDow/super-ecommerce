/**
 * Hybrid Catalog Search Engine (`packages/db/src/hybrid-search.ts`)
 *
 * Implements Okapi BM25 lexical ranking + 64-dimensional semantic feature vector
 * cosine similarity fused via Reciprocal Rank Fusion (RRF, k = 60) over
 * zero-JOIN `CatalogChannelProjectionRecord` rows.
 */

import type { CatalogChannelProjectionRecord } from "./schema-types.ts";

export interface HybridSearchQueryInput {
  readonly channelSlug: string;
  readonly queryText?: string;
  readonly inStockOnly?: boolean;
  readonly maxPriceAmount?: bigint;
  readonly attributeFilters?: Readonly<Record<string, string | number | boolean>>;
  readonly rrfK?: number;
  readonly limit?: number;
  readonly minVectorSimilarity?: number;
}

export type HybridMatchOrigin =
  | "HYBRID_BOTH"
  | "LEXICAL_BM25"
  | "VECTOR_SEMANTIC"
  | "FILTER_ONLY";

export interface HybridSearchHit {
  readonly projection: CatalogChannelProjectionRecord;
  readonly rrfScore: number;
  readonly bm25Score: number;
  readonly bm25Rank: number | null;
  readonly vectorSimilarity: number;
  readonly vectorRank: number | null;
  readonly matchedBy: HybridMatchOrigin;
}

export interface HybridSearchReport {
  readonly channelSlug: string;
  readonly queryText: string;
  readonly rrfK: number;
  readonly candidatePoolCount: number;
  readonly bm25MatchedCount: number;
  readonly vectorMatchedCount: number;
  readonly totalReturned: number;
  readonly latencyUs: number;
  readonly pgHybridRrfSql: string;
  readonly hits: readonly HybridSearchHit[];
}

const SEMANTIC_DIM_CLUSTERS: readonly (readonly string[])[] = [
  // 0: Keyboard / typing / mechanical switches
  ["keyboard", "keycap", "switch", "tactile", "linear", "optical", "mechanical", "typing", "desk", "key", "board", "75", "65"],
  // 1: Silent / quiet / acoustic / dampened
  ["silent", "quiet", "muted", "dampened", "gasket", "acoustic", "low-noise", "office", "stealth"],
  // 2: Metal / Titanium / CNC / Aluminum / Alloy
  ["titanium", "aluminum", "aluminium", "cnc", "milled", "billet", "alloy", "metal", "steel", "brass", "anodized", "machined", "chassis"],
  // 3: Watch / Horology / Timepiece
  ["watch", "timepiece", "chronograph", "field", "horology", "dial", "bezel", "sapphire", "automatic", "quartz", "wrist", "strap"],
  // 4: Waterproof / Rugged / Outdoor / Tactical
  ["waterproof", "water", "resistant", "rugged", "tactical", "outdoor", "sealed", "ip68", "10atm", "dive", "field"],
  // 5: Apparel / Hoodie / Fabric / Clothing
  ["hoodie", "pullover", "jacket", "apparel", "cotton", "fleece", "fabric", "gsm", "garment", "wear", "shirt", "sleeve"],
  // 6: Robotics / Industrial / Defense / Precision Hardware
  ["robotics", "defense", "industrial", "precision", "hardware", "kronos", "enterprise", "autonomous", "actuator", "servo", "sensor", "module"],
  // 7: Dark / Obsidian / Black / Matte
  ["obsidian", "black", "dark", "matte", "charcoal", "onyx", "carbon", "midnight"],
  // 8: Light / Silver / Ivory / Titanium Raw
  ["ivory", "silver", "white", "raw", "brushed", "natural", "titanium", "pearl"],
  // 9: Blue / Cobalt / Navy
  ["cobalt", "blue", "navy", "azure", "sapphire", "indigo"],
  // 10: Size & Form Factor (Compact / Portable / Large)
  ["compact", "portable", "mini", "slim", "lightweight", "heavyweight", "oversized", "xl", "large", "medium", "small"],
  // 11: Connectivity / Wireless / High-Speed
  ["wireless", "bluetooth", "usb", "usbc", "low-latency", "wired", "hot-swap", "hotswap", "qmk", "via"],
  // 12: Luxury / Flagship / Limited / Grade-5
  ["luxury", "flagship", "grade-5", "premium", "signature", "pro", "ultra", "elite", "artisan"],
  // 13: Organic / Sustainable / Eco
  ["organic", "eco", "sustainable", "recycled", "pre-shrunk", "breathable", "soft"],
  // 14: Tools / Fasteners / Components / Saleor Industrial
  ["bolt", "screw", "nut", "bearing", "bracket", "adapter", "cable", "connector", "kit", "tool", "wrench", "gauge"],
  // 15: Electrical / Power / Controller / PCB
  ["pcb", "power", "battery", "voltage", "controller", "mcu", "arm", "firmware", "led", "rgb"],
];

const VECTOR_DIMENSIONS = 64;
const SEMANTIC_CLUSTER_OFFSET = 0;
const TRIGRAM_OFFSET = 32;
const TRIGRAM_DIMS = VECTOR_DIMENSIONS - TRIGRAM_OFFSET;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")
    .split(/\s+/)
    .flatMap((tok) => {
      if (!tok) return [];
      const parts = tok.split("-").filter(Boolean);
      return parts.length > 1 ? [tok, ...parts] : [tok];
    });
}

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Generates a deterministic 64-dimensional L2-normalized semantic + trigram feature vector.
 * Dimensions [0..15] capture domain concept clusters (for synonym recall),
 * [16..31] encode compound cluster co-occurrences, and [32..63] encode signed character trigrams.
 */
export function buildDeterministicSemanticVector(text: string): Float64Array {
  const vec = new Float64Array(VECTOR_DIMENSIONS);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;

  // 1. Semantic cluster activations (weighted higher for cross-synonym recall)
  const activeClusters: number[] = [];
  for (let c = 0; c < SEMANTIC_DIM_CLUSTERS.length; c++) {
    const keywords = SEMANTIC_DIM_CLUSTERS[c]!;
    let hits = 0;
    for (const tok of tokens) {
      for (const kw of keywords) {
        if (tok === kw || (tok.length >= 4 && kw.startsWith(tok)) || (kw.length >= 4 && tok.startsWith(kw))) {
          hits += 1;
          break;
        }
      }
    }
    if (hits > 0) {
      vec[SEMANTIC_CLUSTER_OFFSET + c] = 2.4 * Math.sqrt(hits);
      activeClusters.push(c);
    }
  }

  // Pairwise semantic co-occurrence boost across dims 16..31
  for (let i = 0; i < activeClusters.length; i++) {
    for (let j = i + 1; j < activeClusters.length; j++) {
      const pairBucket = 16 + ((activeClusters[i]! * 7 + activeClusters[j]! * 13) % 16);
      vec[pairBucket] += 0.9;
    }
  }

  // 2. Character trigram signed feature hashing across dims 32..63
  for (const tok of tokens) {
    const padded = `^${tok}$`;
    for (let i = 0; i <= padded.length - 3; i++) {
      const gram = padded.slice(i, i + 3);
      const h = fnv1a32(gram);
      const bucket = TRIGRAM_OFFSET + (h % TRIGRAM_DIMS);
      const sign = (h & 1) === 0 ? 1 : -1;
      vec[bucket] += sign * 0.45;
    }
  }

  // L2 normalize
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    normSq += vec[i]! * vec[i]!;
  }
  if (normSq > 0) {
    const invNorm = 1 / Math.sqrt(normSq);
    for (let i = 0; i < vec.length; i++) {
      vec[i] = vec[i]! * invNorm;
    }
  }
  return vec;
}

export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
  }
  return Math.max(0, Math.min(1, Math.round(dot * 10_000) / 10_000));
}

function buildProjectionSearchDocument(proj: CatalogChannelProjectionRecord): {
  weightedTokens: string[];
  rawSearchText: string;
} {
  const weightedTokens: string[] = [];
  const nameTokens = tokenize(proj.productName);
  const slugTokens = tokenize(proj.productSlug);

  // Field boosts: productName (3x), productSlug (2x)
  for (let i = 0; i < 3; i++) weightedTokens.push(...nameTokens);
  for (let i = 0; i < 2; i++) weightedTokens.push(...slugTokens);

  const variantTexts: string[] = [];
  for (const v of proj.variantsSnapshot) {
    const skuToks = tokenize(v.sku);
    const vNameToks = tokenize(v.name);
    weightedTokens.push(...skuToks, ...skuToks, ...vNameToks);
    variantTexts.push(v.sku, v.name);
  }

  const attrTexts: string[] = [];
  for (const [k, vals] of Object.entries(proj.mergedAttributes)) {
    weightedTokens.push(...tokenize(k));
    for (const val of vals) {
      const s = String(val);
      weightedTokens.push(...tokenize(s), ...tokenize(s));
      attrTexts.push(`${k} ${s}`);
    }
  }

  const rawSearchText = [
    proj.productName,
    proj.productSlug,
    ...variantTexts,
    ...attrTexts,
  ].join(" ");

  return { weightedTokens, rawSearchText };
}

export function buildPgHybridSearchSqlPreview(query: HybridSearchQueryInput): string {
  const q = (query.queryText ?? "").replace(/'/g, "''");
  const k = query.rrfK ?? 60;
  const limit = query.limit ?? 20;
  return [
    `WITH lexical_bm25 AS (`,
    `  SELECT product_id, row_number() OVER (ORDER BY ts_rank_cd(to_tsvector('simple', product_name || ' ' || product_slug), websearch_to_tsquery('simple', '${q}')) DESC) AS bm25_rank`,
    `  FROM catalog_channel_projections`,
    `  WHERE channel_slug = '${query.channelSlug}'${query.inStockOnly ? " AND is_in_stock = true" : ""}`,
    `    AND to_tsvector('simple', product_name || ' ' || product_slug) @@ websearch_to_tsquery('simple', '${q}')`,
    `  LIMIT 100`,
    `), vector_semantic AS (`,
    `  SELECT product_id, row_number() OVER (ORDER BY embedding <=> $1::vector ASC) AS vec_rank`,
    `  FROM catalog_channel_projections`,
    `  WHERE channel_slug = '${query.channelSlug}'${query.inStockOnly ? " AND is_in_stock = true" : ""}`,
    `  LIMIT 100`,
    `)`,
    `SELECT ccp.product_slug, ccp.product_name,`,
    `       COALESCE(1.0 / (${k} + l.bm25_rank), 0) + COALESCE(1.0 / (${k} + v.vec_rank), 0) AS rrf_score`,
    `FROM lexical_bm25 l`,
    `FULL OUTER JOIN vector_semantic v ON v.product_id = l.product_id`,
    `JOIN catalog_channel_projections ccp ON ccp.channel_slug = '${query.channelSlug}' AND ccp.product_id = COALESCE(l.product_id, v.product_id)`,
    `ORDER BY rrf_score DESC LIMIT ${limit};`,
  ].join("\n");
}

interface IndexedProjectionEntry {
  readonly projection: CatalogChannelProjectionRecord;
  readonly termFreq: Map<string, number>;
  readonly docLength: number;
  readonly vector: Float64Array;
  readonly lowerText: string;
}

export class HybridCatalogSearchEngine {
  private entries: IndexedProjectionEntry[] = [];
  private docFreq = new Map<string, number>();
  private avgDocLength = 1;

  constructor(initialProjections: readonly CatalogChannelProjectionRecord[] = []) {
    this.reindex(initialProjections);
  }

  reindex(projections: readonly CatalogChannelProjectionRecord[]): void {
    const df = new Map<string, number>();
    const nextEntries: IndexedProjectionEntry[] = [];
    let totalLen = 0;

    for (const proj of projections) {
      const { weightedTokens, rawSearchText } = buildProjectionSearchDocument(proj);
      const tf = new Map<string, number>();
      for (const tok of weightedTokens) {
        tf.set(tok, (tf.get(tok) ?? 0) + 1);
      }
      for (const uniqueTok of tf.keys()) {
        df.set(uniqueTok, (df.get(uniqueTok) ?? 0) + 1);
      }
      const docLength = Math.max(1, weightedTokens.length);
      totalLen += docLength;

      nextEntries.push({
        projection: proj,
        termFreq: tf,
        docLength,
        vector: buildDeterministicSemanticVector(rawSearchText),
        lowerText: rawSearchText.toLowerCase(),
      });
    }

    this.entries = nextEntries;
    this.docFreq = df;
    this.avgDocLength = nextEntries.length > 0 ? totalLen / nextEntries.length : 1;
  }

  search(query: HybridSearchQueryInput): HybridSearchReport {
    const t0 = process.hrtime.bigint();
    const rrfK = query.rrfK ?? 60;
    const minVectorSimilarity = query.minVectorSimilarity ?? 0.14;
    const limit = query.limit ?? 50;
    const trimmedQuery = (query.queryText ?? "").trim();

    // Step 1: Hard relational & JSONB @> filters
    const filtered = this.entries.filter((entry) => {
      const p = entry.projection;
      if (p.channelSlug !== query.channelSlug) return false;
      if (query.inStockOnly && !p.isInStock) return false;
      if (
        query.maxPriceAmount !== undefined &&
        p.minEffectivePrice > query.maxPriceAmount
      ) {
        return false;
      }
      if (query.attributeFilters) {
        for (const [attrSlug, expectedVal] of Object.entries(query.attributeFilters)) {
          const facetValues = p.mergedAttributes[attrSlug];
          if (!facetValues || !facetValues.includes(expectedVal)) {
            return false;
          }
        }
      }
      return true;
    });

    // If no queryText is supplied, return relational + JSONB filtered list directly
    if (!trimmedQuery) {
      const hits: HybridSearchHit[] = filtered.slice(0, limit).map((e) => ({
        projection: e.projection,
        rrfScore: 0,
        bm25Score: 0,
        bm25Rank: null,
        vectorSimilarity: 0,
        vectorRank: null,
        matchedBy: "FILTER_ONLY",
      }));
      const latencyUs =
        Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 100) / 100;
      return {
        channelSlug: query.channelSlug,
        queryText: "",
        rrfK,
        candidatePoolCount: filtered.length,
        bm25MatchedCount: 0,
        vectorMatchedCount: 0,
        totalReturned: hits.length,
        latencyUs,
        pgHybridRrfSql: buildPgHybridSearchSqlPreview(query),
        hits,
      };
    }

    const queryTokens = Array.from(new Set(tokenize(trimmedQuery)));
    const queryLower = trimmedQuery.toLowerCase();
    const queryVector = buildDeterministicSemanticVector(trimmedQuery);
    const totalCorpusDocs = Math.max(1, this.entries.length);
    const k1 = 1.2;
    const b = 0.75;

    // Step 2: Score BM25 & Vector Similarity across filtered candidates
    const scored = filtered.map((entry) => {
      let bm25 = 0;
      for (const term of queryTokens) {
        const tf = entry.termFreq.get(term) ?? 0;
        if (tf === 0) continue;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (totalCorpusDocs - df + 0.5) / (df + 0.5));
        const normFactor =
          tf + k1 * (1 - b + b * (entry.docLength / this.avgDocLength));
        bm25 += idf * ((tf * (k1 + 1)) / normFactor);
      }
      if (
        entry.projection.productSlug.toLowerCase().includes(queryLower) ||
        entry.projection.productName.toLowerCase().includes(queryLower) ||
        entry.lowerText.includes(queryLower)
      ) {
        bm25 += 1.5;
      }
      bm25 = Math.round(bm25 * 10_000) / 10_000;

      const vectorSimilarity = cosineSimilarity(queryVector, entry.vector);

      return {
        entry,
        bm25Score: bm25,
        vectorSimilarity,
      };
    });

    // Step 3: Independent BM25 Rank & Vector Rank
    const bm25Ranked = scored
      .filter((s) => s.bm25Score > 0)
      .sort(
        (a, b) =>
          b.bm25Score - a.bm25Score ||
          a.entry.projection.productSlug.localeCompare(b.entry.projection.productSlug)
      );
    const bm25RankMap = new Map<string, number>();
    bm25Ranked.forEach((s, idx) =>
      bm25RankMap.set(s.entry.projection.productId, idx + 1)
    );

    const vectorRanked = scored
      .filter((s) => s.vectorSimilarity >= minVectorSimilarity)
      .sort(
        (a, b) =>
          b.vectorSimilarity - a.vectorSimilarity ||
          a.entry.projection.productSlug.localeCompare(b.entry.projection.productSlug)
      );
    const vectorRankMap = new Map<string, number>();
    vectorRanked.forEach((s, idx) =>
      vectorRankMap.set(s.entry.projection.productId, idx + 1)
    );

    // Step 4: Reciprocal Rank Fusion (RRF: 1/(k + rank_bm25) + 1/(k + rank_vec))
    const hits: HybridSearchHit[] = [];
    for (const item of scored) {
      const pid = item.entry.projection.productId;
      const bm25Rank = bm25RankMap.get(pid) ?? null;
      const vectorRank = vectorRankMap.get(pid) ?? null;
      if (bm25Rank === null && vectorRank === null) continue;

      const rrfScoreRaw =
        (bm25Rank !== null ? 1 / (rrfK + bm25Rank) : 0) +
        (vectorRank !== null ? 1 / (rrfK + vectorRank) : 0);
      const rrfScore = Math.round(rrfScoreRaw * 1_000_000) / 1_000_000;

      const matchedBy: HybridMatchOrigin =
        bm25Rank !== null && vectorRank !== null
          ? "HYBRID_BOTH"
          : bm25Rank !== null
          ? "LEXICAL_BM25"
          : "VECTOR_SEMANTIC";

      hits.push({
        projection: item.entry.projection,
        rrfScore,
        bm25Score: item.bm25Score,
        bm25Rank,
        vectorSimilarity: item.vectorSimilarity,
        vectorRank,
        matchedBy,
      });
    }

    hits.sort(
      (a, b) =>
        b.rrfScore - a.rrfScore ||
        b.vectorSimilarity - a.vectorSimilarity ||
        b.bm25Score - a.bm25Score ||
        a.projection.productSlug.localeCompare(b.projection.productSlug)
    );

    const limitedHits = hits.slice(0, limit);
    const latencyUs =
      Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 100) / 100;

    return {
      channelSlug: query.channelSlug,
      queryText: trimmedQuery,
      rrfK,
      candidatePoolCount: filtered.length,
      bm25MatchedCount: bm25Ranked.length,
      vectorMatchedCount: vectorRanked.length,
      totalReturned: limitedHits.length,
      latencyUs,
      pgHybridRrfSql: buildPgHybridSearchSqlPreview(query),
      hits: limitedHits,
    };
  }
}
