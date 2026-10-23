// ============================================================
// audit.ts — Append-only audit log writer
// ------------------------------------------------------------
// Every privileged action writes here. RLS (configured in 00-03) will
// forbid UPDATE and DELETE on this table for all roles.
//
// Design notes:
// - `details` is JSONB; callers MUST strip secrets before passing.
// - `ipHash` is SHA-256 of the raw IP, salted with AUTH_SECRET — never
//   the raw IP. This allows correlation without PII storage.
// - Failures in audit writing are LOGGED but never THROWN — audit must
//   not break the primary flow. (Trade-off: a failed audit write is a
//   security event that must be alerted on via log monitoring.)
//
// D05 FINAL CLOSURE (Migration 34): dual-client audit writer.
// The audit_log RLS policy requires `app.tenant_id` to be set for
// writes via balance_app. Before authentication completes (signin
// attempts, health-check pings, rate-limit hits), no tenant context
// exists, so balance_app INSERTs are denied with PostgreSQL error
// 42501 ("new row violates row-level security policy for table
// audit_log"). The previous behavior tolerated this and LOST the
// security event.
//
// Fix: when entry.tenantId is null/undefined (pre-auth event), use
// the dedicated `balance_security_logger` client instead of balance_app.
// This role has INSERT-only on audit_log with an RLS policy
// `WITH CHECK (tenantId IS NULL)` — so it can write ONLY pre-auth
// events. It cannot SELECT/UPDATE/DELETE audit rows, cannot bypass
// RLS, and has no grants on any other table. (See Migration 34:
// prisma/migrations/20261023000034_security_logger_role/migration.sql)
//
// 01-10: writeAuditTx — transaction-scoped variant for ATOMIC audit writes.
// When the audit write must be atomic with the primary operation (e.g.
// strategy approval), use writeAuditTx(tx, entry) inside the same
// withAuthenticatedTenant transaction. This ensures the audit_log row
// commits or rolls back WITH the primary operation.
// ============================================================
import { createHash } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { childLogger } from "@/lib/observability";

const log = childLogger({ module: "audit" });

// ============================================================
// PRE-AUTH SECURITY LOGGER CLIENT (singleton, lazy)
// ------------------------------------------------------------
// Used ONLY for audit writes with tenantId IS NULL (pre-auth events).
// Production: SECURITY_LOGGER_DATABASE_URL MUST be set explicitly.
// In test environments where the role is not provisioned, the audit
// module gracefully falls back to the main `db` client (which will
// fail RLS for tenantId IS NULL — preserving the historical best-effort
// behavior so old test fixtures don't break).
// ============================================================
let _securityLogClient: PrismaClient | null = null;

function getSecurityLogClient(): PrismaClient | null {
  if (_securityLogClient !== null) return _securityLogClient;
  const url = process.env.SECURITY_LOGGER_DATABASE_URL;
  if (!url) {
    // Not provisioned — fall back to main db (historical behavior).
    // AUDIT_WRITE_FAILED will be logged for pre-auth events.
    return null;
  }
  _securityLogClient = new PrismaClient({
    datasources: { db: { url } },
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  return _securityLogClient;
}

export interface AuditEntry {
  tenantId?: string | null;
  actor?: string;
  action: string;
  route?: string | null;
  method?: string | null;
  ip?: string | null;
  details?: Record<string, unknown>;
  status?: "ok" | "error" | "denied";
  errorCode?: string | null;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    const ipHash = entry.ip ? hashIp(entry.ip) : null;
    const details = (entry.details ?? {}) as Prisma.InputJsonValue;
    const data = {
      tenantId: entry.tenantId ?? null,
      actor: entry.actor ?? "system",
      action: entry.action,
      route: entry.route ?? null,
      method: entry.method ?? null,
      ipHash,
      details,
      status: entry.status ?? "ok",
      errorCode: entry.errorCode ?? null,
    };

    // D05 Closure: route pre-auth events (no tenantId) to the
    // balance_security_logger client. RLS on audit_log for
    // balance_app requires app.tenant_id to be set; for pre-auth
    // events that context does not exist, so the dedicated role
    // (with its own RLS policy `WITH CHECK tenantId IS NULL`) is
    // the only safe path that preserves both RLS and the audit trail.
    if (entry.tenantId == null) {
      const secClient = getSecurityLogClient();
      if (secClient) {
        await secClient.auditLog.create({ data });
        return;
      }
      // Fall through to balance_app (will fail RLS, tolerated).
    }
    await db.auditLog.create({ data });
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        action: entry.action,
        tenantId: entry.tenantId,
      },
      "AUDIT_WRITE_FAILED — primary flow continues; investigate via logs."
    );
  }
}

/**
 * 01-10: Transaction-scoped audit write — ATOMIC with the primary operation.
 *
 * Unlike writeAudit (which uses the global db client and is best-effort),
 * writeAuditTx uses the provided transaction client (tx) so the audit_log
 * row commits or rolls back WITH the primary transaction.
 *
 * If the audit write fails, the error is THROWN (not swallowed) — this
 * causes the entire transaction to roll back. This is the correct behavior
 * for compliance-grade audit: if we can't record the action, we don't
 * commit the action.
 *
 * IMPORTANT: the caller MUST set the tenant context (app.tenant_id) before
 * calling this function, because RLS on audit_log requires it. When called
 * inside withAuthenticatedTenant, the tenant context is already set.
 */
export async function writeAuditTx(
  tx: Prisma.TransactionClient,
  entry: AuditEntry
): Promise<void> {
  const ipHash = entry.ip ? hashIp(entry.ip) : null;
  const details = (entry.details ?? {}) as Prisma.InputJsonValue;
  await tx.auditLog.create({
    data: {
      tenantId: entry.tenantId ?? null,
      actor: entry.actor ?? "system",
      action: entry.action,
      route: entry.route ?? null,
      method: entry.method ?? null,
      ipHash,
      details,
      status: entry.status ?? "ok",
      errorCode: entry.errorCode ?? null,
    },
  });
}

function hashIp(ip: string): string {
  const salt = env.AUTH_SECRET;
  return createHash("sha256")
    .update(`${salt}:${ip}`)
    .digest("hex")
    .slice(0, 16);
}
