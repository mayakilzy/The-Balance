// ============================================================
// tenant-context.ts — Tenant isolation primitives
// ------------------------------------------------------------
// PostgreSQL Row-Level Security (RLS) is the enforcement layer.
// Prisma is the access layer — it must NOT bypass RLS. This module
// provides the helpers to scope a Prisma transaction to a tenant.
//
//   await withTenant('tenant_abc', async (tx) => {
//     return await tx.auditLog.findMany();  // sees only tenant_abc's rows
//   });
//
// For PUBLIC tables (countries, public_knowledge, etc.), no tenant
// context is needed — RLS policies allow balance_app to SELECT
// from PUBLIC tables unconditionally. See ADR-0004.
//
// Implementation: we use `set_config('app.tenant_id', $1, true)` — the
// third argument `true` makes the setting LOCAL (transaction-scoped),
// equivalent to `SET LOCAL`. Using `set_config()` instead of `SET LOCAL`
// lets us pass the tenantId as a bind parameter via Prisma's tagged
// template, eliminating any SQL-injection surface.
//
// Verified working against PostgreSQL 16 (CI integration tests:
// tests/integration/tenant-context.integration.test.ts and
// tests/integration/rls-isolation.integration.test.ts).
//
// RLS policies are created in mission 00-02 (migration
// 20261016000002_ontology_and_rls). See ADR-0005.
// ============================================================
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type TransactionClient = Prisma.TransactionClient;

/**
 * Set the tenant context for the current transaction.
 * Must be called inside `db.$transaction(async (tx) => { ... })`.
 * RLS policies (created in 00-02) enforce isolation based on this.
 *
 * Uses `set_config(name, value, is_local)` with `is_local=true` so the
 * setting is scoped to the current transaction. The tenantId is passed
 * as a bind parameter, preventing SQL injection even if the value
 * contains malicious SQL.
 *
 * After this call, PRIVATE tables (audit_log, future evidence/strategy/task)
 * return only rows where `tenant_id = tenantId`. PUBLIC tables (countries,
 * public_knowledge, etc.) remain readable regardless.
 */
export async function setTenantContext(
  tx: TransactionClient,
  tenantId: string
): Promise<void> {
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
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

/**
 * Clear the tenant context (for system-level queries).
 *
 * IMPORTANT: After calling this, PRIVATE tables (audit_log, etc.) return
 * ZERO rows — RLS is fail-closed when app.tenant_id is empty/NULL.
 * Use this only when you explicitly want no tenant scope (e.g., reading
 * PUBLIC tables, or asserting fail-closed behavior in tests).
 */
export async function clearTenantContext(
  tx: TransactionClient
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', '', true)`;
}

/**
 * Read the current tenant context (for debugging / assertions).
 * Returns null if no tenant context is set.
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
 *
 * Inside the callback:
 *   - PRIVATE tables see only rows for `tenantId`.
 *   - PUBLIC tables remain readable.
 *   - Cross-tenant writes are rejected by RLS WITH CHECK.
 *
 * Example:
 *   const result = await withTenant('tenant_abc', async (tx) => {
 *     return await tx.auditLog.findMany();
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

/**
 * Wrap a callback in a PUBLIC-scope transaction (no tenant context).
 *
 * Use this for reading PUBLIC tables (countries, public_knowledge, etc.)
 * when no tenant context is needed. PRIVATE tables will return zero rows
 * inside this transaction (fail-closed).
 *
 * Example:
 *   const countries = await withPublicScope(async (tx) => {
 *     return await tx.country.findMany();
 *   });
 */
export async function withPublicScope<T>(
  fn: (tx: TransactionClient) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => {
    await clearTenantContext(tx);
    return fn(tx);
  });
}

// ============================================================
// AUTHENTICATED CONTEXT (00-03)
// ------------------------------------------------------------
// These helpers bind tenant context to a VERIFIED session, not to
// client-supplied input. The client cannot pick an arbitrary tenantId.
//
// Flow:
//   1. Auth.js verifies credentials → JWT carries userId + tenantId.
//   2. API route calls withAuthenticatedTenant(session, fn).
//   3. withAuthenticatedTenant verifies the session is active + has membership.
//   4. Sets BOTH app.user_id AND app.tenant_id in PostgreSQL.
//   5. RLS policies on users/memberships/audit_log enforce isolation.
// ============================================================

import type { Session } from "next-auth";

interface AuthenticatedContext {
  tx: TransactionClient;
  userId: string;
  tenantId: string;
  roleCode: string;
}

/**
 * Verify the session is authenticated + active, then run a callback
 * inside a transaction with app.user_id + app.tenant_id set.
 *
 * CURRENT MEMBERSHIP AUTHORIZATION (final runtime acceptance):
 *   - Fetches the CURRENT membership from DB (not stale JWT role).
 *   - If DB role differs from session role, uses DB role (authoritative).
 *   - This catches role changes (admin→observer) mid-session.
 *
 * Security:
 *   - tenantId comes from the session (JWT), NOT from client input.
 *   - The session's membershipStatus must be 'active'.
 *   - The user's status must be 'active' (checked at signin, re-checked here).
 *   - RLS policies enforce isolation at the DB level.
 *   - roleCode in the returned context is the CURRENT DB role, not JWT role.
 *
 * Throws:
 *   - Error if session is invalid or membership is not active.
 */
export async function withAuthenticatedTenant<T>(
  session: Session | null,
  fn: (ctx: AuthenticatedContext) => Promise<T>
): Promise<T> {
  if (!session || !session.user) {
    throw new Error("Unauthenticated: no session");
  }
  if (session.user.membershipStatus !== "active") {
    throw new Error(`Membership not active: ${session.user.membershipStatus}`);
  }
  const userId = session.user.id;
  const tenantId = session.user.tenantId;
  if (!userId || !tenantId) {
    throw new Error("Session missing required claims (userId/tenantId)");
  }

  return db.$transaction(async (tx) => {
    // Set user + tenant context for RLS.
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

    // Verify the membership exists + is active in the DB.
    const membership = await tx.membership.findFirst({
      where: { userId, tenantId, status: "active" },
    });
    if (!membership) {
      throw new Error(`Membership revoked or not found for user ${userId} in tenant ${tenantId}`);
    }

    // Verify user status is still active
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== "active") {
      throw new Error(`User account not active: ${user?.status ?? "not found"}`);
    }

    // Use the CURRENT DB roleCode (authoritative), not the stale JWT role.
    // This catches role changes (admin→observer) mid-session.
    const currentRoleCode = membership.roleCode;

    return fn({ tx, userId, tenantId, roleCode: currentRoleCode });
  });
}

/**
 * Set BOTH user + tenant context in a transaction (for cases where
 * the caller has already verified the session).
 */
export async function setAuthenticatedContext(
  tx: TransactionClient,
  userId: string,
  tenantId: string
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
  await setTenantContext(tx, tenantId);
}
