/**
 * Hardened PostgreSQL v3 Wire Protocol Driver (`packages/db/src/pg-wire-driver.ts`).
 *
 * Implements the official PostgreSQL Frontend/Backend Protocol v3.0 (`0x00030000`)
 * over `node:net` TCP, `node:tls` TLS 1.2/1.3 encrypted sockets, or Duplex streams:
 * - `SSLRequest` (`80877103` / `0x04d2162f`) negotiation + `node:tls` socket upgrade (`ssl: "disable" | "prefer" | "require" | boolean | ConnectionOptions`)
 * - `StartupMessage` (`0x00030000`) with `AuthenticationOk`, `CleartextPassword`, `MD5Password`, and `SASL/SCRAM-SHA-256`
 * - **Extended Query Protocol** (`Parse 'P'` -> `Bind 'B'` -> `Describe 'D'` -> `Execute 'E'` -> `Sync 'S'`)
 *   transmitting `$1..$N` parameters out-of-band in length-prefixed wire frames (eliminating SQL text interpolation risks)
 * - Simple Query (`'Q'`) fallback for multi-statement DDL migration scripts
 * - Per-client query serialization mutex, socket lifecycle cleanup, and SAVEPOINT-aware `withTransaction`
 */

import { connect as netConnect, Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions as TlsConnectionOptions } from "node:tls";
import { Duplex } from "node:stream";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { serializeWithBigInt } from "./bigint-json.ts";

export type PgSslMode = boolean | "disable" | "prefer" | "require" | TlsConnectionOptions;
export type PgQueryProtocolMode = "extended" | "simple";

export interface PgConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password?: string;
  readonly database: string;
  readonly ssl?: PgSslMode;
  readonly queryMode?: PgQueryProtocolMode;
  readonly stream?: Duplex;
}

export interface PgQueryResult<TRow = Record<string, string | null>> {
  readonly commandTag: string;
  readonly rows: readonly TRow[];
}

export function buildSslRequestPacket(): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeInt32BE(8, 0);
  buf.writeInt32BE(80877103, 4); // 0x04d2162f official PostgreSQL SSLRequest code
  return buf;
}

function buildStartupPacket(params: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const versionBuf = Buffer.alloc(4);
  versionBuf.writeInt32BE(196608, 0); // Protocol 3.0 (0x00030000)
  parts.push(versionBuf);

  for (const [k, v] of Object.entries(params)) {
    parts.push(Buffer.from(`${k}\0${v}\0`, "utf8"));
  }
  parts.push(Buffer.from([0])); // Terminator byte

  const payload = Buffer.concat(parts);
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeInt32BE(payload.length + 4, 0);
  return Buffer.concat([lengthPrefix, payload]);
}

function buildFrontendFrame(typeChar: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(typeChar, 0, 1, "ascii");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

/**
 * Encodes a parameter value into PostgreSQL Extended Query text-format wire representation
 * (sent out-of-band in `Bind` with explicit byte length — never concatenated into SQL).
 */
export function encodeExtendedParamValue(val: unknown): Buffer | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return null;
    return Buffer.from(val.toISOString(), "utf8");
  }
  if (typeof val === "number") {
    return Number.isFinite(val) ? Buffer.from(String(val), "utf8") : null;
  }
  if (typeof val === "bigint") {
    return Buffer.from(val.toString(), "utf8");
  }
  if (typeof val === "boolean") {
    return Buffer.from(val ? "t" : "f", "utf8");
  }
  if (typeof val === "object") {
    return Buffer.from(serializeWithBigInt(val), "utf8");
  }
  return Buffer.from(String(val), "utf8");
}

/**
 * Builds the pipelined PostgreSQL v3 Extended Query burst:
 * `Parse ('P')` + `Bind ('B')` + `Describe ('D')` + `Execute ('E')` + `Sync ('S')`.
 */
export function buildExtendedQueryPipeline(
  sql: string,
  params: readonly unknown[]
): Buffer {
  // 1. Parse ('P'): unnamed stmt ""\0 + sql\0 + Int16(0 param type OIDs)
  const sqlBuf = Buffer.from(sql, "utf8");
  const parseBody = Buffer.alloc(1 + sqlBuf.length + 1 + 2);
  parseBody[0] = 0; // unnamed statement
  sqlBuf.copy(parseBody, 1);
  parseBody[1 + sqlBuf.length] = 0;
  parseBody.writeInt16BE(0, 1 + sqlBuf.length + 1);

  // 2. Bind ('B'): portal ""\0 + stmt ""\0 + Int16(0 param format codes = text) + Int16(N) + [len, bytes]* + Int16(0 result format codes = text)
  const encodedParams = params.map(encodeExtendedParamValue);
  let paramsByteLen = 0;
  for (const p of encodedParams) {
    paramsByteLen += 4 + (p ? p.length : 0);
  }
  const bindBody = Buffer.alloc(1 + 1 + 2 + 2 + paramsByteLen + 2);
  let offset = 0;
  bindBody[offset++] = 0; // unnamed portal
  bindBody[offset++] = 0; // unnamed statement
  bindBody.writeInt16BE(0, offset); // 0 format codes => all text
  offset += 2;
  bindBody.writeInt16BE(encodedParams.length, offset);
  offset += 2;
  for (const p of encodedParams) {
    if (p === null) {
      bindBody.writeInt32BE(-1, offset);
      offset += 4;
    } else {
      bindBody.writeInt32BE(p.length, offset);
      offset += 4;
      p.copy(bindBody, offset);
      offset += p.length;
    }
  }
  bindBody.writeInt16BE(0, offset); // 0 result format codes => all text

  // 3. Describe ('D'): 'P' (portal) + ""\0
  const describeBody = Buffer.from([0x50, 0x00]);

  // 4. Execute ('E'): ""\0 + Int32(0 = unlimited rows)
  const executeBody = Buffer.alloc(5);
  executeBody[0] = 0;
  executeBody.writeInt32BE(0, 1);

  // 5. Sync ('S'): empty
  const syncBody = Buffer.alloc(0);

  return Buffer.concat([
    buildFrontendFrame("P", parseBody),
    buildFrontendFrame("B", bindBody),
    buildFrontendFrame("D", describeBody),
    buildFrontendFrame("E", executeBody),
    buildFrontendFrame("S", syncBody),
  ]);
}

function md5Hex(input: Buffer | string): string {
  return createHash("md5").update(input).digest("hex");
}

function formatPgLiteral(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return "NULL";
    return `'${val.toISOString()}'::timestamptz`;
  }
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  if (typeof val === "object") {
    const json = serializeWithBigInt(val).replaceAll("'", "''");
    return `'${json}'::jsonb`;
  }
  const escaped = String(val).replaceAll("'", "''");
  return `'${escaped}'`;
}

function matchDollarQuoteTag(sql: string, pos: number): string | null {
  if (sql[pos] !== "$") return null;
  let i = pos + 1;
  if (i < sql.length && sql[i] === "$") {
    return "$$";
  }
  if (i >= sql.length || !/[A-Za-z_]/.test(sql[i]!)) {
    return null;
  }
  i++;
  while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i]!)) {
    i++;
  }
  if (i < sql.length && sql[i] === "$") {
    return sql.slice(pos, i + 1);
  }
  return null;
}

/**
 * Inspects a SQL query to verify whether `$1..$N` placeholders match `paramCount`
 * and whether the query is a single statement eligible for Extended Query (`Parse/Bind`).
 */
function canUseExtendedProtocol(sql: string, paramCount: number): boolean {
  if (paramCount === 0) return false;
  let i = 0;
  const len = sql.length;
  let maxParamIdx = 0;
  const seenParams = new Set<number>();
  let unquotedSemicolons = 0;

  while (i < len) {
    const ch = sql[i]!;
    const next = i + 1 < len ? sql[i + 1]! : "";

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
      continue;
    }
    if (ch === "'") {
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
      continue;
    }
    if (ch === '"') {
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
      continue;
    }
    if (ch === "$") {
      const tag = matchDollarQuoteTag(sql, i);
      if (tag) {
        const endIdx = sql.indexOf(tag, i + tag.length);
        if (endIdx === -1) break;
        i = endIdx + tag.length;
        continue;
      }
      if (next >= "1" && next <= "9") {
        let j = i + 1;
        while (j < len && sql[j]! >= "0" && sql[j]! <= "9") j++;
        const pIdx = Number(sql.slice(i + 1, j));
        seenParams.add(pIdx);
        if (pIdx > maxParamIdx) maxParamIdx = pIdx;
        i = j;
        continue;
      }
    }
    if (ch === ";") {
      // Ignore a trailing semicolon at the very end of the query
      if (sql.slice(i + 1).trim().length > 0) {
        unquotedSemicolons++;
      }
    }
    i++;
  }

  if (unquotedSemicolons > 0) return false;
  if (maxParamIdx !== paramCount || seenParams.size !== paramCount) return false;
  return true;
}

/**
 * Single-pass SQL parameter interpolator used by `OfflinePgPool` and Simple Query fallback.
 */
export function interpolatePgSql(sql: string, params: readonly unknown[] = []): string {
  let out = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;
    const next = i + 1 < len ? sql[i + 1]! : "";

    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i + 2);
      if (nl === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, nl + 1);
      i = nl + 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      const start = i;
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
      out += sql.slice(start, i);
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
      out += sql.slice(start, i);
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
      out += sql.slice(start, i);
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
      out += sql.slice(start, i);
      continue;
    }

    if (ch === "$") {
      const tag = matchDollarQuoteTag(sql, i);
      if (tag) {
        const endIdx = sql.indexOf(tag, i + tag.length);
        if (endIdx === -1) {
          out += sql.slice(i);
          break;
        }
        out += sql.slice(i, endIdx + tag.length);
        i = endIdx + tag.length;
        continue;
      }

      if (next >= "1" && next <= "9") {
        let j = i + 1;
        while (j < len && sql[j]! >= "0" && sql[j]! <= "9") {
          j++;
        }
        const idx = Number(sql.slice(i + 1, j)) - 1;
        if (idx < 0 || idx >= params.length) {
          throw new RangeError(`Missing PostgreSQL parameter $${idx + 1}`);
        }
        out += formatPgLiteral(params[idx]);
        i = j;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

export class PgWireClient {
  private readonly options: PgConnectionOptions;
  private socket: Duplex | null = null;
  private tlsEncrypted = false;
  private rxBuffer: Buffer = Buffer.alloc(0);
  private pendingFrameHandler: ((type: string, payload: Buffer) => void) | null = null;
  private pendingRejecter: ((err: Error) => void) | null = null;
  private queryQueue: Promise<void> = Promise.resolve();
  private broken = false;
  private closed = false;
  private txDepth = 0;
  private savepointSeq = 0;

  constructor(options: PgConnectionOptions) {
    this.options = options;
  }

  isConnected(): boolean {
    return this.socket !== null && !this.broken && !this.closed;
  }

  isTlsEncrypted(): boolean {
    return this.tlsEncrypted;
  }

  isBroken(): boolean {
    return this.broken || this.closed;
  }

  private isSslRequested(): boolean {
    const ssl = this.options.ssl;
    if (!ssl || ssl === "disable") return false;
    return true;
  }

  private isSslRequired(): boolean {
    const ssl = this.options.ssl;
    return ssl === true || ssl === "require" || (typeof ssl === "object" && ssl !== null);
  }

  async connect(): Promise<void> {
    if (this.socket) return;

    // Negotiate TCP / optional SSLRequest -> TLS 1.3 upgrade first if not using a custom loopback stream
    let activeStream: Duplex;
    if (this.options.stream) {
      if (this.isSslRequested()) {
        activeStream = await this.negotiateSslOnStream(this.options.stream);
      } else {
        activeStream = this.options.stream;
      }
    } else {
      const rawTcp = await new Promise<Socket>((resolve, reject) => {
        const s = netConnect({ host: this.options.host, port: this.options.port }, () =>
          resolve(s)
        );
        s.once("error", reject);
      });
      rawTcp.removeAllListeners("error");

      if (this.isSslRequested()) {
        activeStream = await this.negotiateSslOnSocket(rawTcp);
      } else {
        activeStream = rawTcp;
      }
    }

    await this.performStartupHandshake(activeStream);
  }

  private async negotiateSslOnSocket(rawTcp: Socket): Promise<Duplex> {
    const responseByte = await new Promise<number>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        if (chunk.length > 0) {
          rawTcp.off("data", onData);
          rawTcp.off("error", onErr);
          if (chunk.length > 1) {
            this.rxBuffer = Buffer.concat([this.rxBuffer, chunk.subarray(1)]);
          }
          resolve(chunk[0]!);
        }
      };
      const onErr = (err: Error) => {
        rawTcp.off("data", onData);
        reject(err);
      };
      rawTcp.on("data", onData);
      rawTcp.once("error", onErr);
      rawTcp.write(buildSslRequestPacket());
    });

    if (responseByte === 0x53 /* 'S' */) {
      const customTlsOpts: TlsConnectionOptions =
        typeof this.options.ssl === "object" && this.options.ssl !== null
          ? this.options.ssl
          : {};
      return await new Promise<Duplex>((resolve, reject) => {
        const tlsSock = tlsConnect(
          {
            ...customTlsOpts,
            socket: rawTcp,
            servername: customTlsOpts.servername ?? this.options.host,
          },
          () => {
            this.tlsEncrypted = true;
            resolve(tlsSock);
          }
        );
        tlsSock.once("error", reject);
      });
    }

    if (responseByte === 0x4e /* 'N' */) {
      if (this.isSslRequired()) {
        rawTcp.destroy();
        throw new Error(
          "PostgreSQL server rejected required SSL/TLS upgrade (responded 'N' to SSLRequest)"
        );
      }
      this.tlsEncrypted = false;
      return rawTcp;
    }

    rawTcp.destroy();
    throw new Error(
      `Unexpected PostgreSQL SSLRequest response byte: 0x${responseByte.toString(16)}`
    );
  }

  private async negotiateSslOnStream(stream: Duplex): Promise<Duplex> {
    const responseByte = await new Promise<number>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        if (chunk.length > 0) {
          stream.off("data", onData);
          stream.off("error", onErr);
          if (chunk.length > 1) {
            this.rxBuffer = Buffer.concat([this.rxBuffer, chunk.subarray(1)]);
          }
          resolve(chunk[0]!);
        }
      };
      const onErr = (err: Error) => {
        stream.off("data", onData);
        reject(err);
      };
      stream.on("data", onData);
      stream.once("error", onErr);
      stream.write(buildSslRequestPacket());
    });

    if (responseByte === 0x53 /* 'S' */) {
      this.tlsEncrypted = true;
      return stream;
    }
    if (responseByte === 0x4e /* 'N' */ && !this.isSslRequired()) {
      this.tlsEncrypted = false;
      return stream;
    }
    throw new Error("PostgreSQL stream rejected required SSL/TLS upgrade");
  }

  private async performStartupHandshake(sock: Duplex): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        this.broken = true;
        const activeRejecter = this.pendingRejecter;
        this.pendingFrameHandler = null;
        this.pendingRejecter = null;
        if (!settled) {
          settled = true;
          reject(err);
        } else if (activeRejecter) {
          activeRejecter(err);
        }
      };

      this.socket = sock;
      sock.on("error", (err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });
      sock.on("close", () => {
        this.broken = true;
        if (!settled) {
          settled = true;
          reject(new Error("PostgreSQL connection closed during handshake"));
        } else if (this.pendingRejecter) {
          const rej = this.pendingRejecter;
          this.pendingRejecter = null;
          this.pendingFrameHandler = null;
          rej(new Error("PostgreSQL connection closed unexpectedly"));
        }
      });

      sock.on("data", (chunk: Buffer) => {
        this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
        this.drainFrames();
      });

      let scramClientFirstBare = "";
      let scramClientNonce = "";

      this.pendingRejecter = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      this.pendingFrameHandler = (type, payload) => {
        if (type === "R") {
          const authCode = payload.readInt32BE(0);
          if (authCode === 0 || authCode === 12) {
            return;
          }
          if (authCode === 3) {
            const pwd = Buffer.from(`${this.options.password ?? ""}\0`, "utf8");
            sock.write(buildFrontendFrame("p", pwd));
            return;
          }
          if (authCode === 5) {
            const salt = payload.subarray(4, 8);
            const inner = md5Hex(`${this.options.password ?? ""}${this.options.user}`);
            const outer =
              "md5" + md5Hex(Buffer.concat([Buffer.from(inner, "ascii"), salt]));
            sock.write(buildFrontendFrame("p", Buffer.from(`${outer}\0`, "utf8")));
            return;
          }
          if (authCode === 10) {
            scramClientNonce = randomBytes(18).toString("base64");
            scramClientFirstBare = `n=*,r=${scramClientNonce}`;
            const clientFirstMsg = Buffer.from(`n,,${scramClientFirstBare}`, "utf8");
            const mech = Buffer.from("SCRAM-SHA-256\0", "utf8");
            const lenBuf = Buffer.alloc(4);
            lenBuf.writeInt32BE(clientFirstMsg.length, 0);
            sock.write(
              buildFrontendFrame("p", Buffer.concat([mech, lenBuf, clientFirstMsg]))
            );
            return;
          }
          if (authCode === 11) {
            const serverFirstStr = payload.subarray(4).toString("utf8");
            const attrs: Record<string, string> = {};
            for (const part of serverFirstStr.split(",")) {
              const eqIdx = part.indexOf("=");
              if (eqIdx > 0) {
                attrs[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
              }
            }
            const combinedNonce = attrs["r"] ?? "";
            const saltBuf = Buffer.from(attrs["s"] ?? "", "base64");
            const iterations = Number(attrs["i"] ?? "4096");
            const saltedPassword = pbkdf2Sync(
              this.options.password ?? "",
              saltBuf,
              iterations,
              32,
              "sha256"
            );
            const clientKey = createHmac("sha256", saltedPassword)
              .update("Client Key", "utf8")
              .digest();
            const storedKey = createHash("sha256").update(clientKey).digest();
            const clientFinalWithoutProof = `c=biws,r=${combinedNonce}`;
            const authMessage = `${scramClientFirstBare},${serverFirstStr},${clientFinalWithoutProof}`;
            const clientSignature = createHmac("sha256", storedKey)
              .update(authMessage, "utf8")
              .digest();
            const clientProof = Buffer.alloc(clientKey.length);
            for (let i = 0; i < clientKey.length; i++) {
              clientProof[i] = clientKey[i]! ^ clientSignature[i]!;
            }
            const clientFinalMsg = `${clientFinalWithoutProof},p=${clientProof.toString("base64")}`;
            sock.write(buildFrontendFrame("p", Buffer.from(clientFinalMsg, "utf8")));
            return;
          }
        } else if (type === "E") {
          this.pendingFrameHandler = null;
          this.pendingRejecter = null;
          this.broken = true;
          if (!settled) {
            settled = true;
            reject(new Error(`PostgreSQL Handshake Error: ${payload.toString("utf8")}`));
          }
        } else if (type === "Z") {
          this.pendingFrameHandler = null;
          this.pendingRejecter = null;
          if (!settled) {
            settled = true;
            resolve();
          }
        }
      };

      queueMicrotask(() => {
        sock.write(
          buildStartupPacket({
            user: this.options.user,
            database: this.options.database,
            application_name: "super-ecommerce",
            client_encoding: "UTF8",
          })
        );
      });
    });
  }

  private drainFrames(): void {
    while (this.rxBuffer.length >= 5) {
      const type = String.fromCharCode(this.rxBuffer[0]!);
      const frameLen = this.rxBuffer.readInt32BE(1);
      if (this.rxBuffer.length < 1 + frameLen) {
        return;
      }
      const payload = this.rxBuffer.subarray(5, 1 + frameLen);
      this.rxBuffer = this.rxBuffer.subarray(1 + frameLen);
      if (this.pendingFrameHandler) {
        this.pendingFrameHandler(type, payload);
      }
    }
  }

  async query<TRow = Record<string, string | null>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PgQueryResult<TRow>> {
    const run = async (): Promise<PgQueryResult<TRow>> => {
      const sock = this.socket;
      if (!sock || this.broken || this.closed) {
        throw new Error("PgWireClient is not connected");
      }

      const preferredMode = this.options.queryMode ?? "extended";
      const useExtended =
        preferredMode === "extended" && canUseExtendedProtocol(sql, params.length);
      const outboundFrame = useExtended
        ? buildExtendedQueryPipeline(sql, params)
        : buildFrontendFrame(
            "Q",
            Buffer.from(
              `${params.length > 0 ? interpolatePgSql(sql, params) : sql}\0`,
              "utf8"
            )
          );

      return await new Promise<PgQueryResult<TRow>>((resolve, reject) => {
        let columns: string[] = [];
        const rows: TRow[] = [];
        let commandTag = "";
        let queryError: Error | null = null;
        let settled = false;

        this.pendingRejecter = (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };

        this.pendingFrameHandler = (type, payload) => {
          // '1' = ParseComplete, '2' = BindComplete, 'n' = NoData (Extended Query Protocol)
          if (type === "1" || type === "2" || type === "n") {
            return;
          }
          if (type === "T") {
            const fieldCount = payload.readInt16BE(0);
            let offset = 2;
            columns = [];
            for (let i = 0; i < fieldCount; i++) {
              const nulIdx = payload.indexOf(0, offset);
              const colName = payload.toString("utf8", offset, nulIdx);
              columns.push(colName);
              offset = nulIdx + 1 + 18;
            }
          } else if (type === "D") {
            const colCount = payload.readInt16BE(0);
            let offset = 2;
            const rowObj: Record<string, string | null> = {};
            for (let i = 0; i < colCount; i++) {
              const colLen = payload.readInt32BE(offset);
              offset += 4;
              const colName = columns[i] ?? `col_${i}`;
              if (colLen === -1) {
                rowObj[colName] = null;
              } else {
                rowObj[colName] = payload.toString("utf8", offset, offset + colLen);
                offset += colLen;
              }
            }
            rows.push(rowObj as TRow);
          } else if (type === "C") {
            const nulIdx = payload.indexOf(0);
            commandTag = payload.toString(
              "utf8",
              0,
              nulIdx >= 0 ? nulIdx : payload.length
            );
          } else if (type === "E") {
            queryError = new Error(
              `PostgreSQL Query Error: ${payload.toString("utf8").replace(/\0/g, " ")}`
            );
          } else if (type === "Z") {
            this.pendingFrameHandler = null;
            this.pendingRejecter = null;
            if (!settled) {
              settled = true;
              if (queryError) {
                reject(queryError);
              } else {
                resolve({ commandTag, rows });
              }
            }
          }
        };

        try {
          sock.write(outboundFrame);
        } catch (err) {
          this.pendingFrameHandler = null;
          this.pendingRejecter = null;
          this.broken = true;
          if (!settled) {
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });
    };

    const next = this.queryQueue.then(run, run);
    this.queryQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async withTransaction<T>(fn: (tx: PgWireClient) => Promise<T>): Promise<T> {
    if (this.txDepth > 0) {
      const sp = `sp_${this.txDepth}_${++this.savepointSeq}`;
      await this.query(`SAVEPOINT ${sp}`);
      this.txDepth++;
      try {
        const result = await fn(this);
        await this.query(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        await this.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
        await this.query(`RELEASE SAVEPOINT ${sp}`).catch(() => {});
        throw err;
      } finally {
        this.txDepth--;
      }
    }

    await this.query("BEGIN");
    this.txDepth = 1;
    try {
      const result = await fn(this);
      await this.query("COMMIT");
      return result;
    } catch (err) {
      await this.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const sock = this.socket;
    if (!sock) return;
    this.socket = null;
    try {
      sock.write(buildFrontendFrame("X", Buffer.alloc(0)));
    } catch {
      // ignore closed socket
    }
    sock.end();
  }
}

/**
 * Creates an in-process PostgreSQL v3 Wire Protocol (`0x00030000`) Duplex transport supporting:
 * - `SSLRequest` (`0x04d2162f`) negotiation (`sslSupported` option -> `'S'` or `'N'`)
 * - `StartupMessage` / `AuthenticationOk` handshake
 * - Both Simple Query (`'Q'`) AND Extended Query (`'P'/'B'/'D'/'E'/'S'`) framing!
 */
export function createLoopbackPgWireStream(
  onQuery: (
    sql: string,
    boundParams?: readonly (string | null)[]
  ) => {
    commandTag: string;
    columns: readonly string[];
    rows: readonly (readonly (string | null)[])[];
  },
  options?: { readonly sslSupported?: boolean }
): Duplex {
  const encodeBackendFrame = (type: string, payload: Buffer): Buffer => {
    const header = Buffer.alloc(5);
    header.write(type, 0, 1, "ascii");
    header.writeInt32BE(payload.length + 4, 1);
    return Buffer.concat([header, payload]);
  };

  let startupDone = false;
  let parsedSql = "";
  let boundParams: (string | null)[] = [];
  let buf = Buffer.alloc(0);

  const emitQueryResultFrames = (
    sql: string,
    params: readonly (string | null)[] | undefined,
    isExtended: boolean
  ): Buffer => {
    const frames: Buffer[] = [];
    if (isExtended) {
      frames.push(encodeBackendFrame("1", Buffer.alloc(0))); // ParseComplete
      frames.push(encodeBackendFrame("2", Buffer.alloc(0))); // BindComplete
    }
    try {
      const res = onQuery(sql, params);
      if (res.columns.length > 0) {
        const colParts: Buffer[] = [];
        const countBuf = Buffer.alloc(2);
        countBuf.writeInt16BE(res.columns.length, 0);
        colParts.push(countBuf);
        for (const col of res.columns) {
          colParts.push(Buffer.from(`${col}\0`, "utf8"));
          colParts.push(Buffer.alloc(18));
        }
        frames.push(encodeBackendFrame("T", Buffer.concat(colParts)));

        for (const row of res.rows) {
          const rowParts: Buffer[] = [];
          const rCount = Buffer.alloc(2);
          rCount.writeInt16BE(row.length, 0);
          rowParts.push(rCount);
          for (const cell of row) {
            if (cell === null) {
              const nullLen = Buffer.alloc(4);
              nullLen.writeInt32BE(-1, 0);
              rowParts.push(nullLen);
            } else {
              const cellBuf = Buffer.from(cell, "utf8");
              const lenBuf = Buffer.alloc(4);
              lenBuf.writeInt32BE(cellBuf.length, 0);
              rowParts.push(lenBuf, cellBuf);
            }
          }
          frames.push(encodeBackendFrame("D", Buffer.concat(rowParts)));
        }
      } else if (isExtended) {
        frames.push(encodeBackendFrame("n", Buffer.alloc(0))); // NoData
      }

      frames.push(
        encodeBackendFrame("C", Buffer.from(`${res.commandTag}\0`, "utf8")),
        encodeBackendFrame("Z", Buffer.from("I", "ascii"))
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errPayload = Buffer.from(`SERROR\0C42000\0M${msg}\0\0`, "utf8");
      frames.push(
        encodeBackendFrame("E", errPayload),
        encodeBackendFrame("Z", Buffer.from("I", "ascii"))
      );
    }
    return Buffer.concat(frames);
  };

  const duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      buf = Buffer.concat([buf, chunk]);

      while (!startupDone && buf.length >= 8) {
        const pktLen = buf.readInt32BE(0);
        const code = buf.readInt32BE(4);
        if (pktLen === 8 && code === 80877103) {
          // SSLRequest packet
          buf = buf.subarray(8);
          duplex.push(Buffer.from(options?.sslSupported ? "S" : "N", "ascii"));
          continue;
        }
        if (buf.length >= pktLen) {
          buf = buf.subarray(pktLen);
          startupDone = true;
          const authOk = Buffer.alloc(4);
          authOk.writeInt32BE(0, 0);
          const ready = Buffer.from("I", "ascii");
          duplex.push(
            Buffer.concat([
              encodeBackendFrame("R", authOk),
              encodeBackendFrame("Z", ready),
            ])
          );
        } else {
          break;
        }
      }

      while (startupDone && buf.length >= 5) {
        const type = String.fromCharCode(buf[0]!);
        const len = buf.readInt32BE(1);
        if (buf.length < 1 + len) break;
        const payload = buf.subarray(5, 1 + len);
        buf = buf.subarray(1 + len);

        if (type === "X") {
          duplex.push(null);
          break;
        }
        if (type === "Q") {
          const nulIdx = payload.indexOf(0);
          const sql = payload.toString("utf8", 0, nulIdx >= 0 ? nulIdx : payload.length);
          duplex.push(emitQueryResultFrames(sql, undefined, false));
        } else if (type === "P") {
          const stmtEnd = payload.indexOf(0);
          const sqlEnd = payload.indexOf(0, stmtEnd + 1);
          parsedSql = payload.toString("utf8", stmtEnd + 1, sqlEnd);
        } else if (type === "B") {
          let off = payload.indexOf(0) + 1; // portal
          off = payload.indexOf(0, off) + 1; // stmt
          const fmtCount = payload.readInt16BE(off);
          off += 2 + fmtCount * 2;
          const paramCount = payload.readInt16BE(off);
          off += 2;
          boundParams = [];
          for (let p = 0; p < paramCount; p++) {
            const pLen = payload.readInt32BE(off);
            off += 4;
            if (pLen === -1) {
              boundParams.push(null);
            } else {
              boundParams.push(payload.toString("utf8", off, off + pLen));
              off += pLen;
            }
          }
        } else if (type === "S") {
          duplex.push(emitQueryResultFrames(parsedSql, boundParams, true));
          parsedSql = "";
          boundParams = [];
        }
      }

      callback();
    },
  });

  return duplex;
}
