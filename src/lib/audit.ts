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
// 01-10: writeAuditTx — transaction-scoped variant for ATOMIC audit writes.
// When the audit write must be atomic with the primary operation (e.g.
// strategy approval), use writeAuditTx(tx, entry) inside the same
// withAuthenticatedTenant transaction. This ensures the audit_log row
// commits or rolls back WITH the primary operation.
// ============================================================
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { childLogger } from "@/lib/observability";

const log = childLogger({ module: "audit" });

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
    await db.auditLog.create({
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
