// ============================================================
// privileged-db.ts — Privileged Prisma client for snapshot approval
// ------------------------------------------------------------
// G03-06 Trust Boundary Closure (Migration 32):
//
// balance_app is the standard DB role for all app operations. It sets
// GUCs (app.tenant_id, app.user_id) inside transactions for RLS scoping.
// But a direct balance_app DB connection can set these GUCs to ANY value
// — they are caller-controllable and do NOT authenticate the caller.
//
// For privileged operations (snapshot approval), we need a trust
// boundary that balance_app CANNOT cross. This module provides a
// SEPARATE Prisma client connected as `balance_snapshot_approver`
// — a LOGIN role with a password known ONLY to the application server
// (stored in PRIVILEGED_DATABASE_URL env var).
//
// Trust chain:
//   1. User authenticates via Auth.js (bcrypt password verification)
//   2. App loads current membership (via balance_auth, read-only)
//   3. App verifies lead authorization (TypeScript check)
//   4. App opens privileged connection (balance_snapshot_approver)
//   5. App sets GUCs from the verified session
//   6. Privileged connection performs UPDATE + audit INSERT atomically
//
// Attacker with balance_app credentials:
//   - CANNOT connect as balance_snapshot_approver (no password)
//   - CANNOT SET ROLE to it (not a member)
//   - balance_app's UPDATE on shared_snapshots blocked by G03-01 trigger
//   - NO path to approve snapshots with forged identity
// ============================================================
import { PrismaClient } from "@prisma/client";

const PRIVILEGED_URL = process.env.PRIVILEGED_DATABASE_URL;

if (!PRIVILEGED_URL) {
  // In test environments without the privileged role, we still need
  // the module to load. The service code checks for availability before
  // using it.
  console.warn(
    "PRIVILEGED_DATABASE_URL is not set. Snapshot approval will fail."
  );
}

const globalForPrivileged = globalThis as unknown as {
  __privilegedPrismaClient?: PrismaClient;
};

export const privilegedDb =
  globalForPrivileged.__privilegedPrismaClient ??
  (PRIVILEGED_URL
    ? new PrismaClient({
        datasources: { db: { url: PRIVILEGED_URL } },
        log:
          process.env.NODE_ENV === "development"
            ? ["warn", "error"]
            : ["error"],
      })
    : (null as unknown as PrismaClient)); // null when URL not set — service checks before use

if (process.env.NODE_ENV !== "production") {
  globalForPrivileged.__privilegedPrismaClient = privilegedDb;
}
