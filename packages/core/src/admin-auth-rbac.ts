/**
 * `@super-ecommerce/core` — Admin Authentication (HMAC-SHA256 Signed Session Token)
 * & Role-Based Access Control (RBAC) Gate.
 *
 * Security Invariants:
 * - Constant-time credential and token signature comparison (`timingSafeEqual`)
 * - Stateless signed session cookie (`super_admin_session`) with expiration check
 * - Least-privilege RBAC matrix across `SUPER_ADMIN`, `MERCHANT_OPS`, and `FINANCE_AUDITOR`
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type AdminRole = "SUPER_ADMIN" | "MERCHANT_OPS" | "FINANCE_AUDITOR";

export type AdminPermission =
  | "cockpit:read"
  | "msi:route_and_sync"
  | "mcp:diagnose"
  | "saga:execute_checkout"
  | "configurator:deploy_dag"
  | "chaos:inject_faults"
  | "finance:audit_webhooks";

export interface AdminPrincipal {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: AdminRole;
  readonly permissions: readonly AdminPermission[];
}

export interface SeededAdminAccount extends AdminPrincipal {
  readonly demoPasswordPlain: string;
  readonly passwordDigestHex: string;
  readonly scopeSummary: string;
}

export interface AdminSessionClaims {
  readonly sub: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: AdminRole;
  readonly iat: number;
  readonly exp: number;
}

export interface AdminRbacAuditEntry {
  readonly auditId: string;
  readonly email: string;
  readonly role: AdminRole | "ANONYMOUS";
  readonly actionLabel: string;
  readonly requiredPermission: AdminPermission | "auth:login" | "auth:logout";
  readonly decision: "ALLOW" | "DENY_403" | "DENY_401";
  readonly httpStatus: 200 | 401 | 403;
  readonly detail: string;
  readonly timestampIso: string;
}

export const ROLE_PERMISSION_MATRIX: Record<AdminRole, readonly AdminPermission[]> = {
  SUPER_ADMIN: [
    "cockpit:read",
    "msi:route_and_sync",
    "mcp:diagnose",
    "saga:execute_checkout",
    "configurator:deploy_dag",
    "chaos:inject_faults",
    "finance:audit_webhooks",
  ],
  MERCHANT_OPS: [
    "cockpit:read",
    "msi:route_and_sync",
    "mcp:diagnose",
    "saga:execute_checkout",
  ],
  FINANCE_AUDITOR: [
    "cockpit:read",
    "mcp:diagnose",
    "finance:audit_webhooks",
  ],
};

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

export const SEEDED_ADMIN_ACCOUNTS: readonly SeededAdminAccount[] = [
  {
    userId: "adm_01_super",
    email: "admin@kronos.io",
    displayName: "Ada Lovelace (Platform Architect)",
    role: "SUPER_ADMIN",
    permissions: ROLE_PERMISSION_MATRIX.SUPER_ADMIN,
    demoPasswordPlain: "Kronos!Admin2026",
    passwordDigestHex: hashPasswordHex("admin@kronos.io", "Kronos!Admin2026"),
    scopeSummary:
      "Full 7/7 permissions: Configurator DAG deploy, WASM/Outbox/Saga chaos injection, MSI routing, PG stress",
  },
  {
    userId: "adm_02_ops",
    email: "ops@kronos.io",
    displayName: "Marcus Vance (Fulfillment Lead)",
    role: "MERCHANT_OPS",
    permissions: ROLE_PERMISSION_MATRIX.MERCHANT_OPS,
    demoPasswordPlain: "Kronos!Ops2026",
    passwordDigestHex: hashPasswordHex("ops@kronos.io", "Kronos!Ops2026"),
    scopeSummary:
      "4/7 permissions: MSI stock routing, 5-step Saga orders & MCP Doctor (Blocked from Configurator DAG & Chaos Faults)",
  },
  {
    userId: "adm_03_audit",
    email: "audit@kronos.io",
    displayName: "Elena Rostova (Financial Auditor)",
    role: "FINANCE_AUDITOR",
    permissions: ROLE_PERMISSION_MATRIX.FINANCE_AUDITOR,
    demoPasswordPlain: "Kronos!Audit2026",
    passwordDigestHex: hashPasswordHex("audit@kronos.io", "Kronos!Audit2026"),
    scopeSummary:
      "3/7 permissions: Price waterfall & Stripe Webhook audit (Read-only on MSI routing, Configurator & Chaos Faults)",
  },
];

export const ADMIN_SESSION_COOKIE_NAME = "super_admin_session";

export class AdminAuthRbacService {
  private readonly signingSecret: string;
  private readonly sessionTtlSeconds: number;
  private auditSeq = 1;
  private latestBanner =
    "RBAC Gate Active // Signed HMAC-SHA256 Session Cookie (HttpOnly, SameSite=Lax) | 3 Roles Configured (SUPER_ADMIN, MERCHANT_OPS, FINANCE_AUDITOR)";
  private readonly auditLogs: AdminRbacAuditEntry[] = [];

  constructor(options?: { signingSecret?: string; sessionTtlSeconds?: number }) {
    this.signingSecret =
      options?.signingSecret ??
      process.env["SUPER_ADMIN_SESSION_SECRET"] ??
      "super_admin_hmac_session_secret_2026_v1";
    this.sessionTtlSeconds = options?.sessionTtlSeconds ?? 8 * 3600;
  }

  listSeededAccounts(): readonly SeededAdminAccount[] {
    return SEEDED_ADMIN_ACCOUNTS;
  }

  getLatestBanner(): string {
    return this.latestBanner;
  }

  listAuditLogs(limit = 10): readonly AdminRbacAuditEntry[] {
    return this.auditLogs.slice(0, limit);
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
  ): { valid: boolean; principal?: AdminPrincipal; reason?: string } {
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
      const permissions = ROLE_PERMISSION_MATRIX[claims.role];
      if (!permissions) {
        return { valid: false, reason: "UNKNOWN_ROLE" };
      }
      return {
        valid: true,
        principal: {
          userId: claims.sub,
          email: claims.email,
          displayName: claims.displayName,
          role: claims.role,
          permissions,
        },
      };
    } catch {
      return { valid: false, reason: "INVALID_CLAIMS_JSON" };
    }
  }

  authenticateWithPassword(
    email: string,
    password: string
  ): {
    ok: boolean;
    principal?: AdminPrincipal;
    sessionToken?: string;
    audit: AdminRbacAuditEntry;
  } {
    const normalizedEmail = email.toLowerCase().trim();
    const account = SEEDED_ADMIN_ACCOUNTS.find(
      (a) => a.email.toLowerCase() === normalizedEmail
    );
    const candidateHex = hashPasswordHex(normalizedEmail, password);
    const targetHex =
      account?.passwordDigestHex ??
      hashPasswordHex("invalid@kronos.io", "dummy_constant_time_fallback");

    const matched = Boolean(account) && constantTimeHexEqual(candidateHex, targetHex);

    if (!matched || !account) {
      const audit = this.recordAudit({
        email: normalizedEmail || "unknown",
        role: "ANONYMOUS",
        actionLabel: "POST /api/admin/login (Invalid Credentials)",
        requiredPermission: "auth:login",
        decision: "DENY_401",
        httpStatus: 401,
        detail: `Constant-time HMAC password check failed for '${normalizedEmail || "empty"}'`,
      });
      this.latestBanner = `AUTH REJECTED (HTTP 401) // Invalid email or password for '${normalizedEmail}' (Constant-Time Digest Comparison)`;
      return { ok: false, audit };
    }

    const sessionToken = this.issueSessionToken(account);
    const audit = this.recordAudit({
      email: account.email,
      role: account.role,
      actionLabel: `POST /api/admin/login (${account.role})`,
      requiredPermission: "auth:login",
      decision: "ALLOW",
      httpStatus: 200,
      detail: `Issued signed HMAC-SHA256 session cookie for ${account.displayName} (${account.permissions.length}/7 permissions)`,
    });
    this.latestBanner = `SESSION AUTHENTICATED // ${account.email} (${account.role}) signed in with ${account.permissions.length}/7 RBAC permissions`;
    return {
      ok: true,
      principal: account,
      sessionToken,
      audit,
    };
  }

  authorizeAction(params: {
    token: string | undefined | null;
    requiredPermission: AdminPermission;
    actionLabel: string;
  }): {
    allowed: boolean;
    httpStatus: 200 | 401 | 403;
    principal?: AdminPrincipal;
    audit: AdminRbacAuditEntry;
  } {
    const verification = this.verifySessionToken(params.token);
    if (!verification.valid || !verification.principal) {
      const audit = this.recordAudit({
        email: "anonymous",
        role: "ANONYMOUS",
        actionLabel: params.actionLabel,
        requiredPermission: params.requiredPermission,
        decision: "DENY_401",
        httpStatus: 401,
        detail: `Unauthenticated request blocked (${verification.reason ?? "NO_TOKEN"})`,
      });
      this.latestBanner = `UNAUTHENTICATED 401 BLOCKED // Action '${params.actionLabel}' requires permission '${params.requiredPermission}'`;
      return { allowed: false, httpStatus: 401, audit };
    }

    const { principal } = verification;
    const hasPerm = principal.permissions.includes(params.requiredPermission);
    if (!hasPerm) {
      const audit = this.recordAudit({
        email: principal.email,
        role: principal.role,
        actionLabel: params.actionLabel,
        requiredPermission: params.requiredPermission,
        decision: "DENY_403",
        httpStatus: 403,
        detail: `Role '${principal.role}' lacks permission '${params.requiredPermission}' (Allowed: ${principal.permissions.join(", ")})`,
      });
      this.latestBanner = `RBAC 403 FORBIDDEN // Principal ${principal.email} (${principal.role}) blocked from '${params.actionLabel}' (Missing permission: ${params.requiredPermission})`;
      return { allowed: false, httpStatus: 403, principal, audit };
    }

    const audit = this.recordAudit({
      email: principal.email,
      role: principal.role,
      actionLabel: params.actionLabel,
      requiredPermission: params.requiredPermission,
      decision: "ALLOW",
      httpStatus: 200,
      detail: `Authorized via '${params.requiredPermission}' on role '${principal.role}'`,
    });
    this.latestBanner = `RBAC 200 AUTHORIZED // ${principal.email} (${principal.role}) executed '${params.actionLabel}' [${params.requiredPermission}]`;
    return { allowed: true, httpStatus: 200, principal, audit };
  }

  recordLogout(principal?: AdminPrincipal): AdminRbacAuditEntry {
    const audit = this.recordAudit({
      email: principal?.email ?? "session-user",
      role: principal?.role ?? "ANONYMOUS",
      actionLabel: "POST /api/admin/logout",
      requiredPermission: "auth:logout",
      decision: "ALLOW",
      httpStatus: 200,
      detail: "Cleared HttpOnly super_admin_session cookie",
    });
    this.latestBanner = `SESSION TERMINATED // Cleared HttpOnly super_admin_session cookie for ${principal?.email ?? "user"}`;
    return audit;
  }

  private recordAudit(
    entry: Omit<AdminRbacAuditEntry, "auditId" | "timestampIso">
  ): AdminRbacAuditEntry {
    const full: AdminRbacAuditEntry = {
      auditId: `rbac_${String(this.auditSeq++).padStart(3, "0")}`,
      ...entry,
      timestampIso: new Date().toISOString(),
    };
    this.auditLogs.unshift(full);
    return full;
  }
}

export function parseCookieHeader(cookieHeader: string | null | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
