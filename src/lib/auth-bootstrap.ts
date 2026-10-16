// ============================================================
// auth-bootstrap.ts — Authentication bootstrap client
// ------------------------------------------------------------
// ISOLATED PrismaClient for auth-time queries ONLY.
//
// WHY THIS EXISTS:
//   At signin time, we don't know who the user is yet, so we can't set
//   app.user_id. But RLS on `users` requires app.user_id to read any row.
//   Solution: use a dedicated client connected as balance_admin
//   (BYPASSRLS) for the MINIMAL set of queries needed to authenticate:
//     1. findUserByEmail(email) — to verify password
//     2. loadMembershipForTenant(userId, tenantId) — to switch tenant
//     3. loadFirstActiveMembership(userId) — for initial signin
//
// SECURITY:
//   - This client is used ONLY in auth-bootstrap.ts + auth.ts.
//   - All other app code uses `db` (balance_app) with RLS enforced.
//   - balance_admin has BYPASSRLS but is NEVER used for general queries.
//   - The client is a singleton (one connection pool).
//   - Queries are read-only (SELECT); no writes via this client.
//
// Per ADR-0007 (updated: auth bootstrap design).
// ============================================================
import { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";

// Singleton — one balance_admin client per process.
let _bootstrapClient: PrismaClient | null = null;

function getBootstrapClient(): PrismaClient {
  if (_bootstrapClient === null) {
    _bootstrapClient = new PrismaClient({
      datasources: { db: { url: env.DIRECT_URL } },
      log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }
  return _bootstrapClient;
}

export async function disconnectBootstrap(): Promise<void> {
  if (_bootstrapClient !== null) {
    await _bootstrapClient.$disconnect();
    _bootstrapClient = null;
  }
}

// ============================================================
// AUTH BOOTSTRAP QUERIES (read-only)
// ============================================================

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  status: string;
}

/**
 * Find a user by email for authentication.
 * Uses balance_admin (BYPASSRLS) because at signin time we don't have
 * app.user_id set yet. This is the auth bootstrap — the ONLY place
 * that reads users without RLS.
 */
export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const client = getBootstrapClient();
  const user = await client.user.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      status: true,
    },
  });
  return user;
}

export interface AuthMembership {
  tenantId: string;
  roleCode: string;
  status: string;
}

/**
 * Load the FIRST active membership for a user (for initial signin).
 * Uses balance_admin (BYPASSRLS) — auth bootstrap.
 */
export async function loadFirstActiveMembership(
  userId: string
): Promise<AuthMembership | null> {
  const client = getBootstrapClient();
  const membership = await client.membership.findFirst({
    where: { userId, status: "active" },
    orderBy: { createdAt: "asc" },
    select: {
      tenantId: true,
      roleCode: true,
      status: true,
    },
  });
  return membership;
}

/**
 * Load a SPECIFIC membership for a user in a specific tenant.
 * Used by switch-tenant to verify the user can switch to that tenant.
 * Uses balance_admin (BYPASSRLS) — auth bootstrap.
 */
export async function loadMembershipForTenant(
  userId: string,
  tenantId: string
): Promise<AuthMembership | null> {
  const client = getBootstrapClient();
  const membership = await client.membership.findFirst({
    where: { userId, tenantId, status: "active" },
    select: {
      tenantId: true,
      roleCode: true,
      status: true,
    },
  });
  return membership;
}

/**
 * Verify a user's status is still active (re-check on session refresh).
 * Uses balance_admin (BYPASSRLS) — auth bootstrap.
 */
export async function verifyUserActive(userId: string): Promise<boolean> {
  const client = getBootstrapClient();
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  return user?.status === "active";
}
