/**
 * `@super-ecommerce/core` — PostgreSQL 17 Dynamic Role-Based Access Control (RBAC)
 * & Immutable Audit Log Service.
 *
 * Invariants:
 * - Direct execution on PostgreSQL 17 `admin_roles`, `admin_users`, and `admin_audit_logs`.
 * - Constant-time HMAC-SHA256 password hash comparison (`timingSafeEqual`) to prevent timing side-channels.
 * - Dynamic permission resolution: permissions are queried from `admin_roles` in PostgreSQL,
 *   allowing real-time permission revocation and custom role creation.
 * - Append-only transactional audit trail persisted to `admin_audit_logs` for every authentication
 *   and authorization attempt (both ALLOW and 401/403 DENY decisions).
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PgPoolLike, PgTxClient } from "@super-ecommerce/db";
import {
  type AdminPermission,
  type AdminPrincipal,
  type AdminRole,
  type AdminSessionClaims,
  type AdminRbacAuditEntry,
  ROLE_PERMISSION_MATRIX,
  SEEDED_ADMIN_ACCOUNTS,
} from "./admin-auth-rbac.ts";

export interface AdminRoleRecord {
  readonly roleSlug: string;
  readonly displayName: string;
  readonly description: string;
  readonly permissions: readonly AdminPermission[];
  readonly isSystem: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminUserRecord {
  readonly adminId: string;
  readonly email: string;
  readonly displayName: string;
  readonly roleSlug: string;
  readonly scopeSummary: string;
  readonly isActive: boolean;
  readonly permissions: readonly AdminPermission[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAdminRoleInput {
  readonly roleSlug: string;
  readonly displayName: string;
  readonly description?: string;
  readonly permissions: readonly AdminPermission[];
  readonly isSystem?: boolean;
}

export interface CreateAdminUserInput {
  readonly adminId?: string;
  readonly email: string;
  readonly displayName: string;
  readonly roleSlug: string;
  readonly passwordPlain: string;
  readonly scopeSummary?: string;
}

export interface AdminAuditLogRecord {
  readonly id: string;
  readonly actorId: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly details: Record<string, unknown>;
  readonly createdAt: string;
}

const PASSWORD_PEPPER = "kronos_super_ecommerce_pwd_pepper_2026";

function hashPasswordHex(email: string, password: string): string {
  return createHmac("sha256", PASSWORD_PEPPER)
    .update(`${email.toLowerCase().trim()}:${password}`)
    .digest("hex");
}

function constantTimeHexEqual(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  const bufA = Buffer.from(aHex, "utf8");
  const bufB = Buffer.from(bHex, "utf8");
  return timingSafeEqual(bufA, bufB);
}

export class PgAdminAuthRbacService {
  private readonly pgPool: PgPoolLike;
  private readonly signingSecret: string;
  private readonly sessionTtlSeconds: number;

  constructor(
    pgPool: PgPoolLike,
    options?: { signingSecret?: string; sessionTtlSeconds?: number }
  ) {
    this.pgPool = pgPool;
    this.signingSecret =
      options?.signingSecret ??
      process.env["SUPER_ADMIN_SESSION_SECRET"] ??
      "super_admin_hmac_session_secret_2026_v1";
    this.sessionTtlSeconds = options?.sessionTtlSeconds ?? 8 * 3600;
  }

  private async runInTx<T>(
    tx: PgTxClient | undefined,
    callback: (client: PgTxClient) => Promise<T>
  ): Promise<T> {
    return tx ? tx.withTransaction(callback) : this.pgPool.withTransaction(callback);
  }

  /**
   * Seeds system roles (SUPER_ADMIN, MERCHANT_OPS, FINANCE_AUDITOR) and seeded admin accounts
   * into PostgreSQL if not already present.
   */
  async seedInitialRolesAndUsers(tx?: PgTxClient): Promise<void> {
    const nowIso = new Date().toISOString();

    await this.runInTx(tx, async (q) => {
      // 1. Seed Roles
      const systemRoles: CreateAdminRoleInput[] = [
        {
          roleSlug: "SUPER_ADMIN",
          displayName: "Super Administrator",
          description: "Full platform permissions: Configurator DAG, chaos faults, MSI routing, sagas",
          permissions: ROLE_PERMISSION_MATRIX.SUPER_ADMIN,
          isSystem: true,
        },
        {
          roleSlug: "MERCHANT_OPS",
          displayName: "Merchant Operations",
          description: "Store operations: MSI routing, order fulfillment sagas, diagnostic tools",
          permissions: ROLE_PERMISSION_MATRIX.MERCHANT_OPS,
          isSystem: true,
        },
        {
          roleSlug: "FINANCE_AUDITOR",
          displayName: "Finance Auditor",
          description: "Audit & compliance: price waterfall verification, Stripe webhooks, read-only analytics",
          permissions: ROLE_PERMISSION_MATRIX.FINANCE_AUDITOR,
          isSystem: true,
        },
      ];

      for (const r of systemRoles) {
        await q.query(
          `INSERT INTO admin_roles (
            role_slug, display_name, description, permissions_json, is_system, created_at, updated_at
          ) VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz)
          ON CONFLICT (role_slug) DO UPDATE
          SET permissions_json = $4::jsonb,
              updated_at = $7::timestamptz`,
          [
            r.roleSlug,
            r.displayName,
            r.description ?? "",
            JSON.stringify(r.permissions),
            r.isSystem ?? false,
            nowIso,
            nowIso,
          ]
        );
      }

      // 2. Seed Users
      for (const acc of SEEDED_ADMIN_ACCOUNTS) {
        await q.query(
          `INSERT INTO admin_users (
            admin_id, email, display_name, role_slug, password_hash, scope_summary, is_active, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)
          ON CONFLICT (email) DO UPDATE
          SET display_name = $3,
              role_slug = $4,
              password_hash = $5,
              scope_summary = $6,
              updated_at = $9::timestamptz`,
          [
            acc.userId,
            acc.email.toLowerCase().trim(),
            acc.displayName,
            acc.role,
            acc.passwordDigestHex,
            acc.scopeSummary,
            true,
            nowIso,
            nowIso,
          ]
        );
      }
    });
  }

  async listRoles(tx?: PgTxClient): Promise<readonly AdminRoleRecord[]> {
    return await this.runInTx(tx, async (q) => {
      const res = await q.query<{
        role_slug: string;
        display_name: string;
        description: string;
        permissions_json: string | readonly AdminPermission[];
        is_system: boolean;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT role_slug, display_name, description, permissions_json, is_system, created_at, updated_at
         FROM admin_roles
         ORDER BY is_system DESC, role_slug ASC`
      );

      return res.rows.map((row) => ({
        roleSlug: row.role_slug,
        displayName: row.display_name,
        description: row.description,
        permissions:
          typeof row.permissions_json === "string"
            ? JSON.parse(row.permissions_json)
            : row.permissions_json,
        isSystem: Boolean(row.is_system),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    });
  }

  async createOrUpdateRole(
    input: CreateAdminRoleInput,
    tx?: PgTxClient
  ): Promise<AdminRoleRecord> {
    const nowIso = new Date().toISOString();
    return await this.runInTx(tx, async (q) => {
      await q.query(
        `INSERT INTO admin_roles (
          role_slug, display_name, description, permissions_json, is_system, created_at, updated_at
        ) VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz)
        ON CONFLICT (role_slug) DO UPDATE
        SET display_name = $2,
            description = $3,
            permissions_json = $4::jsonb,
            updated_at = $7::timestamptz`,
        [
          input.roleSlug.toUpperCase().trim(),
          input.displayName.trim(),
          input.description ?? "",
          JSON.stringify(input.permissions),
          input.isSystem ?? false,
          nowIso,
          nowIso,
        ]
      );

      return {
        roleSlug: input.roleSlug.toUpperCase().trim(),
        displayName: input.displayName.trim(),
        description: input.description ?? "",
        permissions: input.permissions,
        isSystem: input.isSystem ?? false,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
    });
  }

  async listUsers(tx?: PgTxClient): Promise<readonly AdminUserRecord[]> {
    return await this.runInTx(tx, async (q) => {
      const res = await q.query<{
        admin_id: string;
        email: string;
        display_name: string;
        role_slug: string;
        scope_summary: string;
        is_active: boolean;
        permissions_json: string | readonly AdminPermission[];
        created_at: string;
        updated_at: string;
      }>(
        `SELECT u.admin_id, u.email, u.display_name, u.role_slug, u.scope_summary, u.is_active,
                r.permissions_json, u.created_at, u.updated_at
         FROM admin_users u
         JOIN admin_roles r ON r.role_slug = u.role_slug
         ORDER BY u.created_at ASC`
      );

      return res.rows.map((row) => ({
        adminId: row.admin_id,
        email: row.email,
        displayName: row.display_name,
        roleSlug: row.role_slug,
        scopeSummary: row.scope_summary,
        isActive: Boolean(row.is_active),
        permissions:
          typeof row.permissions_json === "string"
            ? JSON.parse(row.permissions_json)
            : row.permissions_json,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    });
  }

  async createAdminUser(
    input: CreateAdminUserInput,
    tx?: PgTxClient
  ): Promise<AdminUserRecord> {
    const adminId = input.adminId ?? `adm_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const email = input.email.toLowerCase().trim();
    const passwordHash = hashPasswordHex(email, input.passwordPlain);
    const nowIso = new Date().toISOString();

    return await this.runInTx(tx, async (q) => {
      // Validate role exists
      const roleRes = await q.query<{ permissions_json: string | readonly AdminPermission[] }>(
        `SELECT permissions_json FROM admin_roles WHERE role_slug = $1`,
        [input.roleSlug]
      );
      if (roleRes.rows.length === 0) {
        throw new Error(`Admin role '${input.roleSlug}' does not exist in PostgreSQL`);
      }
      const permissions: readonly AdminPermission[] =
        typeof roleRes.rows[0]!.permissions_json === "string"
          ? JSON.parse(roleRes.rows[0]!.permissions_json)
          : roleRes.rows[0]!.permissions_json;

      await q.query(
        `INSERT INTO admin_users (
          admin_id, email, display_name, role_slug, password_hash, scope_summary, is_active, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, true, $7::timestamptz, $8::timestamptz)`,
        [
          adminId,
          email,
          input.displayName.trim(),
          input.roleSlug,
          passwordHash,
          input.scopeSummary ?? "",
          nowIso,
          nowIso,
        ]
      );

      return {
        adminId,
        email,
        displayName: input.displayName.trim(),
        roleSlug: input.roleSlug,
        scopeSummary: input.scopeSummary ?? "",
        isActive: true,
        permissions,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
    });
  }

  private signPayloadBase64(payloadB64: string): string {
    return createHmac("sha256", this.signingSecret)
      .update(payloadB64)
      .digest("hex");
  }

  issueSessionToken(principal: AdminPrincipal, nowUnixSec = Math.floor(Date.now() / 1000)): string {
    const claims: AdminSessionClaims = {
      sub: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
      role: principal.role,
      iat: nowUnixSec,
      exp: nowUnixSec + this.sessionTtlSeconds,
    };
    const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const sigHex = this.signPayloadBase64(payloadB64);
    return `${payloadB64}.${sigHex}`;
  }

  verifySessionToken(
    token: string | undefined | null,
    nowUnixSec = Math.floor(Date.now() / 1000)
  ): { valid: boolean; claims?: AdminSessionClaims; reason?: string } {
    if (!token || !token.includes(".")) {
      return { valid: false, reason: "MISSING_OR_MALFORMED_TOKEN" };
    }
    const dotIdx = token.indexOf(".");
    const payloadB64 = token.slice(0, dotIdx);
    const providedSigHex = token.slice(dotIdx + 1);
    const expectedSigHex = this.signPayloadBase64(payloadB64);

    if (!constantTimeHexEqual(providedSigHex, expectedSigHex)) {
      return { valid: false, reason: "SESSION_SIGNATURE_MISMATCH" };
    }

    try {
      const claims = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString("utf8")
      ) as AdminSessionClaims;
      if (claims.exp < nowUnixSec) {
        return { valid: false, reason: "SESSION_EXPIRED" };
      }
      return { valid: true, claims };
    } catch {
      return { valid: false, reason: "INVALID_CLAIMS_JSON" };
    }
  }

  async authenticateWithPassword(
    email: string,
    passwordPlain: string,
    tx?: PgTxClient
  ): Promise<{
    ok: boolean;
    principal?: AdminPrincipal;
    sessionToken?: string;
    audit: AdminRbacAuditEntry;
  }> {
    const normalizedEmail = email.toLowerCase().trim();

    return await this.runInTx(tx, async (q) => {
      const userRes = await q.query<{
        admin_id: string;
        email: string;
        display_name: string;
        role_slug: string;
        password_hash: string;
        is_active: boolean;
        permissions_json: string | readonly AdminPermission[];
      }>(
        `SELECT u.admin_id, u.email, u.display_name, u.role_slug, u.password_hash, u.is_active,
                r.permissions_json
         FROM admin_users u
         JOIN admin_roles r ON r.role_slug = u.role_slug
         WHERE u.email = $1`,
        [normalizedEmail]
      );

      const candidateHex = hashPasswordHex(normalizedEmail, passwordPlain);
      const targetHex =
        userRes.rows[0]?.password_hash ??
        hashPasswordHex("invalid@kronos.io", "dummy_constant_time_fallback");

      const matched =
        userRes.rows.length > 0 &&
        Boolean(userRes.rows[0]!.is_active) &&
        constantTimeHexEqual(candidateHex, targetHex);

      if (!matched || userRes.rows.length === 0) {
        const audit = await this.recordAudit(
          {
            actorId: userRes.rows[0]?.admin_id ?? "anon",
            actorEmail: normalizedEmail || "unknown",
            action: "POST /api/admin/login (FAILED)",
            targetType: "AUTH_SESSION",
            targetId: normalizedEmail || "unknown",
            details: {
              reason: "Constant-time password comparison failure or account inactive",
              decision: "DENY_401",
              httpStatus: 401,
            },
          },
          q
        );

        return {
          ok: false,
          audit: {
            auditId: audit.id,
            email: normalizedEmail,
            role: "ANONYMOUS",
            actionLabel: "POST /api/admin/login",
            requiredPermission: "auth:login",
            decision: "DENY_401",
            httpStatus: 401,
            detail: `Authentication rejected for '${normalizedEmail}'`,
            timestampIso: audit.createdAt,
          },
        };
      }

      const user = userRes.rows[0]!;
      const permissions: readonly AdminPermission[] =
        typeof user.permissions_json === "string"
          ? JSON.parse(user.permissions_json)
          : user.permissions_json;

      const principal: AdminPrincipal = {
        userId: user.admin_id,
        email: user.email,
        displayName: user.display_name,
        role: user.role_slug as AdminRole,
        permissions,
      };

      const sessionToken = this.issueSessionToken(principal);

      const audit = await this.recordAudit(
        {
          actorId: user.admin_id,
          actorEmail: user.email,
          action: "POST /api/admin/login (SUCCESS)",
          targetType: "AUTH_SESSION",
          targetId: user.admin_id,
          details: {
            role: user.role_slug,
            decision: "ALLOW",
            httpStatus: 200,
            permissionsCount: permissions.length,
          },
        },
        q
      );

      return {
        ok: true,
        principal,
        sessionToken,
        audit: {
          auditId: audit.id,
          email: user.email,
          role: user.role_slug as AdminRole,
          actionLabel: `POST /api/admin/login (${user.role_slug})`,
          requiredPermission: "auth:login",
          decision: "ALLOW",
          httpStatus: 200,
          detail: `Issued session token for ${user.display_name} with ${permissions.length} permissions`,
          timestampIso: audit.createdAt,
        },
      };
    });
  }

  async authorizeAction(
    params: {
      token: string | undefined | null;
      requiredPermission: AdminPermission;
      actionLabel: string;
      targetType?: string;
      targetId?: string;
    },
    tx?: PgTxClient
  ): Promise<{
    allowed: boolean;
    httpStatus: 200 | 401 | 403;
    principal?: AdminPrincipal;
    audit: AdminRbacAuditEntry;
  }> {
    const verification = this.verifySessionToken(params.token);

    return await this.runInTx(tx, async (q) => {
      if (!verification.valid || !verification.claims) {
        const audit = await this.recordAudit(
          {
            actorId: "anonymous",
            actorEmail: "anonymous@kronos.io",
            action: params.actionLabel,
            targetType: params.targetType ?? "API_ENDPOINT",
            targetId: params.targetId ?? "root",
            details: {
              requiredPermission: params.requiredPermission,
              decision: "DENY_401",
              httpStatus: 401,
              reason: verification.reason ?? "NO_TOKEN",
            },
          },
          q
        );

        return {
          allowed: false,
          httpStatus: 401,
          audit: {
            auditId: audit.id,
            email: "anonymous",
            role: "ANONYMOUS",
            actionLabel: params.actionLabel,
            requiredPermission: params.requiredPermission,
            decision: "DENY_401",
            httpStatus: 401,
            detail: `Unauthenticated request blocked: ${verification.reason ?? "NO_TOKEN"}`,
            timestampIso: audit.createdAt,
          },
        };
      }

      const { claims } = verification;

      // Query dynamic permissions from PostgreSQL for this role
      const roleRes = await q.query<{ permissions_json: string | readonly AdminPermission[] }>(
        `SELECT permissions_json FROM admin_roles WHERE role_slug = $1`,
        [claims.role]
      );

      const dynamicPermissions: readonly AdminPermission[] =
        roleRes.rows.length > 0
          ? typeof roleRes.rows[0]!.permissions_json === "string"
            ? JSON.parse(roleRes.rows[0]!.permissions_json)
            : roleRes.rows[0]!.permissions_json
          : [];

      const principal: AdminPrincipal = {
        userId: claims.sub,
        email: claims.email,
        displayName: claims.displayName,
        role: claims.role,
        permissions: dynamicPermissions,
      };

      const hasPerm = dynamicPermissions.includes(params.requiredPermission);

      if (!hasPerm) {
        const audit = await this.recordAudit(
          {
            actorId: principal.userId,
            actorEmail: principal.email,
            action: params.actionLabel,
            targetType: params.targetType ?? "API_ENDPOINT",
            targetId: params.targetId ?? "root",
            details: {
              role: principal.role,
              requiredPermission: params.requiredPermission,
              decision: "DENY_403",
              httpStatus: 403,
            },
          },
          q
        );

        return {
          allowed: false,
          httpStatus: 403,
          principal,
          audit: {
            auditId: audit.id,
            email: principal.email,
            role: principal.role,
            actionLabel: params.actionLabel,
            requiredPermission: params.requiredPermission,
            decision: "DENY_403",
            httpStatus: 403,
            detail: `Role '${principal.role}' lacks permission '${params.requiredPermission}'`,
            timestampIso: audit.createdAt,
          },
        };
      }

      const audit = await this.recordAudit(
        {
          actorId: principal.userId,
          actorEmail: principal.email,
          action: params.actionLabel,
          targetType: params.targetType ?? "API_ENDPOINT",
          targetId: params.targetId ?? "root",
          details: {
            role: principal.role,
            requiredPermission: params.requiredPermission,
            decision: "ALLOW",
            httpStatus: 200,
          },
        },
        q
      );

      return {
        allowed: true,
        httpStatus: 200,
        principal,
        audit: {
          auditId: audit.id,
          email: principal.email,
          role: principal.role,
          actionLabel: params.actionLabel,
          requiredPermission: params.requiredPermission,
          decision: "ALLOW",
          httpStatus: 200,
          detail: `Authorized action '${params.actionLabel}' via permission '${params.requiredPermission}'`,
          timestampIso: audit.createdAt,
        },
      };
    });
  }

  async recordAudit(
    params: {
      actorId: string;
      actorEmail: string;
      action: string;
      targetType: string;
      targetId: string;
      details?: Record<string, unknown>;
    },
    tx?: PgTxClient
  ): Promise<AdminAuditLogRecord> {
    const id = `audit_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const nowIso = new Date().toISOString();
    const details = params.details ?? {};

    return await this.runInTx(tx, async (q) => {
      await q.query(
        `INSERT INTO admin_audit_logs (
          id, actor_id, actor_email, action, target_type, target_id, details_json, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)`,
        [
          id,
          params.actorId,
          params.actorEmail,
          params.action,
          params.targetType,
          params.targetId,
          JSON.stringify(details),
          nowIso,
        ]
      );

      return {
        id,
        actorId: params.actorId,
        actorEmail: params.actorEmail,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        details,
        createdAt: nowIso,
      };
    });
  }

  async listAuditLogs(
    limit = 50,
    tx?: PgTxClient
  ): Promise<readonly AdminAuditLogRecord[]> {
    return await this.runInTx(tx, async (q) => {
      const res = await q.query<{
        id: string;
        actor_id: string;
        actor_email: string;
        action: string;
        target_type: string;
        target_id: string;
        details_json: string | Record<string, unknown>;
        created_at: string;
      }>(
        `SELECT id, actor_id, actor_email, action, target_type, target_id, details_json, created_at
         FROM admin_audit_logs
         ORDER BY created_at DESC, id DESC
         LIMIT $1`,
        [limit]
      );

      return res.rows.map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        actorEmail: row.actor_email,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        details:
          typeof row.details_json === "string"
            ? JSON.parse(row.details_json)
            : row.details_json,
        createdAt: row.created_at,
      }));
    });
  }
}
