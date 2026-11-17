/**
 * Versioned PostgreSQL Migration Runner (`packages/db/src/migrator.ts`).
 *
 * Scans `packages/db/migrations/*.sql`, tracks applied versions in `schema_migrations`,
 * validates SHA-256 checksums, and executes each unapplied migration atomically inside
 * `pool.withTransaction(...)`.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgPoolLike } from "./pg-pool.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = join(__dirname, "../migrations");

export interface MigrationDescriptor {
  readonly version: string;
  readonly name: string;
  readonly filename: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface MigrationRunReport {
  readonly appliedVersions: readonly string[];
  readonly alreadyAppliedVersions: readonly string[];
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function stripOuterTransactionWrapper(sql: string): string {
  const trimmed = sql.trim();
  const withoutBegin = trimmed.replace(/^(?:--[^\n]*\n|\s)*BEGIN\s*;\s*/i, "");
  return withoutBegin.replace(/\s*COMMIT\s*;\s*(?:--[^\n]*\n|\s)*$/i, "").trim();
}

export function loadMigrationDescriptors(
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR
): readonly MigrationDescriptor[] {
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/i.test(f))
    .sort((a, b) => a.localeCompare(b));

  return files.map((filename) => {
    const match = filename.match(/^(\d+)_(.+)\.sql$/i);
    if (!match) {
      throw new Error(`Invalid migration filename: ${filename}`);
    }
    const version = match[1]!;
    const name = match[2]!;
    const rawSql = readFileSync(join(migrationsDir, filename), "utf8");
    return {
      version,
      name,
      filename,
      checksum: sha256Hex(rawSql),
      sql: stripOuterTransactionWrapper(rawSql),
    };
  });
}

export async function runMigrations(
  pool: PgPoolLike,
  options?: {
    readonly migrationsDir?: string;
    readonly ignoreChecksumMismatch?: boolean;
  }
): Promise<MigrationRunReport> {
  const descriptors = loadMigrationDescriptors(
    options?.migrationsDir ?? DEFAULT_MIGRATIONS_DIR
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const appliedRes = await pool.query<{ version: string; checksum: string }>(
    `SELECT version, checksum FROM schema_migrations ORDER BY version ASC`
  );
  const appliedMap = new Map(appliedRes.rows.map((r) => [r.version, r.checksum]));

  const appliedVersions: string[] = [];
  const alreadyAppliedVersions: string[] = [];

  for (const mig of descriptors) {
    const existingChecksum = appliedMap.get(mig.version);
    if (existingChecksum !== undefined) {
      if (
        existingChecksum !== mig.checksum &&
        !options?.ignoreChecksumMismatch
      ) {
        throw new Error(
          `Migration checksum mismatch for ${mig.filename} (version ${mig.version}): expected ${existingChecksum}, found ${mig.checksum}`
        );
      }
      alreadyAppliedVersions.push(mig.version);
      continue;
    }

    await pool.withTransaction(async (tx) => {
      if (mig.sql.length > 0) {
        await tx.query(mig.sql);
      }
      await tx.query(
        `INSERT INTO schema_migrations (version, name, checksum)
         VALUES ($1, $2, $3)
         ON CONFLICT (version) DO NOTHING`,
        [mig.version, mig.name, mig.checksum]
      );
    });

    appliedVersions.push(mig.version);
  }

  return {
    appliedVersions,
    alreadyAppliedVersions,
  };
}
