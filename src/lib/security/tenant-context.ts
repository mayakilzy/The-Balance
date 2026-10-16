// ============================================================
// tenant-context.ts — Tenant isolation primitives
// ------------------------------------------------------------
// PostgreSQL Row-Level Security (RLS) is the enforcement layer.
// Prisma is the access layer — it must NOT bypass RLS. This module
// provides the helpers to scope a Prisma transaction to a tenant.
//
//   await db.$transaction(async (tx) => {
//     await setTenantContext(tx, tenantId);
//     // All subsequent queries in this tx see only tenantId's rows.
//   });
//
// Implementation: we use `set_config('app.tenant_id', $1, true)` — the
// third argument `true` makes the setting LOCAL (transaction-scoped),
// equivalent to `SET LOCAL`. Using `set_config()` instead of `SET LOCAL`
// lets us pass the tenantId as a bind parameter via Prisma's tagged
// template, eliminating any SQL-injection surface.
//
// Verified working against PostgreSQL 16 (CI integration test:
// tests/integration/tenant-context.integration.test.ts).
//
// NOTE: Full RLS policies are created in mission 00-02. In 00-01 we
// only ship the helper so the API surface is stable.
// ============================================================
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type TransactionClient = Prisma.TransactionClient;

/**
 * Set the tenant context for the current transaction.
 * Must be called inside `db.$transaction(async (tx) => { ... })`.
 * RLS policies (created in 00-02) will enforce isolation based on this.
 *
 * Uses `set_config(name, value, is_local)` with `is_local=true` so the
 * setting is scoped to the current transaction. The tenantId is passed
 * as a bind parameter, preventing SQL injection even if the value
 * contains malicious SQL.
 */
export async function setTenantContext(
  tx: TransactionClient,
  tenantId: string
): Promise<void> {
  // Validate tenantId format before passing to SQL — defense in depth.
  // Prisma's tagged template already parameterizes, but we add a format
  // check so an obviously bad value fails fast with a clear error.
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error(
      `setTenantContext: tenantId must be a non-empty string (got: ${typeof tenantId})`
    );
  }
  if (tenantId.length > 256) {
    throw new Error(
      `setTenantContext: tenantId exceeds 256 chars (got ${tenantId.length})`
    );
  }
  // Bind parameter via Prisma's tagged template — tenantId is safely escaped.
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

/**
 * Clear the tenant context (for system-level queries that span tenants).
 * Use sparingly — most queries should be tenant-scoped.
 */
export async function clearTenantContext(
  tx: TransactionClient
): Promise<void> {
  // set_config with empty value + is_local=true clears within the tx.
  await tx.$executeRaw`SELECT set_config('app.tenant_id', '', true)`;
}

/**
 * Read the current tenant context (for debugging / assertions).
 * Returns null if no tenant context is set.
 */
export async function getTenantContext(
  tx: TransactionClient
): Promise<string | null> {
  // current_setting(name, missing_ok=true) returns NULL if unset.
  const rows = await tx.$queryRaw<{ tenant_id: string | null }[]>`
    SELECT current_setting('app.tenant_id', true) AS tenant_id
  `;
  const value = rows[0]?.tenant_id;
  return value && value.length > 0 ? value : null;
}

/**
 * Wrap a callback in a tenant-scoped transaction.
 * Convenience helper — handles setTenantContext + commit/rollback.
 *
 * Example:
 *   const result = await withTenant('tenant_abc', async (tx) => {
 *     return await tx.evidence.findMany();
 *   });
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
