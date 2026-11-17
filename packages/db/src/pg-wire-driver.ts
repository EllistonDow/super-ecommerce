/**
 * Zero-Dependency PostgreSQL v3 Wire Protocol Driver (`packages/db/src/pg-wire-driver.ts`).
 *
 * Implements the official PostgreSQL Frontend/Backend Protocol v3.0 (protocol version 196608 / `0x00030000`)
 * directly over `node:net` TCP sockets or Duplex byte streams:
 * - StartupMessage (`0x00030000`) with `user`, `database`, `application_name`
 * - AuthenticationOk (0), CleartextPassword (3), MD5Password (5), SASL/SCRAM-SHA-256 (10/11/12)
 * - Simple & Parameter-interpolated Query (`'Q'`), RowDescription (`'T'`), DataRow (`'D'`),
 *   CommandComplete (`'C'`), ErrorResponse (`'E'`), and ReadyForQuery (`'Z'`)
 * - Per-client query serialization mutex, socket lifecycle cleanup, and SAVEPOINT-aware `withTransaction`
 */

import { connect } from "node:net";
import { Duplex } from "node:stream";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { serializeWithBigInt } from "./bigint-json.ts";

export interface PgConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password?: string;
  readonly database: string;
  readonly stream?: Duplex;
}

export interface PgQueryResult<TRow = Record<string, string | null>> {
  readonly commandTag: string;
  readonly rows: readonly TRow[];
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
 * Single-pass SQL parameter interpolator that respects `'...'`, `E'...'`, `"..."`,
 * `--` comments, nested `/* ... * /` comments, and `$tag$...$tag$` dollar-quoted blocks.
 */
export function interpolatePgSql(sql: string, params: readonly unknown[] = []): string {
  let out = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;
    const next = i + 1 < len ? sql[i + 1]! : "";

    // Line comment: -- ... \n
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

    // Block comment (supports PostgreSQL nesting): /* ... */
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

    // Escape string literal: E'...' or e'...'
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

    // Standard single-quoted string literal: '...'
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

    // Quoted identifier: "..."
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

    // Dollar-quoted literal: $$...$$ or $tag$...$tag$
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

      // Positional parameter: $1, $2, ...
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

  isBroken(): boolean {
    return this.broken || this.closed;
  }

  async connect(): Promise<void> {
    if (this.socket) return;
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

      const sendStartup = (sock: Duplex) => {
        sock.write(
          buildStartupPacket({
            user: this.options.user,
            database: this.options.database,
            application_name: "super-ecommerce",
            client_encoding: "UTF8",
          })
        );
      };

      const sock: Duplex =
        this.options.stream ??
        connect({ host: this.options.host, port: this.options.port }, () => {
          sendStartup(sock);
        });

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
            // SASL Initial Response (SCRAM-SHA-256)
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
            // SASL Continue
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

      if (this.options.stream) {
        queueMicrotask(() => sendStartup(sock));
      }
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

      const finalSql = params.length > 0 ? interpolatePgSql(sql, params) : sql;

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
          sock.write(buildFrontendFrame("Q", Buffer.from(`${finalSql}\0`, "utf8")));
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
 * Creates an in-process PostgreSQL v3 Wire Protocol (0x00030000) Duplex transport for testing
 * `PgWireClient` packet framing, Startup/AuthenticationOk handshake, RowDescription/DataRow
 * decoding, and `SELECT ... FOR UPDATE SKIP LOCKED` transactions without opening OS ports.
 */
export function createLoopbackPgWireStream(
  onQuery: (sql: string) => {
    commandTag: string;
    columns: readonly string[];
    rows: readonly (readonly (string | null)[])[];
  }
): Duplex {
  const encodeBackendFrame = (type: string, payload: Buffer): Buffer => {
    const header = Buffer.alloc(5);
    header.write(type, 0, 1, "ascii");
    header.writeInt32BE(payload.length + 4, 1);
    return Buffer.concat([header, payload]);
  };

  let startupDone = false;
  let buf = Buffer.alloc(0);

  const duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      buf = Buffer.concat([buf, chunk]);

      if (!startupDone) {
        if (buf.length >= 8) {
          const startupLen = buf.readInt32BE(0);
          if (buf.length >= startupLen) {
            buf = buf.subarray(startupLen);
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
          }
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
          const frames: Buffer[] = [];
          try {
            const res = onQuery(sql);
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
          duplex.push(Buffer.concat(frames));
        }
      }

      callback();
    },
  });

  return duplex;
}
