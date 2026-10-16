// ============================================================
// auth-bootstrap.ts — Authentication bootstrap client (least-privilege)
// ------------------------------------------------------------
// ISOLATED PrismaClient for auth-time queries ONLY.
//
// LEAST-PRIVILEGE (final runtime acceptance):
//   Uses balance_auth role (dedicated, read-only, no BYPASSRLS).
//   balance_auth has SELECT on ONLY the columns needed for auth:
//     users: id, email, name, passwordHash, status
//     memberships: userId, tenantId, roleCode, status
//     tenants: id
//   It CANNOT write, CANNOT do DDL, CANNOT bypass RLS.
//
// WHY NOT balance_admin?
//   balance_admin has BYPASSRLS + SUPERUSER (in CI). Using it for auth
//   gives the auth path more privilege than needed. balance_auth is
//   scoped to exactly what auth requires.
//
// SECURITY:
//   - This client is a singleton (one connection pool).
//   - Used ONLY in auth-bootstrap.ts + auth.ts.
//   - All other app code uses `db` (balance_app) with RLS enforced.
//   - Queries are read-only (SELECT); no writes via this client.
//
// Per ADR-0007 (updated: least-privilege auth bootstrap).
// ============================================================
import { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";

// Singleton — one balance_auth client per process.
let _bootstrapClient: PrismaClient | null = null;

function getBootstrapClient(): PrismaClient {
  if (_bootstrapClient === null) {
    // Production: AUTH_DATABASE_URL MUST be set explicitly.
    // No fallback to DIRECT_URL string swap (founder directive 00-04 pre-setup).
    const authUrl = process.env.AUTH_DATABASE_URL;
    if (!authUrl) {
      throw new Error(
        "AUTH_DATABASE_URL is not set. This env var MUST be provided " +
          "explicitly in all environments (dev, CI, production). " +
          "Do not rely on DIRECT_URL string substitution."
      );
    }
    _bootstrapClient = new PrismaClient({
      datasources: { db: { url: authUrl } },
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
// AUTH BOOTSTRAP QUERIES (read-only, via balance_auth)
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
 * Uses balance_auth (read-only, no BYPASSRLS but RLS-exempt for auth).
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
 * Used by switch-tenant + withAuthenticatedTenant (current-role check).
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
 */
export async function verifyUserActive(userId: string): Promise<boolean> {
  const client = getBootstrapClient();
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  return user?.status === "active";
}
