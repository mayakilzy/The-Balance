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
    // Prisma's JsonValue typing is strict; cast through Prisma.InputJsonValue.
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
    // Audit failure is a security event — log at error level and continue.
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

function hashIp(ip: string): string {
  // Salt with AUTH_SECRET so the hash is not reversible via rainbow tables
  // built against public IP lists. Truncated to 16 chars for storage brevity.
  const salt = env.AUTH_SECRET;
  return createHash("sha256")
    .update(`${salt}:${ip}`)
    .digest("hex")
    .slice(0, 16);
}
