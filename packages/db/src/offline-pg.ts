/**
 * In-Process PostgreSQL Test Double (`packages/db/src/offline-pg.ts`).
 *
 * Implements `PgPoolLike` with ZERO `node:sqlite` and ZERO TCP sockets so the entire
 * TypeScript test suite runs 100% offline-hermetically inside restricted sandboxes while
 * executing real PostgreSQL SQL:
 * - DDL parsing (`CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, `DO $$ ... END $$;`)
 * - `CHECK`, `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `FOREIGN KEY` (`ON DELETE CASCADE|RESTRICT`)
 * - Transactions (`BEGIN`/`COMMIT`/`ROLLBACK`), nested `SAVEPOINT`, and row-level locks
 *   (`SELECT ... FOR UPDATE [SKIP LOCKED]`)
 * - `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING`, `UPDATE ... RETURNING`, `DELETE ... RETURNING`
 * - Keyset tuple comparisons `(created_at, id) < (...)`, JSONB `@>` containment, `ILIKE`, aggregates
 */

import { randomUUID } from "node:crypto";
import { interpolatePgSql, type PgQueryResult } from "./pg-wire-driver.ts";
import type { PgPoolLike, PgTxClient } from "./pg-pool.ts";

const PG_JSON_NULL = Symbol("PG_JSON_NULL");

type PgVal =
  | null
  | typeof PG_JSON_NULL
  | string
  | number
  | bigint
  | boolean
  | Date
  | Record<string, unknown>
  | unknown[];

interface ColumnDef {
  name: string;
  type: string;
  notNull: boolean;
  defaultExpr: Expr | null;
  checks: { name?: string; expr: Expr }[];
}

interface ForeignKeyDef {
  name: string;
  columns: readonly string[];
  refTable: string;
  refColumns: readonly string[];
  onDelete: "CASCADE" | "RESTRICT";
}

interface TableDef {
  name: string;
  columns: ColumnDef[];
  primaryKey: readonly string[];
  uniqueConstraints: { name: string; columns: readonly string[] }[];
  tableChecks: { name: string; expr: Expr }[];
  foreignKeys: ForeignKeyDef[];
  indexes: { name: string; definition: string }[];
  rows: InternalRow[];
}

interface InternalRow {
  rowId: string;
  data: Record<string, PgVal>;
}

interface UndoEntry {
  kind: "insert" | "update" | "delete";
  tableName: string;
  rowId: string;
  previousData?: Record<string, PgVal>;
  previousIndex?: number;
}

interface TxContext {
  readonly txId: string;
  depth: number;
  savepointSeq: number;
  readonly undoLog: UndoEntry[];
  readonly savepoints: Map<string, number>;
  readonly heldLocks: Set<string>;
}

// ============================================================================
// Tokenization & SQL Splitting
// ============================================================================

type TokKind = "word" | "num" | "str" | "ident" | "op" | "punct" | "param";
interface Tok {
  kind: TokKind;
  value: string;
  upper: string;
}

function matchDollarTag(sql: string, pos: number): string | null {
  if (sql[pos] !== "$") return null;
  let i = pos + 1;
  if (sql[i] === "$") return "$$";
  if (i >= sql.length || !/[A-Za-z_]/.test(sql[i]!)) return null;
  i++;
  while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i]!)) i++;
  return sql[i] === "$" ? sql.slice(pos, i + 1) : null;
}

export function splitPgStatements(sql: string): string[] {
  const stmts: string[] = [];
  let cur = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? "";

    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i + 2);
      if (nl === -1) break;
      cur += " ";
      i = nl + 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      cur += " ";
      continue;
    }

    if ((ch === "E" || ch === "e") && next === "'") {
      const start = i;
      i += 2;
      while (i < len) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      cur += sql.slice(start, i);
      continue;
    }

    if (ch === "'") {
      const start = i;
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      cur += sql.slice(start, i);
      continue;
    }

    if (ch === '"') {
      const start = i;
      i++;
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      cur += sql.slice(start, i);
      continue;
    }

    if (ch === "$") {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        const endIdx = sql.indexOf(tag, i + tag.length);
        if (endIdx === -1) {
          cur += sql.slice(i);
          break;
        }
        cur += sql.slice(i, endIdx + tag.length);
        i = endIdx + tag.length;
        continue;
      }
    }

    if (ch === ";") {
      const trimmed = cur.trim();
      if (trimmed.length > 0) stmts.push(trimmed);
      cur = "";
      i++;
      continue;
    }

    cur += ch;
    i++;
  }

  const tail = cur.trim();
  if (tail.length > 0) stmts.push(tail);
  return stmts;
}

function tokenizeSql(sql: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? "";

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i + 2);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    if ((ch === "E" || ch === "e") && next === "'") {
      i += 2;
      let val = "";
      while (i < len) {
        if (sql[i] === "\\") {
          const esc = sql[i + 1] ?? "";
          val += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc;
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            val += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        val += sql[i]!;
        i++;
      }
      toks.push({ kind: "str", value: val, upper: val });
      continue;
    }

    if (ch === "'") {
      i++;
      let val = "";
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            val += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        val += sql[i]!;
        i++;
      }
      toks.push({ kind: "str", value: val, upper: val });
      continue;
    }

    if (ch === '"') {
      i++;
      let val = "";
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            val += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        val += sql[i]!;
        i++;
      }
      toks.push({ kind: "ident", value: val, upper: val.toUpperCase() });
      continue;
    }

    if (ch === "$") {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        const endIdx = sql.indexOf(tag, i + tag.length);
        if (endIdx === -1) {
          const val = sql.slice(i + tag.length);
          toks.push({ kind: "str", value: val, upper: val });
          break;
        }
        const val = sql.slice(i + tag.length, endIdx);
        toks.push({ kind: "str", value: val, upper: val });
        i = endIdx + tag.length;
        continue;
      }
      if (next >= "1" && next <= "9") {
        let j = i + 1;
        while (j < len && /[0-9]/.test(sql[j]!)) j++;
        const v = sql.slice(i, j);
        toks.push({ kind: "param", value: v, upper: v });
        i = j;
        continue;
      }
    }

    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[0-9.]/.test(sql[j]!)) j++;
      const v = sql.slice(i, j);
      toks.push({ kind: "num", value: v, upper: v });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      const v = sql.slice(i, j);
      toks.push({ kind: "word", value: v, upper: v.toUpperCase() });
      i = j;
      continue;
    }

    const two = sql.slice(i, i + 2);
    if (two === "->>") {
      toks.push({ kind: "op", value: "->>", upper: "->>" });
      i += 2;
      continue;
    }
    if (sql.slice(i, i + 3) === "->>") {
      toks.push({ kind: "op", value: "->>", upper: "->>" });
      i += 3;
      continue;
    }
    if (["->", "::", "||", "@>", "<@", "!=", "<>", "<=", ">="].includes(two)) {
      toks.push({ kind: "op", value: two, upper: two });
      i += 2;
      continue;
    }

    if ("(),.;[]".includes(ch)) {
      toks.push({ kind: "punct", value: ch, upper: ch });
      i++;
      continue;
    }

    if ("=<>+-*/%".includes(ch)) {
      toks.push({ kind: "op", value: ch, upper: ch });
      i++;
      continue;
    }

    i++;
  }
  return toks;
}

// ============================================================================
// AST Expressions
// ============================================================================

type Expr =
  | { kind: "lit"; value: PgVal }
  | { kind: "col"; table?: string; name: string }
  | { kind: "tuple"; items: Expr[] }
  | { kind: "cast"; expr: Expr; typeName: string }
  | { kind: "unary"; op: "NOT" | "-" | "+"; expr: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "is_null"; expr: Expr; negated: boolean }
  | { kind: "between"; expr: Expr; low: Expr; high: Expr; negated: boolean }
  | { kind: "in"; expr: Expr; list: Expr[]; negated: boolean }
  | { kind: "in_subquery"; expr: Expr; query: SelectAst; negated: boolean }
  | { kind: "any"; expr: Expr; arrayExpr: Expr }
  | { kind: "call"; name: string; args: Expr[]; star?: boolean; filter?: Expr }
  | { kind: "case"; base?: Expr; whens: { cond: Expr; then: Expr }[]; elseExpr?: Expr }
  | { kind: "exists"; query: SelectAst; negated?: boolean }
  | { kind: "subquery"; query: SelectAst };

interface SelectItem {
  expr: Expr;
  alias?: string;
  star?: boolean;
  starTable?: string;
}

interface JoinClause {
  type: "INNER" | "LEFT";
  table: string;
  alias: string;
  on?: Expr;
}

interface OrderItem {
  expr: Expr;
  dir: "ASC" | "DESC";
}

interface SelectAst {
  kind: "SELECT";
  items: SelectItem[];
  fromTable?: string;
  fromAlias?: string;
  joins: JoinClause[];
  where?: Expr;
  groupBy: Expr[];
  orderBy: OrderItem[];
  limit?: number;
  offset?: number;
  forUpdate?: { ofAlias?: string; skipLocked: boolean };
}

class TokenCursor {
  readonly toks: readonly Tok[];
  pos = 0;

  constructor(toks: readonly Tok[]) {
    this.toks = toks;
  }

  peek(offset = 0): Tok | undefined {
    return this.toks[this.pos + offset];
  }

  next(): Tok | undefined {
    return this.toks[this.pos++];
  }

  eof(): boolean {
    return this.pos >= this.toks.length;
  }

  isUpper(upper: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t !== undefined && (t.kind === "word" || t.kind === "op" || t.kind === "punct") && t.upper === upper;
  }

  matchUpper(upper: string): boolean {
    if (this.isUpper(upper)) {
      this.pos++;
      return true;
    }
    return false;
  }

  expectUpper(upper: string): Tok {
    const t = this.next();
    if (!t || t.upper !== upper) {
      throw new Error(`PostgreSQL Syntax Error: expected '${upper}', got '${t?.value ?? "EOF"}'`);
    }
    return t;
  }

  expectIdent(): string {
    const t = this.next();
    if (!t || (t.kind !== "word" && t.kind !== "ident")) {
      throw new Error(`PostgreSQL Syntax Error: expected identifier, got '${t?.value ?? "EOF"}'`);
    }
    return t.value.toLowerCase();
  }
}

function parseTypeName(cur: TokenCursor): string {
  const parts: string[] = [];
  while (!cur.eof()) {
    const t = cur.peek()!;
    if (t.kind === "word") {
      parts.push(t.value.toLowerCase());
      cur.next();
      if (cur.isUpper("(")) {
        cur.next();
        let depth = 1;
        while (!cur.eof() && depth > 0) {
          const inner = cur.next()!;
          if (inner.value === "(") depth++;
          else if (inner.value === ")") depth--;
        }
      }
      if (cur.isUpper("[")) {
        cur.next();
        cur.matchUpper("]");
        parts.push("[]");
      }
      if (
        cur.isUpper("PRECISION") ||
        cur.isUpper("VARYING") ||
        cur.isUpper("ZONE") ||
        cur.isUpper("WITH") ||
        cur.isUpper("TIME") ||
        cur.isUpper("WITHOUT")
      ) {
        continue;
      }
      break;
    }
    break;
  }
  return parts.join(" ");
}

function parseExpr(cur: TokenCursor): Expr {
  return parseOr(cur);
}

function parseOr(cur: TokenCursor): Expr {
  let left = parseAnd(cur);
  while (cur.matchUpper("OR")) {
    const right = parseAnd(cur);
    left = { kind: "binary", op: "OR", left, right };
  }
  return left;
}

function parseAnd(cur: TokenCursor): Expr {
  let left = parseNot(cur);
  while (cur.matchUpper("AND")) {
    const right = parseNot(cur);
    left = { kind: "binary", op: "AND", left, right };
  }
  return left;
}

function parseNot(cur: TokenCursor): Expr {
  if (cur.matchUpper("NOT")) {
    if (cur.matchUpper("EXISTS")) {
      cur.expectUpper("(");
      const q = parseSelect(cur);
      cur.expectUpper(")");
      return { kind: "exists", query: q, negated: true };
    }
    return { kind: "unary", op: "NOT", expr: parseNot(cur) };
  }
  return parseComparison(cur);
}

function parseComparison(cur: TokenCursor): Expr {
  let left = parseConcat(cur);

  if (cur.matchUpper("IS")) {
    const negated = cur.matchUpper("NOT");
    cur.expectUpper("NULL");
    return { kind: "is_null", expr: left, negated };
  }

  let negated = false;
  if (
    cur.isUpper("NOT") &&
    (cur.isUpper("IN", 1) ||
      cur.isUpper("LIKE", 1) ||
      cur.isUpper("ILIKE", 1) ||
      cur.isUpper("BETWEEN", 1))
  ) {
    cur.next();
    negated = true;
  }

  if (cur.matchUpper("BETWEEN")) {
    const low = parseConcat(cur);
    cur.expectUpper("AND");
    const high = parseConcat(cur);
    return { kind: "between", expr: left, low, high, negated };
  }

  if (cur.matchUpper("IN")) {
    cur.expectUpper("(");
    if (cur.isUpper("SELECT")) {
      const query = parseSelect(cur);
      cur.expectUpper(")");
      return { kind: "in_subquery", expr: left, query, negated };
    }
    const list: Expr[] = [];
    if (!cur.isUpper(")")) {
      do {
        list.push(parseExpr(cur));
      } while (cur.matchUpper(","));
    }
    cur.expectUpper(")");
    return { kind: "in", expr: left, list, negated };
  }

  if (cur.matchUpper("LIKE") || cur.matchUpper("ILIKE")) {
    const op = cur.toks[cur.pos - 1]!.upper;
    const right = parseConcat(cur);
    const node: Expr = { kind: "binary", op, left, right };
    return negated ? { kind: "unary", op: "NOT", expr: node } : node;
  }

  const t = cur.peek();
  if (
    t &&
    t.kind === "op" &&
    ["=", "!=", "<>", "<", "<=", ">", ">=", "@>", "<@"].includes(t.value)
  ) {
    cur.next();
    if (t.value === "=" && cur.matchUpper("ANY")) {
      cur.expectUpper("(");
      const arrayExpr = parseExpr(cur);
      cur.expectUpper(")");
      return { kind: "any", expr: left, arrayExpr };
    }
    const right = parseConcat(cur);
    return { kind: "binary", op: t.value === "<>" ? "!=" : t.value, left, right };
  }

  return left;
}

function parseConcat(cur: TokenCursor): Expr {
  let left = parseAdditive(cur);
  while (cur.isUpper("||") || cur.isUpper("->") || cur.isUpper("->>")) {
    const op = cur.next()!.value;
    const right = parseAdditive(cur);
    left = { kind: "binary", op, left, right };
  }
  return left;
}

function parseAdditive(cur: TokenCursor): Expr {
  let left = parseMultiplicative(cur);
  while (cur.isUpper("+") || cur.isUpper("-")) {
    const op = cur.next()!.value;
    const right = parseMultiplicative(cur);
    left = { kind: "binary", op, left, right };
  }
  return left;
}

function parseMultiplicative(cur: TokenCursor): Expr {
  let left = parseCast(cur);
  while (cur.isUpper("*") || cur.isUpper("/") || cur.isUpper("%")) {
    const op = cur.next()!.value;
    const right = parseCast(cur);
    left = { kind: "binary", op, left, right };
  }
  return left;
}

function parseCast(cur: TokenCursor): Expr {
  let expr = parsePrimary(cur);
  while (cur.matchUpper("::")) {
    const typeName = parseTypeName(cur);
    expr = { kind: "cast", expr, typeName };
  }
  return expr;
}

function parsePrimary(cur: TokenCursor): Expr {
  if (cur.matchUpper("-")) {
    return { kind: "unary", op: "-", expr: parseCast(cur) };
  }
  if (cur.matchUpper("+")) {
    return { kind: "unary", op: "+", expr: parseCast(cur) };
  }

  if (cur.matchUpper("EXISTS")) {
    cur.expectUpper("(");
    const q = parseSelect(cur);
    cur.expectUpper(")");
    return { kind: "exists", query: q };
  }

  if (cur.matchUpper("CASE")) {
    let base: Expr | undefined;
    if (!cur.isUpper("WHEN")) {
      base = parseExpr(cur);
    }
    const whens: { cond: Expr; then: Expr }[] = [];
    while (cur.matchUpper("WHEN")) {
      const cond = parseExpr(cur);
      cur.expectUpper("THEN");
      const then = parseExpr(cur);
      whens.push({ cond, then });
    }
    let elseExpr: Expr | undefined;
    if (cur.matchUpper("ELSE")) {
      elseExpr = parseExpr(cur);
    }
    cur.expectUpper("END");
    return { kind: "case", base, whens, elseExpr };
  }

  if (cur.matchUpper("(")) {
    if (cur.isUpper("SELECT")) {
      const query = parseSelect(cur);
      cur.expectUpper(")");
      return { kind: "subquery", query };
    }
    const first = parseExpr(cur);
    if (cur.matchUpper(",")) {
      const items = [first];
      do {
        items.push(parseExpr(cur));
      } while (cur.matchUpper(","));
      cur.expectUpper(")");
      return { kind: "tuple", items };
    }
    cur.expectUpper(")");
    return first;
  }

  const tok = cur.next();
  if (!tok) throw new Error("PostgreSQL Syntax Error: unexpected end of expression");

  if (tok.kind === "str") return { kind: "lit", value: tok.value };
  if (tok.kind === "num") {
    return {
      kind: "lit",
      value: tok.value.includes(".") ? Number(tok.value) : Number(tok.value),
    };
  }
  if (tok.kind === "word") {
    if (tok.upper === "NULL") return { kind: "lit", value: null };
    if (tok.upper === "TRUE") return { kind: "lit", value: true };
    if (tok.upper === "FALSE") return { kind: "lit", value: false };
    if (tok.upper === "CURRENT_TIMESTAMP" && !cur.isUpper("(")) {
      return { kind: "call", name: "now", args: [] };
    }
    if (tok.upper === "CURRENT_DATABASE" && !cur.isUpper("(")) {
      return { kind: "call", name: "current_database", args: [] };
    }
    if (tok.upper === "ARRAY" && cur.isUpper("[")) {
      cur.next();
      const elems: Expr[] = [];
      if (!cur.isUpper("]")) {
        do {
          elems.push(parseExpr(cur));
        } while (cur.matchUpper(","));
      }
      cur.expectUpper("]");
      return { kind: "call", name: "__array__", args: elems };
    }

    if (cur.matchUpper("(")) {
      const args: Expr[] = [];
      let star = false;
      if (!cur.isUpper(")")) {
        if (cur.matchUpper("*")) {
          star = true;
        } else {
          do {
            args.push(parseExpr(cur));
          } while (cur.matchUpper(","));
        }
      }
      cur.expectUpper(")");
      let filter: Expr | undefined;
      if (cur.matchUpper("FILTER")) {
        cur.expectUpper("(");
        cur.expectUpper("WHERE");
        filter = parseExpr(cur);
        cur.expectUpper(")");
      }
      return { kind: "call", name: tok.value.toLowerCase(), args, star, filter };
    }

    if (cur.matchUpper(".")) {
      if (cur.matchUpper("*")) {
        return { kind: "col", table: tok.value.toLowerCase(), name: "*" };
      }
      const col = cur.expectIdent();
      return { kind: "col", table: tok.value.toLowerCase(), name: col };
    }

    return { kind: "col", name: tok.value.toLowerCase() };
  }

  if (tok.kind === "ident") {
    if (cur.matchUpper(".")) {
      const col = cur.expectIdent();
      return { kind: "col", table: tok.value.toLowerCase(), name: col };
    }
    return { kind: "col", name: tok.value.toLowerCase() };
  }

  throw new Error(`PostgreSQL Syntax Error: unexpected token '${tok.value}'`);
}

function parseTableRef(cur: TokenCursor): { table: string; alias: string } {
  let table = cur.expectIdent();
  if (cur.matchUpper(".")) {
    const second = cur.expectIdent();
    table = `${table}.${second}`;
  }
  let alias = table;
  if (cur.matchUpper("AS")) {
    alias = cur.expectIdent();
  } else {
    const next = cur.peek();
    if (
      next &&
      (next.kind === "word" || next.kind === "ident") &&
      ![
        "WHERE",
        "JOIN",
        "INNER",
        "LEFT",
        "RIGHT",
        "ON",
        "GROUP",
        "ORDER",
        "LIMIT",
        "OFFSET",
        "FOR",
        "SET",
        "VALUES",
        "RETURNING",
      ].includes(next.upper)
    ) {
      cur.next();
      alias = next.value.toLowerCase();
    }
  }
  return { table, alias };
}

function parseSelect(cur: TokenCursor): SelectAst {
  cur.expectUpper("SELECT");
  const items: SelectItem[] = [];
  do {
    if (cur.matchUpper("*")) {
      items.push({ expr: { kind: "col", name: "*" }, star: true });
    } else {
      const expr = parseExpr(cur);
      let alias: string | undefined;
      if (cur.matchUpper("AS")) {
        alias = cur.expectIdent();
      } else {
        const t = cur.peek();
        if (
          t &&
          (t.kind === "word" || t.kind === "ident") &&
          !["FROM", "WHERE", "GROUP", "ORDER", "LIMIT", "OFFSET", "FOR"].includes(t.upper)
        ) {
          cur.next();
          alias = t.value.toLowerCase();
        }
      }
      if (expr.kind === "col" && expr.name === "*") {
        items.push({ expr, star: true, starTable: expr.table });
      } else {
        items.push({ expr, alias });
      }
    }
  } while (cur.matchUpper(","));

  let fromTable: string | undefined;
  let fromAlias: string | undefined;
  const joins: JoinClause[] = [];

  if (cur.matchUpper("FROM")) {
    const ref = parseTableRef(cur);
    fromTable = ref.table;
    fromAlias = ref.alias;

    while (
      cur.isUpper("JOIN") ||
      cur.isUpper("INNER") ||
      cur.isUpper("LEFT") ||
      cur.isUpper("CROSS")
    ) {
      let jType: "INNER" | "LEFT" = "INNER";
      if (cur.matchUpper("LEFT")) {
        cur.matchUpper("OUTER");
        jType = "LEFT";
      } else if (cur.matchUpper("INNER")) {
        // inner
      } else if (cur.matchUpper("CROSS")) {
        cur.expectUpper("JOIN");
        const jRef = parseTableRef(cur);
        joins.push({ type: "INNER", table: jRef.table, alias: jRef.alias });
        continue;
      }
      cur.expectUpper("JOIN");
      const jRef = parseTableRef(cur);
      let on: Expr | undefined;
      if (cur.matchUpper("ON")) {
        on = parseExpr(cur);
      }
      joins.push({ type: jType, table: jRef.table, alias: jRef.alias, on });
    }
  }

  let where: Expr | undefined;
  if (cur.matchUpper("WHERE")) {
    where = parseExpr(cur);
  }

  const groupBy: Expr[] = [];
  if (cur.matchUpper("GROUP")) {
    cur.expectUpper("BY");
    do {
      groupBy.push(parseExpr(cur));
    } while (cur.matchUpper(","));
  }

  const orderBy: OrderItem[] = [];
  if (cur.matchUpper("ORDER")) {
    cur.expectUpper("BY");
    do {
      const expr = parseExpr(cur);
      let dir: "ASC" | "DESC" = "ASC";
      if (cur.matchUpper("DESC")) dir = "DESC";
      else cur.matchUpper("ASC");
      if (cur.matchUpper("NULLS")) {
        cur.next(); // FIRST | LAST
      }
      orderBy.push({ expr, dir });
    } while (cur.matchUpper(","));
  }

  let limit: number | undefined;
  if (cur.matchUpper("LIMIT")) {
    const t = cur.next();
    limit = Number(t?.value ?? 0);
  }

  let offset: number | undefined;
  if (cur.matchUpper("OFFSET")) {
    const t = cur.next();
    offset = Number(t?.value ?? 0);
  }

  let forUpdate: { ofAlias?: string; skipLocked: boolean } | undefined;
  if (cur.matchUpper("FOR")) {
    cur.expectUpper("UPDATE");
    let ofAlias: string | undefined;
    if (cur.matchUpper("OF")) {
      ofAlias = cur.expectIdent();
    }
    let skipLocked = false;
    if (cur.matchUpper("SKIP")) {
      cur.expectUpper("LOCKED");
      skipLocked = true;
    }
    forUpdate = { ofAlias, skipLocked };
  }

  return {
    kind: "SELECT",
    items,
    fromTable,
    fromAlias,
    joins,
    where,
    groupBy,
    orderBy,
    limit,
    offset,
    forUpdate,
  };
}

// ============================================================================
// OfflinePgPool
// ============================================================================

export class OfflinePgPool implements PgPoolLike {
  private readonly tables = new Map<string, TableDef>();
  private readonly rowLocks = new Map<
    string,
    { ownerTxId: string; waiters: (() => void)[] }
  >();
  private opQueue: Promise<void> = Promise.resolve();
  private txSeq = 0;
  private deadlocks = 0;

  private serializeNonTx<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(fn, fn);
    this.opQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async query<TRow = Record<string, string | null>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PgQueryResult<TRow>> {
    return this.serializeNonTx(() => this.execQueryInternal<TRow>(sql, params, null));
  }

  async withTransaction<T>(fn: (tx: PgTxClient) => Promise<T>): Promise<T> {
    const txCtx: TxContext = {
      txId: `tx_${++this.txSeq}`,
      depth: 1,
      savepointSeq: 0,
      undoLog: [],
      savepoints: new Map(),
      heldLocks: new Set(),
    };

    const runWithClient = async (ctx: TxContext): Promise<T> => {
      const txClient: PgTxClient = {
        query: <TRow = Record<string, string | null>>(
          sql: string,
          params: readonly unknown[] = []
        ) => this.execQueryInternal<TRow>(sql, params, ctx),
        withTransaction: async <TInner>(
          innerFn: (innerTx: PgTxClient) => Promise<TInner>
        ) => {
          const sp = `sp_${ctx.depth}_${++ctx.savepointSeq}`;
          ctx.savepoints.set(sp, ctx.undoLog.length);
          ctx.depth++;
          try {
            const res = await innerFn(txClient);
            ctx.savepoints.delete(sp);
            return res;
          } catch (err) {
            const mark = ctx.savepoints.get(sp);
            if (mark !== undefined) {
              this.rollbackUndoTo(ctx, mark);
              ctx.savepoints.delete(sp);
            }
            throw err;
          } finally {
            ctx.depth--;
          }
        },
      };

      try {
        const res = await fn(txClient);
        this.releaseLocks(ctx);
        return res;
      } catch (err) {
        this.rollbackUndoTo(ctx, 0);
        this.releaseLocks(ctx);
        throw err;
      }
    };

    return runWithClient(txCtx);
  }

  async close(): Promise<void> {
    this.rowLocks.clear();
  }

  private rollbackUndoTo(ctx: TxContext, targetIdx: number): void {
    while (ctx.undoLog.length > targetIdx) {
      const entry = ctx.undoLog.pop()!;
      const tbl = this.tables.get(entry.tableName);
      if (!tbl) continue;
      if (entry.kind === "insert") {
        const idx = tbl.rows.findIndex((r) => r.rowId === entry.rowId);
        if (idx !== -1) tbl.rows.splice(idx, 1);
      } else if (entry.kind === "update" && entry.previousData) {
        const row = tbl.rows.find((r) => r.rowId === entry.rowId);
        if (row) row.data = { ...entry.previousData };
      } else if (entry.kind === "delete" && entry.previousData) {
        const restored: InternalRow = {
          rowId: entry.rowId,
          data: { ...entry.previousData },
        };
        const idx = Math.min(entry.previousIndex ?? tbl.rows.length, tbl.rows.length);
        tbl.rows.splice(idx, 0, restored);
      }
    }
  }

  private tryAcquireRowLockSync(lockKey: string, ctx: TxContext | null): boolean {
    if (!ctx) return true;
    const existing = this.rowLocks.get(lockKey);
    if (!existing || existing.ownerTxId === ctx.txId) {
      if (!existing) {
        this.rowLocks.set(lockKey, { ownerTxId: ctx.txId, waiters: [] });
        ctx.heldLocks.add(lockKey);
      }
      return true;
    }
    return false;
  }

  private async acquireRowLock(
    lockKey: string,
    ctx: TxContext | null,
    skipLocked: boolean
  ): Promise<{ acquired: boolean; waited: boolean }> {
    if (this.tryAcquireRowLockSync(lockKey, ctx)) {
      return { acquired: true, waited: false };
    }
    if (skipLocked) {
      return { acquired: false, waited: false };
    }
    while (true) {
      const existing = this.rowLocks.get(lockKey);
      if (!existing || existing.ownerTxId === ctx?.txId) {
        this.tryAcquireRowLockSync(lockKey, ctx);
        return { acquired: true, waited: true };
      }
      await new Promise<void>((resolve) => {
        existing.waiters.push(resolve);
      });
    }
  }

  private releaseLocks(ctx: TxContext): void {
    for (const key of ctx.heldLocks) {
      const entry = this.rowLocks.get(key);
      if (entry && entry.ownerTxId === ctx.txId) {
        this.rowLocks.delete(key);
        for (const w of entry.waiters) w();
      }
    }
    ctx.heldLocks.clear();
  }

  private async execQueryInternal<TRow>(
    sql: string,
    params: readonly unknown[],
    ctx: TxContext | null
  ): Promise<PgQueryResult<TRow>> {
    const finalSql = params.length > 0 ? interpolatePgSql(sql, params) : sql;
    const stmts = splitPgStatements(finalSql);
    let lastResult: PgQueryResult<TRow> = { commandTag: "", rows: [] };

    for (const stmt of stmts) {
      lastResult = await this.execSingleStmt<TRow>(stmt, ctx);
    }
    return lastResult;
  }

  private async execSingleStmt<TRow>(
    stmt: string,
    ctx: TxContext | null
  ): Promise<PgQueryResult<TRow>> {
    const toks = tokenizeSql(stmt);
    if (toks.length === 0) return { commandTag: "", rows: [] };
    const head = toks[0]!.upper;

    if (head === "BEGIN" || head === "COMMIT" || head === "ROLLBACK" || head === "SET") {
      if (head === "SAVEPOINT" || head === "RELEASE") {
        return { commandTag: head, rows: [] };
      }
      if (head === "ROLLBACK" && toks[1]?.upper === "TO" && ctx) {
        const spName = toks[2]?.upper === "SAVEPOINT" ? toks[3]?.value : toks[2]?.value;
        if (spName) {
          const mark = ctx.savepoints.get(spName.toLowerCase());
          if (mark !== undefined) this.rollbackUndoTo(ctx, mark);
        }
        return { commandTag: "ROLLBACK", rows: [] };
      }
      return { commandTag: head, rows: [] };
    }

    if (head === "SAVEPOINT" && ctx && toks[1]) {
      ctx.savepoints.set(toks[1].value.toLowerCase(), ctx.undoLog.length);
      return { commandTag: "SAVEPOINT", rows: [] };
    }

    if (head === "RELEASE" && ctx) {
      const spName = toks[1]?.upper === "SAVEPOINT" ? toks[2]?.value : toks[1]?.value;
      if (spName) ctx.savepoints.delete(spName.toLowerCase());
      return { commandTag: "RELEASE", rows: [] };
    }

    if (head === "DO") {
      await this.execDoBlock(toks, ctx);
      return { commandTag: "DO", rows: [] };
    }

    if (head === "CREATE") {
      if (toks[1]?.upper === "TABLE") {
        this.execCreateTable(toks);
        return { commandTag: "CREATE TABLE", rows: [] };
      }
      if (toks[1]?.upper === "INDEX" || (toks[1]?.upper === "UNIQUE" && toks[2]?.upper === "INDEX")) {
        this.execCreateIndex(stmt, toks);
        return { commandTag: "CREATE INDEX", rows: [] };
      }
    }

    if (head === "ALTER" && toks[1]?.upper === "TABLE") {
      await this.execAlterTable(toks, ctx);
      return { commandTag: "ALTER TABLE", rows: [] };
    }

    if (head === "SELECT") {
      const cur = new TokenCursor(toks);
      const ast = parseSelect(cur);
      return await this.execSelect<TRow>(ast, ctx, {});
    }

    if (head === "INSERT") {
      return await this.execInsert<TRow>(toks, ctx);
    }

    if (head === "UPDATE") {
      return await this.execUpdate<TRow>(toks, ctx);
    }

    if (head === "DELETE") {
      return await this.execDelete<TRow>(toks, ctx);
    }

    throw new Error(`OfflinePgPool unsupported SQL statement: ${stmt.slice(0, 120)}`);
  }

  // --------------------------------------------------------------------------
  // DDL Execution
  // --------------------------------------------------------------------------

  private execCreateTable(toks: readonly Tok[]): void {
    const cur = new TokenCursor(toks);
    cur.expectUpper("CREATE");
    cur.expectUpper("TABLE");
    let ifNotExists = false;
    if (cur.matchUpper("IF")) {
      cur.expectUpper("NOT");
      cur.expectUpper("EXISTS");
      ifNotExists = true;
    }
    let tableName = cur.expectIdent();
    if (cur.matchUpper(".")) tableName = cur.expectIdent();

    if (ifNotExists && this.tables.has(tableName)) {
      return;
    }

    const def: TableDef = {
      name: tableName,
      columns: [],
      primaryKey: [],
      uniqueConstraints: [],
      tableChecks: [],
      foreignKeys: [],
      indexes: [],
      rows: [],
    };

    cur.expectUpper("(");
    while (!cur.isUpper(")") && !cur.eof()) {
      this.parseTableElement(cur, def);
      if (!cur.matchUpper(",")) break;
    }
    cur.expectUpper(")");

    this.tables.set(tableName, def);
  }

  private parseTableElement(cur: TokenCursor, def: TableDef): void {
    let constraintName: string | undefined;
    if (cur.matchUpper("CONSTRAINT")) {
      constraintName = cur.expectIdent();
    }

    if (cur.matchUpper("PRIMARY")) {
      cur.expectUpper("KEY");
      def.primaryKey = this.parseColumnNameList(cur);
      return;
    }
    if (cur.matchUpper("UNIQUE")) {
      const cols = this.parseColumnNameList(cur);
      def.uniqueConstraints.push({
        name: constraintName ?? `${def.name}_${cols.join("_")}_key`,
        columns: cols,
      });
      return;
    }
    if (cur.matchUpper("CHECK")) {
      cur.expectUpper("(");
      const expr = parseExpr(cur);
      cur.expectUpper(")");
      def.tableChecks.push({
        name: constraintName ?? `${def.name}_check_${def.tableChecks.length + 1}`,
        expr,
      });
      return;
    }
    if (cur.matchUpper("FOREIGN")) {
      cur.expectUpper("KEY");
      const cols = this.parseColumnNameList(cur);
      cur.expectUpper("REFERENCES");
      let refTable = cur.expectIdent();
      if (cur.matchUpper(".")) refTable = cur.expectIdent();
      const refCols = this.parseColumnNameList(cur);
      let onDelete: "CASCADE" | "RESTRICT" = "RESTRICT";
      if (cur.matchUpper("ON")) {
        cur.expectUpper("DELETE");
        if (cur.matchUpper("CASCADE")) onDelete = "CASCADE";
        else cur.next();
      }
      def.foreignKeys.push({
        name: constraintName ?? `${def.name}_${cols.join("_")}_fkey`,
        columns: cols,
        refTable,
        refColumns: refCols,
        onDelete,
      });
      return;
    }

    const col = this.parseColumnDef(cur, def);
    def.columns.push(col);
  }

  private parseColumnDef(cur: TokenCursor, def: TableDef): ColumnDef {
    const name = cur.expectIdent();
    const type = parseTypeName(cur);
    let notNull = false;
    let defaultExpr: Expr | null = null;
    const checks: { name?: string; expr: Expr }[] = [];

    while (!cur.eof() && !cur.isUpper(",") && !cur.isUpper(")")) {
      if (cur.matchUpper("NOT")) {
        cur.expectUpper("NULL");
        notNull = true;
      } else if (cur.matchUpper("NULL")) {
        // nullable
      } else if (cur.matchUpper("PRIMARY")) {
        cur.expectUpper("KEY");
        notNull = true;
        def.primaryKey = [name];
      } else if (cur.matchUpper("UNIQUE")) {
        def.uniqueConstraints.push({
          name: `${def.name}_${name}_key`,
          columns: [name],
        });
      } else if (cur.matchUpper("DEFAULT")) {
        defaultExpr = parseExpr(cur);
      } else if (cur.matchUpper("CHECK")) {
        cur.expectUpper("(");
        const expr = parseExpr(cur);
        cur.expectUpper(")");
        checks.push({ name: `${def.name}_${name}_check`, expr });
      } else if (cur.matchUpper("REFERENCES")) {
        let refTable = cur.expectIdent();
        if (cur.matchUpper(".")) refTable = cur.expectIdent();
        let refCols = [name];
        if (cur.isUpper("(")) {
          refCols = this.parseColumnNameList(cur);
        }
        let onDelete: "CASCADE" | "RESTRICT" = "RESTRICT";
        if (cur.matchUpper("ON")) {
          cur.expectUpper("DELETE");
          if (cur.matchUpper("CASCADE")) onDelete = "CASCADE";
          else cur.next();
        }
        def.foreignKeys.push({
          name: `${def.name}_${name}_fkey`,
          columns: [name],
          refTable,
          refColumns: refCols,
          onDelete,
        });
      } else if (cur.matchUpper("GENERATED")) {
        // GENERATED ALWAYS AS (...) STORED
        while (!cur.eof() && !cur.isUpper(",") && !cur.isUpper(")")) {
          if (cur.isUpper("(")) {
            this.skipParens(cur);
          } else {
            cur.next();
          }
        }
      } else {
        cur.next();
      }
    }

    return { name, type, notNull, defaultExpr, checks };
  }

  private skipParens(cur: TokenCursor): void {
    cur.expectUpper("(");
    let depth = 1;
    while (!cur.eof() && depth > 0) {
      const t = cur.next()!;
      if (t.value === "(") depth++;
      else if (t.value === ")") depth--;
    }
  }

  private parseColumnNameList(cur: TokenCursor): string[] {
    cur.expectUpper("(");
    const cols: string[] = [];
    do {
      cols.push(cur.expectIdent());
    } while (cur.matchUpper(","));
    cur.expectUpper(")");
    return cols;
  }

  private async execAlterTable(toks: readonly Tok[], ctx: TxContext | null): Promise<void> {
    const cur = new TokenCursor(toks);
    cur.expectUpper("ALTER");
    cur.expectUpper("TABLE");
    let tableName = cur.expectIdent();
    if (cur.matchUpper(".")) tableName = cur.expectIdent();
    const def = this.tables.get(tableName);
    if (!def) return;

    while (!cur.eof()) {
      if (cur.matchUpper("ADD")) {
        if (cur.matchUpper("COLUMN")) {
          let ifNotExists = false;
          if (cur.matchUpper("IF")) {
            cur.expectUpper("NOT");
            cur.expectUpper("EXISTS");
            ifNotExists = true;
          }
          const col = this.parseColumnDef(cur, def);
          const existing = def.columns.find((c) => c.name === col.name);
          if (!existing) {
            def.columns.push(col);
            for (const row of def.rows) {
              row.data[col.name] = await this.evalDefault(def, col, ctx);
            }
          } else if (!ifNotExists) {
            throw new Error(`Column ${col.name} already exists on ${def.name}`);
          }
        } else if (cur.matchUpper("CONSTRAINT")) {
          const cName = cur.expectIdent();
          if (cur.matchUpper("CHECK")) {
            cur.expectUpper("(");
            const expr = parseExpr(cur);
            cur.expectUpper(")");
            def.tableChecks.push({ name: cName, expr });
          } else if (cur.matchUpper("UNIQUE")) {
            const cols = this.parseColumnNameList(cur);
            def.uniqueConstraints.push({ name: cName, columns: cols });
          }
        }
      } else if (cur.matchUpper("ALTER")) {
        cur.matchUpper("COLUMN");
        const colName = cur.expectIdent();
        const col = def.columns.find((c) => c.name === colName);
        if (cur.matchUpper("DROP")) {
          cur.expectUpper("NOT");
          cur.expectUpper("NULL");
          if (col) col.notNull = false;
        } else if (cur.matchUpper("SET")) {
          if (cur.matchUpper("NOT")) {
            cur.expectUpper("NULL");
            if (col) col.notNull = true;
          }
        }
      } else if (cur.matchUpper("DROP")) {
        if (cur.matchUpper("CONSTRAINT")) {
          cur.matchUpper("IF");
          cur.matchUpper("EXISTS");
          const cName = cur.expectIdent();
          const idx = def.tableChecks.findIndex((c) => c.name === cName);
          if (idx !== -1) def.tableChecks.splice(idx, 1);
          const fkIdx = def.foreignKeys.findIndex((c) => c.name === cName);
          if (fkIdx !== -1) def.foreignKeys.splice(fkIdx, 1);
          for (const col of def.columns) {
            const colCIdx = col.checks.findIndex(
              (c) => c.name === cName || `${def.name}_${col.name}_check` === cName
            );
            if (colCIdx !== -1) col.checks.splice(colCIdx, 1);
          }
        }
      }
      if (!cur.matchUpper(",")) break;
    }
  }

  private execCreateIndex(stmt: string, toks: readonly Tok[]): void {
    const cur = new TokenCursor(toks);
    cur.expectUpper("CREATE");
    cur.matchUpper("UNIQUE");
    cur.expectUpper("INDEX");
    if (cur.matchUpper("IF")) {
      cur.expectUpper("NOT");
      cur.expectUpper("EXISTS");
    }
    const idxName = cur.expectIdent();
    cur.expectUpper("ON");
    let tblName = cur.expectIdent();
    if (cur.matchUpper(".")) tblName = cur.expectIdent();
    const tbl = this.tables.get(tblName);
    if (tbl && !tbl.indexes.some((i) => i.name === idxName)) {
      tbl.indexes.push({ name: idxName, definition: stmt });
    }
  }

  private async execDoBlock(toks: readonly Tok[], ctx: TxContext | null): Promise<void> {
    const bodyTok = toks.find((t) => t.kind === "str");
    if (!bodyTok) return;
    const body = bodyTok.value;
    const beginMatch = body.match(/BEGIN([\s\S]+)END/i);
    if (!beginMatch) return;
    let content = beginMatch[1]!.trim();

    while (content.length > 0) {
      const ifMatch = content.match(
        /^IF\s+(NOT\s+)?EXISTS\s*\(([\s\S]+?)\)\s*THEN([\s\S]+?)END\s+IF\s*;?/i
      );
      if (ifMatch) {
        const fullMatch = ifMatch[0];
        const negated = Boolean(ifMatch[1]);
        const condSql = ifMatch[2]!.trim();
        const innerSql = ifMatch[3]!.trim();
        const res = await this.execSingleStmt(condSql, ctx);
        const exists = res.rows.length > 0;
        if ((negated && !exists) || (!negated && exists)) {
          for (const inner of splitPgStatements(innerSql)) {
            await this.execSingleStmt(inner, ctx);
          }
        }
        content = content.slice(fullMatch.length).trim();
        continue;
      }

      const semiIdx = content.indexOf(";");
      if (semiIdx === -1) {
        if (content.length > 0) {
          await this.execSingleStmt(content, ctx);
        }
        break;
      }
      const stmt = content.slice(0, semiIdx).trim();
      content = content.slice(semiIdx + 1).trim();
      if (stmt.length > 0) {
        await this.execSingleStmt(stmt, ctx);
      }
    }
  }

  // --------------------------------------------------------------------------
  // DML Execution
  // --------------------------------------------------------------------------

  private async execInsert<TRow>(
    toks: readonly Tok[],
    ctx: TxContext | null
  ): Promise<PgQueryResult<TRow>> {
    const cur = new TokenCursor(toks);
    cur.expectUpper("INSERT");
    cur.expectUpper("INTO");
    let tableName = cur.expectIdent();
    if (cur.matchUpper(".")) tableName = cur.expectIdent();
    const tbl = this.tables.get(tableName);
    if (!tbl) throw new Error(`relation "${tableName}" does not exist`);

    let targetCols: string[];
    if (cur.isUpper("(")) {
      targetCols = this.parseColumnNameList(cur);
    } else {
      targetCols = tbl.columns.map((c) => c.name);
    }

    const candidateRows: Record<string, PgVal>[] = [];

    if (cur.matchUpper("VALUES")) {
      do {
        cur.expectUpper("(");
        const vals: Expr[] = [];
        do {
          vals.push(parseExpr(cur));
        } while (cur.matchUpper(","));
        cur.expectUpper(")");
        if (vals.length !== targetCols.length) {
          throw new Error("INSERT has more or fewer expressions than target columns");
        }
        const rowData = await this.buildDefaultRow(tbl, ctx);
        for (let i = 0; i < targetCols.length; i++) {
          const colName = targetCols[i]!;
          const raw = await this.evalExpr(vals[i]!, { row: {}, aliases: {} }, ctx);
          rowData[colName] = this.coerceCol(tbl, colName, raw);
        }
        candidateRows.push(rowData);
      } while (cur.matchUpper(","));
    } else if (cur.isUpper("SELECT")) {
      const selAst = parseSelect(cur);
      const selRes = await this.execSelectRaw(selAst, ctx, {});
      for (const sRow of selRes.rawRows) {
        const rowData = await this.buildDefaultRow(tbl, ctx);
        for (let i = 0; i < targetCols.length; i++) {
          const colName = targetCols[i]!;
          const srcKey = selRes.columns[i];
          const raw = srcKey ? sRow[srcKey] ?? null : null;
          rowData[colName] = this.coerceCol(tbl, colName, raw);
        }
        candidateRows.push(rowData);
      }
    } else {
      throw new Error("INSERT requires VALUES or SELECT");
    }

    let onConflictCols: string[] | null = null;
    let onConflictAction: "NOTHING" | "UPDATE" | null = null;
    let onConflictSet: { col: string; expr: Expr }[] = [];
    let onConflictWhere: Expr | undefined;

    if (cur.matchUpper("ON")) {
      cur.expectUpper("CONFLICT");
      if (cur.isUpper("(")) {
        onConflictCols = this.parseColumnNameList(cur);
      }
      cur.expectUpper("DO");
      if (cur.matchUpper("NOTHING")) {
        onConflictAction = "NOTHING";
      } else {
        cur.expectUpper("UPDATE");
        cur.expectUpper("SET");
        onConflictAction = "UPDATE";
        do {
          const col = cur.expectIdent();
          cur.expectUpper("=");
          const expr = parseExpr(cur);
          onConflictSet.push({ col, expr });
        } while (cur.matchUpper(","));
        if (cur.matchUpper("WHERE")) {
          onConflictWhere = parseExpr(cur);
        }
      }
    }

    const returningItems: SelectItem[] = [];
    if (cur.matchUpper("RETURNING")) {
      do {
        if (cur.matchUpper("*")) {
          returningItems.push({ expr: { kind: "col", name: "*" }, star: true });
        } else {
          const expr = parseExpr(cur);
          let alias: string | undefined;
          if (cur.matchUpper("AS")) alias = cur.expectIdent();
          returningItems.push({ expr, alias });
        }
      } while (cur.matchUpper(","));
    }

    const returnedRows: Record<string, string | null>[] = [];
    let affected = 0;

    for (const candidate of candidateRows) {
      const conflictRow = this.findConflictRow(tbl, candidate, onConflictCols);
      if (conflictRow && onConflictAction) {
        if (onConflictAction === "NOTHING") continue;
        await this.acquireRowLock(`${tbl.name}::${conflictRow.rowId}`, ctx, false);
        const env: EvalEnv = {
          row: conflictRow.data,
          aliases: { [tbl.name]: conflictRow.data, excluded: candidate },
        };
        if (onConflictWhere && !this.isTruthy(await this.evalExpr(onConflictWhere, env, ctx))) {
          continue;
        }
        const before = { ...conflictRow.data };
        const updated = { ...conflictRow.data };
        for (const assign of onConflictSet) {
          const val = await this.evalExpr(assign.expr, env, ctx);
          updated[assign.col] = this.coerceCol(tbl, assign.col, val);
        }
        await this.validateRow(tbl, updated, conflictRow.rowId, ctx);
        conflictRow.data = updated;
        ctx?.undoLog.push({
          kind: "update",
          tableName: tbl.name,
          rowId: conflictRow.rowId,
          previousData: before,
        });
        affected++;
        if (returningItems.length > 0) {
          returnedRows.push(await this.projectRow(returningItems, updated, tbl, ctx));
        }
        continue;
      }

      await this.validateRow(tbl, candidate, null, ctx);
      const rowId = randomUUID();
      await this.acquireRowLock(`${tbl.name}::${rowId}`, ctx, false);
      tbl.rows.push({ rowId, data: candidate });
      ctx?.undoLog.push({ kind: "insert", tableName: tbl.name, rowId });
      affected++;
      if (returningItems.length > 0) {
        returnedRows.push(await this.projectRow(returningItems, candidate, tbl, ctx));
      }
    }

    return {
      commandTag: `INSERT 0 ${affected}`,
      rows: returnedRows as unknown as readonly TRow[],
    };
  }

  private async execUpdate<TRow>(
    toks: readonly Tok[],
    ctx: TxContext | null
  ): Promise<PgQueryResult<TRow>> {
    const cur = new TokenCursor(toks);
    cur.expectUpper("UPDATE");
    let tableName = cur.expectIdent();
    if (cur.matchUpper(".")) tableName = cur.expectIdent();
    const tbl = this.tables.get(tableName);
    if (!tbl) throw new Error(`relation "${tableName}" does not exist`);

    let alias = tbl.name;
    if (!cur.isUpper("SET")) {
      cur.matchUpper("AS");
      alias = cur.expectIdent();
    }

    cur.expectUpper("SET");
    const assignments: { col: string; expr: Expr }[] = [];
    do {
      const col = cur.expectIdent();
      cur.expectUpper("=");
      const expr = parseExpr(cur);
      assignments.push({ col, expr });
    } while (cur.matchUpper(","));

    let where: Expr | undefined;
    if (cur.matchUpper("WHERE")) {
      where = parseExpr(cur);
    }

    const returningItems: SelectItem[] = [];
    if (cur.matchUpper("RETURNING")) {
      do {
        if (cur.matchUpper("*")) {
          returningItems.push({ expr: { kind: "col", name: "*" }, star: true });
        } else {
          const expr = parseExpr(cur);
          let rAlias: string | undefined;
          if (cur.matchUpper("AS")) rAlias = cur.expectIdent();
          returningItems.push({ expr, alias: rAlias });
        }
      } while (cur.matchUpper(","));
    }

    const returnedRows: Record<string, string | null>[] = [];
    let affected = 0;

    for (const row of [...tbl.rows]) {
      const env: EvalEnv = { row: row.data, aliases: { [tbl.name]: row.data, [alias]: row.data } };
      if (where && !this.isTruthy(await this.evalExpr(where, env, ctx))) {
        continue;
      }
      await this.acquireRowLock(`${tbl.name}::${row.rowId}`, ctx, false);
      // Re-verify WHERE after lock acquisition
      const lockedEnv: EvalEnv = {
        row: row.data,
        aliases: { [tbl.name]: row.data, [alias]: row.data },
      };
      if (where && !this.isTruthy(await this.evalExpr(where, lockedEnv, ctx))) {
        continue;
      }
      const before = { ...row.data };
      const updated = { ...row.data };
      for (const assign of assignments) {
        const val = await this.evalExpr(assign.expr, lockedEnv, ctx);
        updated[assign.col] = this.coerceCol(tbl, assign.col, val);
      }
      await this.validateRow(tbl, updated, row.rowId, ctx);
      row.data = updated;
      ctx?.undoLog.push({
        kind: "update",
        tableName: tbl.name,
        rowId: row.rowId,
        previousData: before,
      });
      affected++;
      if (returningItems.length > 0) {
        returnedRows.push(await this.projectRow(returningItems, updated, tbl, ctx));
      }
    }

    return {
      commandTag: `UPDATE ${affected}`,
      rows: returnedRows as unknown as readonly TRow[],
    };
  }

  private async execDelete<TRow>(
    toks: readonly Tok[],
    ctx: TxContext | null
  ): Promise<PgQueryResult<TRow>> {
    const cur = new TokenCursor(toks);
    cur.expectUpper("DELETE");
    cur.expectUpper("FROM");
    let tableName = cur.expectIdent();
    if (cur.matchUpper(".")) tableName = cur.expectIdent();
    const tbl = this.tables.get(tableName);
    if (!tbl) throw new Error(`relation "${tableName}" does not exist`);

    let alias = tbl.name;
    const next = cur.peek();
    if (next && !cur.isUpper("WHERE") && !cur.isUpper("RETURNING")) {
      cur.matchUpper("AS");
      alias = cur.expectIdent();
    }

    let where: Expr | undefined;
    if (cur.matchUpper("WHERE")) where = parseExpr(cur);

    const returningItems: SelectItem[] = [];
    if (cur.matchUpper("RETURNING")) {
      do {
        if (cur.matchUpper("*")) {
          returningItems.push({ expr: { kind: "col", name: "*" }, star: true });
        } else {
          const expr = parseExpr(cur);
          let rAlias: string | undefined;
          if (cur.matchUpper("AS")) rAlias = cur.expectIdent();
          returningItems.push({ expr, alias: rAlias });
        }
      } while (cur.matchUpper(","));
    }

    const returnedRows: Record<string, string | null>[] = [];
    let affected = 0;

    for (const row of [...tbl.rows]) {
      const env: EvalEnv = { row: row.data, aliases: { [tbl.name]: row.data, [alias]: row.data } };
      if (where && !this.isTruthy(await this.evalExpr(where, env, ctx))) continue;
      await this.deleteSingleRow(tbl, row, ctx);
      affected++;
      if (returningItems.length > 0) {
        returnedRows.push(await this.projectRow(returningItems, row.data, tbl, ctx));
      }
    }

    return {
      commandTag: `DELETE ${affected}`,
      rows: returnedRows as unknown as readonly TRow[],
    };
  }

  private async deleteSingleRow(
    tbl: TableDef,
    row: InternalRow,
    ctx: TxContext | null
  ): Promise<void> {
    await this.acquireRowLock(`${tbl.name}::${row.rowId}`, ctx, false);
    for (const childTbl of this.tables.values()) {
      for (const fk of childTbl.foreignKeys) {
        if (fk.refTable !== tbl.name) continue;
        const matchingChildren = childTbl.rows.filter((cr) =>
          fk.columns.every(
            (cCol, i) => cr.data[cCol] === row.data[fk.refColumns[i]!]
          )
        );
        if (matchingChildren.length > 0) {
          if (fk.onDelete === "RESTRICT") {
            throw new Error(
              `PostgreSQL Query Error: update or delete on table "${tbl.name}" violates foreign key constraint "${fk.name}" on table "${childTbl.name}"`
            );
          }
          for (const child of matchingChildren) {
            await this.deleteSingleRow(childTbl, child, ctx);
          }
        }
      }
    }
    const idx = tbl.rows.findIndex((r) => r.rowId === row.rowId);
    if (idx !== -1) {
      tbl.rows.splice(idx, 1);
      ctx?.undoLog.push({
        kind: "delete",
        tableName: tbl.name,
        rowId: row.rowId,
        previousData: { ...row.data },
        previousIndex: idx,
      });
    }
  }

  // --------------------------------------------------------------------------
  // SELECT Execution
  // --------------------------------------------------------------------------

  private getVirtualTableRows(tableName: string): Record<string, PgVal>[] | null {
    if (tableName === "information_schema.tables") {
      return [...this.tables.keys()].map((name) => ({
        table_schema: "public",
        table_name: name,
      }));
    }
    if (tableName === "pg_indexes") {
      const list: Record<string, PgVal>[] = [];
      for (const tbl of this.tables.values()) {
        for (const ix of tbl.indexes) {
          list.push({
            schemaname: "public",
            tablename: tbl.name,
            indexname: ix.name,
            indexdef: ix.definition,
          });
        }
      }
      return list;
    }
    if (tableName === "pg_constraint") {
      const list: Record<string, PgVal>[] = [];
      for (const tbl of this.tables.values()) {
        for (const tc of tbl.tableChecks) {
          list.push({ conname: tc.name, contype: "c", conrelid: `public.${tbl.name}` });
        }
        for (const col of tbl.columns) {
          for (const chk of col.checks) {
            list.push({
              conname: chk.name ?? `${tbl.name}_${col.name}_check`,
              contype: "c",
              conrelid: `public.${tbl.name}`,
            });
          }
        }
        for (const uq of tbl.uniqueConstraints) {
          list.push({ conname: uq.name, contype: "u", conrelid: `public.${tbl.name}` });
        }
        for (const fk of tbl.foreignKeys) {
          list.push({ conname: fk.name, contype: "f", conrelid: `public.${tbl.name}` });
        }
      }
      return list;
    }
    if (tableName === "pg_stat_database") {
      return [{ datname: "super_ecommerce", deadlocks: this.deadlocks }];
    }
    return null;
  }

  private async execSelect<TRow>(
    ast: SelectAst,
    ctx: TxContext | null,
    outerAliases: Record<string, Record<string, PgVal>>
  ): Promise<PgQueryResult<TRow>> {
    const raw = await this.execSelectRaw(ast, ctx, outerAliases);
    const wireRows = raw.rawRows.map((r) => {
      const out: Record<string, string | null> = {};
      for (const col of raw.columns) {
        const val = r[col] ?? null;
        out[col] = raw.jsonColumns.has(col)
          ? toPgJsonWireText(val)
          : toPgWireText(val);
      }
      return out as unknown as TRow;
    });
    return {
      commandTag: `SELECT ${wireRows.length}`,
      rows: wireRows,
    };
  }

  private async execSelectRaw(
    ast: SelectAst,
    ctx: TxContext | null,
    outerAliases: Record<string, Record<string, PgVal>>
  ): Promise<{ columns: string[]; rawRows: Record<string, PgVal>[]; jsonColumns: Set<string> }> {
    if (!ast.fromTable) {
      const env: EvalEnv = { row: {}, aliases: outerAliases };
      const projected = await this.evaluateSelectItems(ast.items, [env], ctx);
      return projected;
    }

    const baseTableName = ast.fromTable;
    const baseAlias = ast.fromAlias ?? baseTableName;
    const vRows = this.getVirtualTableRows(baseTableName);
    const baseTbl = vRows ? undefined : this.tables.get(baseTableName);
    if (!vRows && !baseTbl) {
      throw new Error(`relation "${baseTableName}" does not exist`);
    }
    const tablesByAlias: Record<string, TableDef> = {};
    if (baseTbl) {
      tablesByAlias[baseTableName] = baseTbl;
      tablesByAlias[baseAlias] = baseTbl;
    }

    const sourceRows: { lockRowId?: string; lockTable?: string; data: Record<string, PgVal> }[] = vRows
      ? vRows.map((d) => ({ data: d }))
      : baseTbl!.rows.map((r) => ({ lockRowId: r.rowId, lockTable: baseTbl!.name, data: r.data }));

    let envs: EvalEnv[] = sourceRows.map((sr) => ({
      row: { ...sr.data },
      aliases: { ...outerAliases, [baseTableName]: sr.data, [baseAlias]: sr.data },
      lockTargets:
        sr.lockRowId && sr.lockTable
          ? { [baseAlias]: `${sr.lockTable}::${sr.lockRowId}`, [baseTableName]: `${sr.lockTable}::${sr.lockRowId}` }
          : undefined,
    }));

    for (const join of ast.joins) {
      const jRows = this.getVirtualTableRows(join.table);
      const jTbl = jRows ? undefined : this.tables.get(join.table);
      if (!jRows && !jTbl) throw new Error(`relation "${join.table}" does not exist`);
      if (jTbl) {
        tablesByAlias[join.table] = jTbl;
        tablesByAlias[join.alias] = jTbl;
      }
      const candidates = jRows
        ? jRows.map((d) => ({ data: d }))
        : jTbl!.rows.map((r) => ({ lockRowId: r.rowId, lockTable: jTbl!.name, data: r.data }));

      const nextEnvs: EvalEnv[] = [];
      for (const env of envs) {
        let matched = false;
        for (const cand of candidates) {
          const mergedEnv: EvalEnv = {
            row: { ...env.row, ...cand.data },
            aliases: { ...env.aliases, [join.table]: cand.data, [join.alias]: cand.data },
            lockTargets: {
              ...(env.lockTargets ?? {}),
              ...(cand.lockRowId && cand.lockTable
                ? {
                    [join.alias]: `${cand.lockTable}::${cand.lockRowId}`,
                    [join.table]: `${cand.lockTable}::${cand.lockRowId}`,
                  }
                : {}),
            },
          };
          const ok = !join.on || this.isTruthy(await this.evalExpr(join.on, mergedEnv, ctx));
          if (ok) {
            matched = true;
            nextEnvs.push(mergedEnv);
          }
        }
        if (!matched && join.type === "LEFT") {
          nextEnvs.push({
            row: { ...env.row },
            aliases: { ...env.aliases, [join.alias]: {} },
            lockTargets: env.lockTargets,
          });
        }
      }
      envs = nextEnvs;
    }

    if (ast.where) {
      const filtered: EvalEnv[] = [];
      for (const env of envs) {
        if (this.isTruthy(await this.evalExpr(ast.where, env, ctx))) {
          filtered.push(env);
        }
      }
      envs = filtered;
    }

    if (ast.orderBy.length > 0) {
      const keyed = await Promise.all(
        envs.map(async (env) => ({
          env,
          keys: await Promise.all(ast.orderBy.map((o) => this.evalExpr(o.expr, env, ctx))),
        }))
      );
      keyed.sort((a, b) => {
        for (let i = 0; i < ast.orderBy.length; i++) {
          const cmp = comparePgVals(a.keys[i] ?? null, b.keys[i] ?? null);
          if (cmp !== 0) return ast.orderBy[i]!.dir === "DESC" ? -cmp : cmp;
        }
        return 0;
      });
      envs = keyed.map((k) => k.env);
    }

    if (ast.forUpdate) {
      const targetKey = ast.forUpdate.ofAlias ?? baseAlias;
      const lockedEnvs: EvalEnv[] = [];
      for (const env of envs) {
        const lockKey = env.lockTargets?.[targetKey];
        if (!lockKey) {
          lockedEnvs.push(env);
          continue;
        }
        let acquired = this.tryAcquireRowLockSync(lockKey, ctx);
        let waited = false;
        if (!acquired) {
          if (ast.forUpdate.skipLocked) continue;
          const res = await this.acquireRowLock(lockKey, ctx, false);
          acquired = res.acquired;
          waited = res.waited;
        }
        if (!acquired) continue;
        // Re-check WHERE only if we waited for another transaction to finish
        if (waited && ast.where) {
          const tblName = lockKey.split("::")[0]!;
          const rowId = lockKey.split("::")[1]!;
          const freshRow = this.tables.get(tblName)?.rows.find((r) => r.rowId === rowId);
          if (!freshRow) continue;
          env.aliases[tblName] = freshRow.data;
          env.aliases[baseAlias] = freshRow.data;
          env.row = { ...env.row, ...freshRow.data };
          if (!this.isTruthy(await this.evalExpr(ast.where, env, ctx))) continue;
        }
        lockedEnvs.push(env);
        if (ast.limit !== undefined && lockedEnvs.length >= ast.limit) break;
      }
      envs = lockedEnvs;
    }

    if (ast.offset !== undefined && ast.offset > 0) {
      envs = envs.slice(ast.offset);
    }
    if (ast.limit !== undefined) {
      envs = envs.slice(0, ast.limit);
    }

    const hasAggregate = ast.items.some((it) => containsAggregate(it.expr));
    if (hasAggregate || ast.groupBy.length > 0) {
      return await this.evaluateGroupedSelect(ast, envs, baseTbl, tablesByAlias, ctx);
    }

    return await this.evaluateSelectItems(ast.items, envs, ctx, baseTbl, tablesByAlias);
  }

  private async evaluateGroupedSelect(
    ast: SelectAst,
    envs: EvalEnv[],
    baseTbl: TableDef | undefined,
    tablesByAlias: Record<string, TableDef>,
    ctx: TxContext | null
  ): Promise<{ columns: string[]; rawRows: Record<string, PgVal>[]; jsonColumns: Set<string> }> {
    const groups = new Map<string, EvalEnv[]>();
    if (ast.groupBy.length === 0) {
      groups.set("__all__", envs);
    } else {
      for (const env of envs) {
        const keyVals = await Promise.all(
          ast.groupBy.map((g) => this.evalExpr(g, env, ctx))
        );
        const key = JSON.stringify(keyVals.map(toPgWireText));
        const list = groups.get(key) ?? [];
        list.push(env);
        groups.set(key, list);
      }
    }

    const columns: string[] = ast.items.map((it, idx) => deriveColName(it, idx));
    const jsonColumns = new Set<string>();
    for (let i = 0; i < ast.items.length; i++) {
      const it = ast.items[i]!;
      const colName = columns[i]!;
      if (isJsonSelectExpr(it.expr, tablesByAlias, baseTbl)) {
        jsonColumns.add(colName);
      }
    }
    const rawRows: Record<string, PgVal>[] = [];
    for (const groupEnvs of groups.values()) {
      const row: Record<string, PgVal> = {};
      for (let i = 0; i < ast.items.length; i++) {
        const it = ast.items[i]!;
        const colName = columns[i]!;
        row[colName] = await this.evalAggregateExpr(it.expr, groupEnvs, ctx);
      }
      rawRows.push(row);
    }
    return { columns, rawRows, jsonColumns };
  }

  private async evaluateSelectItems(
    items: readonly SelectItem[],
    envs: EvalEnv[],
    ctx: TxContext | null,
    baseTbl?: TableDef,
    tablesByAlias: Record<string, TableDef> = baseTbl ? { [baseTbl.name]: baseTbl } : {}
  ): Promise<{ columns: string[]; rawRows: Record<string, PgVal>[]; jsonColumns: Set<string> }> {
    const columns: string[] = [];
    const jsonColumns = new Set<string>();
    const firstItems = items.flatMap((it, idx) => {
      if (it.star) {
        const starTbl = it.starTable ? tablesByAlias[it.starTable] : baseTbl;
        if (starTbl) {
          for (const c of starTbl.columns) {
            if (c.type.toLowerCase().includes("json")) jsonColumns.add(c.name);
          }
          return starTbl.columns.map((c) => c.name);
        }
        if (envs[0]) return Object.keys(envs[0].row);
        return [];
      }
      const colName = deriveColName(it, idx);
      if (isJsonSelectExpr(it.expr, tablesByAlias, baseTbl)) {
        jsonColumns.add(colName);
      }
      return [colName];
    });
    columns.push(...firstItems);

    const rawRows: Record<string, PgVal>[] = [];
    for (const env of envs) {
      const out: Record<string, PgVal> = {};
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        if (it.star) {
          const src = it.starTable ? env.aliases[it.starTable] ?? env.row : env.row;
          const starTbl = it.starTable ? tablesByAlias[it.starTable] : baseTbl;
          for (const [k, v] of Object.entries(src)) {
            if (!columns.includes(k)) columns.push(k);
            if (starTbl?.columns.find((c) => c.name === k)?.type.toLowerCase().includes("json")) {
              jsonColumns.add(k);
            }
            out[k] = v;
          }
        } else {
          const colName = deriveColName(it, i);
          out[colName] = await this.evalExpr(it.expr, env, ctx);
        }
      }
      rawRows.push(out);
    }
    return { columns, rawRows, jsonColumns };
  }

  private async projectRow(
    items: readonly SelectItem[],
    rowData: Record<string, PgVal>,
    tbl: TableDef,
    ctx: TxContext | null
  ): Promise<Record<string, string | null>> {
    const env: EvalEnv = { row: rowData, aliases: { [tbl.name]: rowData } };
    const { columns, rawRows, jsonColumns } = await this.evaluateSelectItems(
      items,
      [env],
      ctx,
      tbl,
      { [tbl.name]: tbl }
    );
    const out: Record<string, string | null> = {};
    const raw = rawRows[0] ?? {};
    for (const col of columns) {
      const val = raw[col] ?? null;
      out[col] = jsonColumns.has(col)
        ? toPgJsonWireText(val)
        : toPgWireText(val);
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Expression Evaluation
  // --------------------------------------------------------------------------

  private async evalAggregateExpr(
    expr: Expr,
    envs: EvalEnv[],
    ctx: TxContext | null
  ): Promise<PgVal> {
    if (expr.kind === "cast") {
      const inner = await this.evalAggregateExpr(expr.expr, envs, ctx);
      return applyCast(inner, expr.typeName);
    }
    if (expr.kind === "call") {
      const fn = expr.name;
      if (fn === "count" || fn === "sum" || fn === "min" || fn === "max") {
        let filtered = envs;
        if (expr.filter) {
          filtered = [];
          for (const e of envs) {
            if (this.isTruthy(await this.evalExpr(expr.filter, e, ctx))) {
              filtered.push(e);
            }
          }
        }
        if (fn === "count") {
          if (expr.star) return BigInt(filtered.length);
          let cnt = 0n;
          for (const e of filtered) {
            const v = await this.evalExpr(expr.args[0]!, e, ctx);
            if (v !== null && v !== undefined) cnt++;
          }
          return cnt;
        }
        const vals = await Promise.all(
          filtered.map((e) => this.evalExpr(expr.args[0]!, e, ctx))
        );
        const nonNull = vals.filter((v) => v !== null && v !== undefined);
        if (fn === "sum") {
          if (nonNull.length === 0) return null;
          let acc = 0n;
          let isFloat = false;
          for (const v of nonNull) {
            if (typeof v === "number" && !Number.isInteger(v)) isFloat = true;
          }
          if (isFloat) {
            return nonNull.reduce<number>((s, v) => s + Number(v), 0);
          }
          for (const v of nonNull) acc += BigInt(Math.trunc(Number(v)));
          return acc;
        }
        if (nonNull.length === 0) return null;
        nonNull.sort(comparePgVals);
        return fn === "min" ? nonNull[0]! : nonNull[nonNull.length - 1]!;
      }
      const args = await Promise.all(
        expr.args.map((a) => this.evalAggregateExpr(a, envs, ctx))
      );
      return this.invokeScalarFn(expr.name, args);
    }
    return this.evalExpr(expr, envs[0] ?? { row: {}, aliases: {} }, ctx);
  }

  private async evalExpr(
    expr: Expr,
    env: EvalEnv,
    ctx: TxContext | null
  ): Promise<PgVal> {
    switch (expr.kind) {
      case "lit":
        return expr.value;
      case "col": {
        if (expr.table) {
          const src = env.aliases[expr.table];
          if (src && expr.name in src) return src[expr.name] ?? null;
          return null;
        }
        if (expr.name in env.row) return env.row[expr.name] ?? null;
        for (const src of Object.values(env.aliases)) {
          if (expr.name in src) return src[expr.name] ?? null;
        }
        return null;
      }
      case "tuple": {
        const items: unknown[] = [];
        for (const it of expr.items) {
          items.push(await this.evalExpr(it, env, ctx));
        }
        return items;
      }
      case "cast": {
        const val = await this.evalExpr(expr.expr, env, ctx);
        return applyCast(val, expr.typeName);
      }
      case "unary": {
        const v = await this.evalExpr(expr.expr, env, ctx);
        if (expr.op === "NOT") return v === null ? null : !this.isTruthy(v);
        if (v === null) return null;
        if (expr.op === "-") return typeof v === "bigint" ? -v : -Number(v);
        return typeof v === "bigint" ? v : Number(v);
      }
      case "is_null": {
        const v = await this.evalExpr(expr.expr, env, ctx);
        const isN = v === null || v === undefined;
        return expr.negated ? !isN : isN;
      }
      case "between": {
        const v = await this.evalExpr(expr.expr, env, ctx);
        const lo = await this.evalExpr(expr.low, env, ctx);
        const hi = await this.evalExpr(expr.high, env, ctx);
        if (v === null || lo === null || hi === null) return null;
        const ok = comparePgVals(v, lo) >= 0 && comparePgVals(v, hi) <= 0;
        return expr.negated ? !ok : ok;
      }
      case "in": {
        const v = await this.evalExpr(expr.expr, env, ctx);
        if (v === null) return null;
        let found = false;
        for (const item of expr.list) {
          const iv = await this.evalExpr(item, env, ctx);
          if (iv !== null && comparePgVals(v, iv) === 0) {
            found = true;
            break;
          }
        }
        return expr.negated ? !found : found;
      }
      case "in_subquery": {
        const v = await this.evalExpr(expr.expr, env, ctx);
        if (v === null) return null;
        const sub = await this.execSelectRaw(expr.query, ctx, env.aliases);
        const firstCol = sub.columns[0];
        const found = firstCol
          ? sub.rawRows.some((r) => {
              const iv = r[firstCol] ?? null;
              return iv !== null && comparePgVals(v, iv) === 0;
            })
          : false;
        return expr.negated ? !found : found;
      }
      case "any": {
        const v = await this.evalExpr(expr.expr, env, ctx);
        const arr = await this.evalExpr(expr.arrayExpr, env, ctx);
        if (!Array.isArray(arr) || v === null) return false;
        return arr.some((item) => comparePgVals(v, item as PgVal) === 0);
      }
      case "case": {
        const baseVal = expr.base ? await this.evalExpr(expr.base, env, ctx) : undefined;
        for (const w of expr.whens) {
          const c = await this.evalExpr(w.cond, env, ctx);
          const matched =
            baseVal !== undefined ? comparePgVals(baseVal, c) === 0 : this.isTruthy(c);
          if (matched) return await this.evalExpr(w.then, env, ctx);
        }
        return expr.elseExpr ? await this.evalExpr(expr.elseExpr, env, ctx) : null;
      }
      case "exists": {
        const sub = await this.execSelectRaw(expr.query, ctx, env.aliases);
        const has = sub.rawRows.length > 0;
        return expr.negated ? !has : has;
      }
      case "subquery": {
        const sub = await this.execSelectRaw(expr.query, ctx, env.aliases);
        if (sub.rawRows.length === 0) return null;
        const firstCol = sub.columns[0];
        return firstCol ? sub.rawRows[0]![firstCol] ?? null : null;
      }
      case "call": {
        if (expr.name === "coalesce") {
          for (const arg of expr.args) {
            const v = await this.evalExpr(arg, env, ctx);
            if (v !== null && v !== undefined) return v;
          }
          return null;
        }
        if (
          expr.name === "pg_advisory_xact_lock" ||
          expr.name === "pg_advisory_lock"
        ) {
          const rawArg = expr.args[0] ? await this.evalExpr(expr.args[0], env, ctx) : "default";
          const lockKey = `advisory::${rawArg}`;
          await this.acquireRowLock(lockKey, ctx, false);
          return true;
        }
        if (
          expr.name === "pg_try_advisory_xact_lock" ||
          expr.name === "pg_try_advisory_lock"
        ) {
          const rawArg = expr.args[0] ? await this.evalExpr(expr.args[0], env, ctx) : "default";
          const lockKey = `advisory::${rawArg}`;
          return this.tryAcquireRowLockSync(lockKey, ctx);
        }
        if (expr.name === "pg_advisory_unlock") {
          const rawArg = expr.args[0] ? await this.evalExpr(expr.args[0], env, ctx) : "default";
          const lockKey = `advisory::${rawArg}`;
          const existing = this.rowLocks.get(lockKey);
          if (existing && existing.ownerTxId === ctx?.txId) {
            this.rowLocks.delete(lockKey);
            for (const w of existing.waiters) w();
            ctx.heldLocks.delete(lockKey);
            return true;
          }
          return false;
        }
        const args = await Promise.all(
          expr.args.map((a) => this.evalExpr(a, env, ctx))
        );
        return this.invokeScalarFn(expr.name, args);
      }
      case "binary": {
        if (expr.op === "AND") {
          const l = await this.evalExpr(expr.left, env, ctx);
          if (l !== null && !this.isTruthy(l)) return false;
          const r = await this.evalExpr(expr.right, env, ctx);
          if (r !== null && !this.isTruthy(r)) return false;
          if (l === null || r === null) return null;
          return true;
        }
        if (expr.op === "OR") {
          const l = await this.evalExpr(expr.left, env, ctx);
          if (l !== null && this.isTruthy(l)) return true;
          const r = await this.evalExpr(expr.right, env, ctx);
          if (r !== null && this.isTruthy(r)) return true;
          if (l === null || r === null) return null;
          return false;
        }
        const l = await this.evalExpr(expr.left, env, ctx);
        const r = await this.evalExpr(expr.right, env, ctx);
        if (expr.op === "@>") return jsonbContains(l, r);
        if (expr.op === "<@") return jsonbContains(r, l);
        if (l === null || r === null) return null;
        if (expr.op === "->") return jsonAccess(l, r, false);
        if (expr.op === "->>") return jsonAccess(l, r, true);
        if (expr.op === "||") return `${toPgWireText(l) ?? ""}${toPgWireText(r) ?? ""}`;
        if (expr.op === "LIKE") return likeMatch(String(l), String(r), false);
        if (expr.op === "ILIKE") return likeMatch(String(l), String(r), true);
        if (expr.op === "+") return addNum(l, r);
        if (expr.op === "-") return subNum(l, r);
        if (expr.op === "*") return mulNum(l, r);
        if (expr.op === "/") return Number(l) / Number(r);
        if (expr.op === "%") return Number(l) % Number(r);
        const cmp = comparePgVals(l, r);
        if (expr.op === "=") return cmp === 0;
        if (expr.op === "!=") return cmp !== 0;
        if (expr.op === "<") return cmp < 0;
        if (expr.op === "<=") return cmp <= 0;
        if (expr.op === ">") return cmp > 0;
        if (expr.op === ">=") return cmp >= 0;
        return null;
      }
    }
  }

  private invokeScalarFn(name: string, args: PgVal[]): PgVal {
    switch (name) {
      case "now":
        return new Date();
      case "gen_random_uuid":
        return randomUUID();
      case "current_database":
        return "super_ecommerce";
      case "current_setting":
        return args[0] === "server_version" ? "16.15 (OfflinePgPool)" : "";
      case "lower":
        return args[0] === null ? null : String(args[0]).toLowerCase();
      case "upper":
        return args[0] === null ? null : String(args[0]).toUpperCase();
      case "trim":
        return args[0] === null ? null : String(args[0]).trim();
      case "__array__":
        return args;
      case "to_tsvector":
        return args.map((a) => String(a ?? "")).join(" ");
      case "pg_advisory_xact_lock":
      case "pg_advisory_lock":
      case "pg_advisory_unlock":
      case "pg_try_advisory_lock":
      case "pg_try_advisory_xact_lock":
        return true;
      default:
        return args[0] ?? null;
    }
  }

  private isTruthy(val: PgVal): boolean {
    if (val === null || val === undefined) return false;
    if (typeof val === "boolean") return val;
    if (typeof val === "number") return val !== 0;
    if (typeof val === "bigint") return val !== 0n;
    if (typeof val === "string") return val === "true" || val === "t" || val === "1";
    return Boolean(val);
  }

  // --------------------------------------------------------------------------
  // Validation & Defaults
  // --------------------------------------------------------------------------

  private async buildDefaultRow(
    tbl: TableDef,
    ctx: TxContext | null
  ): Promise<Record<string, PgVal>> {
    const out: Record<string, PgVal> = {};
    for (const col of tbl.columns) {
      out[col.name] = await this.evalDefault(tbl, col, ctx);
    }
    return out;
  }

  private async evalDefault(
    tbl: TableDef,
    col: ColumnDef,
    ctx: TxContext | null
  ): Promise<PgVal> {
    if (!col.defaultExpr) return null;
    const raw = await this.evalExpr(col.defaultExpr, { row: {}, aliases: {} }, ctx);
    return this.coerceCol(tbl, col.name, raw);
  }

  private coerceCol(tbl: TableDef, colName: string, val: PgVal): PgVal {
    if (val === null || val === undefined) return null;
    const col = tbl.columns.find((c) => c.name === colName);
    if (!col) return val;
    const t = col.type.toLowerCase();
    if (t.includes("bigint")) {
      if (typeof val === "bigint") return val;
      if (typeof val === "number") return BigInt(Math.trunc(val));
      return BigInt(String(val));
    }
    if (t.includes("int")) {
      return typeof val === "bigint" ? Number(val) : Math.trunc(Number(val));
    }
    if (t.includes("bool")) {
      if (typeof val === "boolean") return val;
      return val === "true" || val === "t" || val === "1" || val === 1;
    }
    if (t.includes("timestamptz") || t.includes("timestamp")) {
      return val instanceof Date ? val : new Date(String(val));
    }
    if (t.includes("jsonb") || t.includes("json")) {
      if (val === PG_JSON_NULL) return PG_JSON_NULL;
      if (typeof val === "string") {
        try {
          const parsed = JSON.parse(val) as PgVal;
          return parsed === null ? PG_JSON_NULL : parsed;
        } catch {
          return val;
        }
      }
      return val;
    }
    if (typeof val === "object" && !(val instanceof Date)) {
      return JSON.stringify(val);
    }
    return String(val);
  }

  private findConflictRow(
    tbl: TableDef,
    candidate: Record<string, PgVal>,
    conflictCols: readonly string[] | null
  ): InternalRow | undefined {
    const keySets: readonly (readonly string[])[] = conflictCols
      ? [conflictCols]
      : [
          ...(tbl.primaryKey.length > 0 ? [tbl.primaryKey] : []),
          ...tbl.uniqueConstraints.map((u) => u.columns),
        ];

    for (const cols of keySets) {
      if (cols.some((c) => candidate[c] === null || candidate[c] === undefined)) {
        continue;
      }
      const hit = tbl.rows.find((r) =>
        cols.every((c) => comparePgVals(r.data[c] ?? null, candidate[c] ?? null) === 0)
      );
      if (hit) return hit;
    }
    return undefined;
  }

  private async validateRow(
    tbl: TableDef,
    data: Record<string, PgVal>,
    selfRowId: string | null,
    ctx: TxContext | null
  ): Promise<void> {
    for (const col of tbl.columns) {
      const val = data[col.name] ?? null;
      if (col.notNull && val === null) {
        throw new Error(
          `PostgreSQL Query Error: null value in column "${col.name}" of relation "${tbl.name}" violates not-null constraint`
        );
      }
      for (const chk of col.checks) {
        const ok = await this.evalExpr(
          chk.expr,
          { row: data, aliases: { [tbl.name]: data } },
          ctx
        );
        if (ok === false) {
          throw new Error(
            `PostgreSQL Query Error: new row for relation "${tbl.name}" violates check constraint "${chk.name ?? col.name}"`
          );
        }
      }
    }

    for (const tc of tbl.tableChecks) {
      const ok = await this.evalExpr(
        tc.expr,
        { row: data, aliases: { [tbl.name]: data } },
        ctx
      );
      if (ok === false) {
        throw new Error(
          `PostgreSQL Query Error: new row for relation "${tbl.name}" violates check constraint "${tc.name}"`
        );
      }
    }

    const uniqueSets: { name: string; cols: readonly string[] }[] = [
      ...(tbl.primaryKey.length > 0
        ? [{ name: `${tbl.name}_pkey`, cols: tbl.primaryKey }]
        : []),
      ...tbl.uniqueConstraints.map((u) => ({ name: u.name, cols: u.columns })),
    ];

    for (const uq of uniqueSets) {
      if (uq.cols.some((c) => data[c] === null || data[c] === undefined)) continue;
      const dup = tbl.rows.find(
        (r) =>
          r.rowId !== selfRowId &&
          uq.cols.every((c) => comparePgVals(r.data[c] ?? null, data[c] ?? null) === 0)
      );
      if (dup) {
        throw new Error(
          `PostgreSQL Query Error: duplicate key value violates unique constraint "${uq.name}"`
        );
      }
    }

    for (const fk of tbl.foreignKeys) {
      if (fk.columns.some((c) => data[c] === null || data[c] === undefined)) continue;
      const parentTbl = this.tables.get(fk.refTable);
      const found = parentTbl?.rows.some((pr) =>
        fk.columns.every(
          (c, i) => comparePgVals(pr.data[fk.refColumns[i]!] ?? null, data[c] ?? null) === 0
        )
      );
      if (!found) {
        throw new Error(
          `PostgreSQL Query Error: insert or update on table "${tbl.name}" violates foreign key constraint "${fk.name}"`
        );
      }
    }
  }
}

interface EvalEnv {
  row: Record<string, PgVal>;
  aliases: Record<string, Record<string, PgVal>>;
  lockTargets?: Record<string, string>;
}

function containsAggregate(expr: Expr): boolean {
  switch (expr.kind) {
    case "call":
      return (
        ["count", "sum", "min", "max"].includes(expr.name) ||
        expr.args.some(containsAggregate)
      );
    case "cast":
    case "unary":
      return containsAggregate(expr.expr);
    case "binary":
      return containsAggregate(expr.left) || containsAggregate(expr.right);
    default:
      return false;
  }
}

function deriveColName(item: SelectItem, idx: number): string {
  if (item.alias) return item.alias;
  if (item.expr.kind === "col") return item.expr.name;
  if (item.expr.kind === "cast" && item.expr.expr.kind === "col") {
    return item.expr.expr.name;
  }
  if (item.expr.kind === "call") return item.expr.name;
  return `?column?_${idx}`;
}

function applyCast(val: PgVal, typeName: string): PgVal {
  if (val === null || val === undefined) return null;
  const t = typeName.toLowerCase();
  if (t.includes("text") || t.includes("varchar") || t.includes("char") || t.includes("uuid")) {
    return toPgWireText(val);
  }
  if (t.includes("bigint")) {
    return typeof val === "bigint" ? val : BigInt(Math.trunc(Number(val)));
  }
  if (t.includes("int")) {
    return Math.trunc(Number(val));
  }
  if (t.includes("bool")) {
    return val === true || val === "true" || val === "t" || val === "1";
  }
  if (t.includes("timestamptz") || t.includes("timestamp")) {
    return val instanceof Date ? val : new Date(String(val));
  }
  if (t.includes("jsonb") || t.includes("json")) {
    if (val === PG_JSON_NULL) return PG_JSON_NULL;
    if (typeof val === "string") {
      try {
        const parsed = JSON.parse(val) as PgVal;
        return parsed === null ? PG_JSON_NULL : parsed;
      } catch {
        return val;
      }
    }
    return val;
  }
  return val;
}

function isJsonSelectExpr(
  expr: Expr,
  tablesByAlias: Record<string, TableDef>,
  defaultTable?: TableDef
): boolean {
  switch (expr.kind) {
    case "col": {
      const tbl = expr.table ? tablesByAlias[expr.table] : defaultTable;
      if (tbl) {
        const col = tbl.columns.find((c) => c.name === expr.name);
        return Boolean(col && col.type.toLowerCase().includes("json"));
      }
      for (const cand of Object.values(tablesByAlias)) {
        const col = cand.columns.find((c) => c.name === expr.name);
        if (col) return col.type.toLowerCase().includes("json");
      }
      return false;
    }
    case "cast":
      return expr.typeName.toLowerCase().includes("json");
    case "binary":
      return expr.op === "->";
    case "call":
      if (expr.name === "coalesce") {
        return expr.args.some((a) => isJsonSelectExpr(a, tablesByAlias, defaultTable));
      }
      return false;
    case "case":
      return (
        expr.whens.some((w) => isJsonSelectExpr(w.then, tablesByAlias, defaultTable)) ||
        (expr.elseExpr ? isJsonSelectExpr(expr.elseExpr, tablesByAlias, defaultTable) : false)
      );
    default:
      return false;
  }
}

function toPgWireText(val: PgVal): string | null {
  if (val === null || val === undefined) return null;
  if (val === PG_JSON_NULL) return "null";
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "boolean") return val ? "t" : "f";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

function toPgJsonWireText(val: PgVal): string | null {
  if (val === null || val === undefined) return null;
  if (val === PG_JSON_NULL) return "null";
  if (val instanceof Date) return JSON.stringify(val.toISOString());
  if (typeof val === "bigint") return val.toString();
  return JSON.stringify(val);
}

function comparePgVals(a: PgVal, b: PgVal): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a === PG_JSON_NULL && b === PG_JSON_NULL) return 0;
  if (a === PG_JSON_NULL) return -1;
  if (b === PG_JSON_NULL) return 1;

  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const c = comparePgVals(a[i] as PgVal, b[i] as PgVal);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }

  if (a instanceof Date || b instanceof Date) {
    const da = a instanceof Date ? a.getTime() : new Date(String(a)).getTime();
    const db = b instanceof Date ? b.getTime() : new Date(String(b)).getTime();
    return da - db;
  }

  if (
    (typeof a === "number" || typeof a === "bigint") &&
    (typeof b === "number" || typeof b === "bigint")
  ) {
    if (typeof a === "bigint" && typeof b === "bigint") {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    const na = Number(a);
    const nb = Number(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  }

  const sa = typeof a === "object" ? JSON.stringify(a) : String(a);
  const sb = typeof b === "object" ? JSON.stringify(b) : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function addNum(a: PgVal, b: PgVal): PgVal {
  if (typeof a === "bigint" || typeof b === "bigint") {
    return BigInt(Math.trunc(Number(a))) + BigInt(Math.trunc(Number(b)));
  }
  return Number(a) + Number(b);
}

function subNum(a: PgVal, b: PgVal): PgVal {
  if (typeof a === "bigint" || typeof b === "bigint") {
    return BigInt(Math.trunc(Number(a))) - BigInt(Math.trunc(Number(b)));
  }
  return Number(a) - Number(b);
}

function mulNum(a: PgVal, b: PgVal): PgVal {
  if (typeof a === "bigint" || typeof b === "bigint") {
    return BigInt(Math.trunc(Number(a))) * BigInt(Math.trunc(Number(b)));
  }
  return Number(a) * Number(b);
}

function likeMatch(text: string, pattern: string, caseInsensitive: boolean): boolean {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  const re = new RegExp(`^${escaped}$`, caseInsensitive ? "is" : "s");
  return re.test(text);
}

function jsonAccess(obj: PgVal, key: PgVal, asText: boolean): PgVal {
  if (obj === null || obj === undefined || key === null) return null;
  let parsed: unknown = obj;
  if (typeof obj === "string") {
    try {
      parsed = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const val = Array.isArray(parsed)
    ? parsed[Number(key)]
    : (parsed as Record<string, unknown>)[String(key)];
  if (val === undefined || val === null) return null;
  if (asText) return typeof val === "object" ? JSON.stringify(val) : String(val);
  return val as PgVal;
}

function jsonbContains(superset: PgVal, subset: PgVal): boolean {
  if (superset === null || subset === null) return false;
  const a = superset === PG_JSON_NULL ? null : typeof superset === "string" ? safeJsonParse(superset) : superset;
  const b = subset === PG_JSON_NULL ? null : typeof subset === "string" ? safeJsonParse(subset) : subset;
  if (Array.isArray(b)) {
    if (!Array.isArray(a)) return false;
    return b.every((itemB) => a.some((itemA) => jsonbContains(itemA as PgVal, itemB as PgVal)));
  }
  if (b && typeof b === "object") {
    if (!a || typeof a !== "object" || Array.isArray(a)) return false;
    const recA = a as Record<string, unknown>;
    const recB = b as Record<string, unknown>;
    return Object.entries(recB).every(
      ([k, v]) => k in recA && jsonbContains(recA[k] as PgVal, v as PgVal)
    );
  }
  return a === b;
}

function safeJsonParse(s: string): PgVal {
  try {
    return JSON.parse(s) as PgVal;
  } catch {
    return s;
  }
}
