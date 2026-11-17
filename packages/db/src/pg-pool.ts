/**
 * Bounded PostgreSQL Connection Pool & Transaction Seam (`packages/db/src/pg-pool.ts`).
 *
 * Implements `supabase-postgres-best-practices`:
 * - Bounded connection pooling (`maxConnections`, default 10)
 * - Short transaction timeouts (`statement_timeout`, default 15s)
 * - Exclusive connection leasing across `withTransaction` (`BEGIN` / `COMMIT` / `ROLLBACK`)
 * - Nested transaction support via `SAVEPOINT` / `RELEASE SAVEPOINT` / `ROLLBACK TO SAVEPOINT`
 */

import {
  PgWireClient,
  type PgConnectionOptions,
  type PgQueryResult,
} from "./pg-wire-driver.ts";

export interface PgQueryable {
  query<TRow = Record<string, string | null>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<PgQueryResult<TRow>>;
}

export interface PgTxClient extends PgQueryable {
  withTransaction<T>(fn: (tx: PgTxClient) => Promise<T>): Promise<T>;
}

export interface PgPoolLike extends PgQueryable {
  withTransaction<T>(fn: (tx: PgTxClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PgPoolOptions {
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
  readonly maxConnections?: number;
  readonly statementTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly createClient?: (opts: PgConnectionOptions) => PgWireClient;
}

export interface PgPoolStats {
  readonly totalConnections: number;
  readonly idleConnections: number;
  readonly activeConnections: number;
  readonly waitingRequests: number;
  readonly maxConnections: number;
}

export function resolvePgConfigFromEnv(
  overrides?: Partial<PgConnectionOptions>
): PgConnectionOptions {
  return {
    host: overrides?.host ?? process.env["SUPER_PG_HOST"] ?? "127.0.0.1",
    port: overrides?.port ?? Number(process.env["SUPER_PG_PORT"] ?? "5438"),
    user: overrides?.user ?? process.env["SUPER_PG_USER"] ?? "super",
    password: overrides?.password ?? process.env["SUPER_PG_PASSWORD"] ?? "superpassword",
    database: overrides?.database ?? process.env["SUPER_PG_DB"] ?? "super_ecommerce",
    stream: overrides?.stream,
  };
}

interface PooledEntry {
  readonly client: PgWireClient;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface Waiter {
  resolve: (entry: PooledEntry) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class PgPool implements PgPoolLike {
  private readonly connOptions: PgConnectionOptions;
  private readonly maxConnections: number;
  private readonly statementTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly createClient: (opts: PgConnectionOptions) => PgWireClient;

  private readonly idle: PooledEntry[] = [];
  private readonly active = new Set<PooledEntry>();
  private readonly waiters: Waiter[] = [];
  private pendingCreates = 0;
  private closed = false;

  constructor(options: PgPoolOptions = {}) {
    this.connOptions = resolvePgConfigFromEnv(options);
    this.maxConnections = Math.max(1, options.maxConnections ?? 10);
    this.statementTimeoutMs = Math.max(0, options.statementTimeoutMs ?? 15_000);
    this.idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? 30_000);
    this.acquireTimeoutMs = Math.max(0, options.acquireTimeoutMs ?? 10_000);
    this.createClient =
      options.createClient ?? ((opts) => new PgWireClient(opts));
  }

  static fromEnv(overrides?: Partial<PgPoolOptions>): PgPool {
    return new PgPool(overrides);
  }

  getStats(): PgPoolStats {
    const total = this.idle.length + this.active.size + this.pendingCreates;
    return {
      totalConnections: total,
      idleConnections: this.idle.length,
      activeConnections: this.active.size,
      waitingRequests: this.waiters.length,
      maxConnections: this.maxConnections,
    };
  }

  private clearIdleTimer(entry: PooledEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private scheduleIdleEviction(entry: PooledEntry): void {
    this.clearIdleTimer(entry);
    if (this.idleTimeoutMs <= 0 || this.closed) return;
    entry.idleTimer = setTimeout(() => {
      const idx = this.idle.indexOf(entry);
      if (idx !== -1) {
        this.idle.splice(idx, 1);
        void entry.client.close().catch(() => {});
      }
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  private async openFreshEntry(): Promise<PooledEntry> {
    this.pendingCreates++;
    try {
      const client = this.createClient(this.connOptions);
      await client.connect();
      if (this.statementTimeoutMs > 0) {
        await client.query(`SET statement_timeout = ${Math.floor(this.statementTimeoutMs)}`);
      }
      return { client, idleTimer: null };
    } finally {
      this.pendingCreates--;
    }
  }

  private async acquire(): Promise<PooledEntry> {
    if (this.closed) {
      throw new Error("PgPool is closed");
    }

    while (this.idle.length > 0) {
      const entry = this.idle.pop()!;
      this.clearIdleTimer(entry);
      if (entry.client.isConnected()) {
        this.active.add(entry);
        return entry;
      }
      await entry.client.close().catch(() => {});
    }

    const inFlightTotal = this.idle.length + this.active.size + this.pendingCreates;
    if (inFlightTotal < this.maxConnections) {
      const entry = await this.openFreshEntry();
      if (this.closed) {
        await entry.client.close().catch(() => {});
        throw new Error("PgPool is closed");
      }
      this.active.add(entry);
      return entry;
    }

    return await new Promise<PooledEntry>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: null,
      };
      if (this.acquireTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) {
            this.waiters.splice(idx, 1);
          }
          reject(
            new Error(
              `PgPool acquire timeout after ${this.acquireTimeoutMs}ms (maxConnections=${this.maxConnections})`
            )
          );
        }, this.acquireTimeoutMs);
        waiter.timer.unref?.();
      }
      this.waiters.push(waiter);
    });
  }

  private release(entry: PooledEntry, discard = false): void {
    this.active.delete(entry);

    if (discard || this.closed || !entry.client.isConnected()) {
      this.clearIdleTimer(entry);
      void entry.client.close().catch(() => {});
      this.maybeSatisfyNextWaiterWithNewConn();
      return;
    }

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      this.active.add(entry);
      waiter.resolve(entry);
      return;
    }

    this.idle.push(entry);
    this.scheduleIdleEviction(entry);
  }

  private maybeSatisfyNextWaiterWithNewConn(): void {
    if (this.closed || this.waiters.length === 0) return;
    const total = this.idle.length + this.active.size + this.pendingCreates;
    if (total >= this.maxConnections) return;
    const waiter = this.waiters.shift();
    if (!waiter) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    void this.openFreshEntry()
      .then((entry) => {
        if (this.closed) {
          void entry.client.close().catch(() => {});
          waiter.reject(new Error("PgPool is closed"));
          return;
        }
        this.active.add(entry);
        waiter.resolve(entry);
      })
      .catch((err) => {
        waiter.reject(err instanceof Error ? err : new Error(String(err)));
      });
  }

  async query<TRow = Record<string, string | null>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PgQueryResult<TRow>> {
    const entry = await this.acquire();
    let discard = false;
    try {
      return await entry.client.query<TRow>(sql, params);
    } catch (err) {
      if (entry.client.isBroken()) {
        discard = true;
      }
      throw err;
    } finally {
      this.release(entry, discard);
    }
  }

  async withTransaction<T>(fn: (tx: PgTxClient) => Promise<T>): Promise<T> {
    const entry = await this.acquire();
    let discard = false;
    try {
      const txClient: PgTxClient = {
        query: <TRow = Record<string, string | null>>(
          sql: string,
          params: readonly unknown[] = []
        ) => entry.client.query<TRow>(sql, params),
        withTransaction: <TInner>(
          innerFn: (innerTx: PgTxClient) => Promise<TInner>
        ) => entry.client.withTransaction(() => innerFn(txClient)),
      };
      return await entry.client.withTransaction(() => fn(txClient));
    } catch (err) {
      if (entry.client.isBroken()) {
        discard = true;
      }
      throw err;
    } finally {
      this.release(entry, discard);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error("PgPool closed while waiting for connection"));
    }
    const toClose = [...this.idle];
    this.idle.length = 0;
    await Promise.all(
      toClose.map((entry) => {
        this.clearIdleTimer(entry);
        return entry.client.close().catch(() => {});
      })
    );
  }
}
