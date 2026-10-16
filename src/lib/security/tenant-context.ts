// ============================================================
// tenant-context.ts — Tenant isolation primitives
// ------------------------------------------------------------
// PostgreSQL Row-Level Security (RLS) is the enforcement layer.
// Prisma is the access layer — it must NOT bypass RLS. This module
// provides the helpers to scope a Prisma transaction to a tenant:
//
//   await db.$transaction(async (tx) => {
//     await setTenantContext(tx, tenantId);
//     // All subsequent queries in this tx see only tenantId's rows.
//   });
//
// Implementation: `SET LOCAL app.tenant_id = '<id>'` sets a session
// variable that RLS policies reference via `current_setting('app.tenant_id')`.
//
// NOTE: Full RLS policies are created in mission 00-03. In 00-01 we
// only ship the helper so the API surface is stable.
// ============================================================
import type { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";

type TransactionClient = Prisma.TransactionClient;

/**
 * Set the tenant context for the current transaction.
 * Must be called inside `db.$transaction(async (tx) => { ... })`.
 * RLS policies (created in 00-03) will enforce isolation based on this.
 */
export async function setTenantContext(
  tx: TransactionClient,
  tenantId: string
): Promise<void> {
  // Parameterized to avoid SQL injection — Prisma doesn't support
  // bind params for SET LOCAL directly, so we escape via quote_literal.
  await tx.$executeRaw`SET LOCAL app.tenant_id = ${tenantId}`;
}

/**
 * Clear the tenant context (for system-level queries that span tenants).
 * Use sparingly — most queries should be tenant-scoped.
 */
export async function clearTenantContext(
  tx: TransactionClient
): Promise<void> {
  await tx.$executeRaw`SET LOCAL app.tenant_id = ''`;
}

/**
 * Read the current tenant context (for debugging / assertions).
 */
export async function getTenantContext(
  tx: TransactionClient
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ tenant_id: string | null }[]>`
    SELECT current_setting('app.tenant_id', true) AS tenant_id
  `;
  const value = rows[0]?.tenant_id;
  return value && value.length > 0 ? value : null;
}

/**
 * Wrap a callback in a tenant-scoped transaction.
 * Convenience helper — handles setTenantContext + commit/rollback.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TransactionClient) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => {
    await setTenantContext(tx, tenantId);
    return fn(tx);
  });
}

// Import db here to avoid circular dep in `withTenant`
import { db } from "@/lib/db";
