// ============================================================
// permissions.ts — RBAC/ABAC permission service
// ------------------------------------------------------------
// Default-deny: if no membership or suspended, reject.
// Client cannot send arbitrary tenantId — it comes from the session.
//
// Per ADR-0008 (RBAC/ABAC design).
// ============================================================
import type { RoleReference } from "@prisma/client";
import { db } from "@/lib/db";
import type { Session } from "next-auth";

// Permission catalog — what each role can do.
// This is the ABAC layer: action + resource + role.
// In 00-03, this is a simple static map; future missions may move it
// to the role_references.permissions JSON column.
const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [
    "tenant:read",
    "tenant:write",
    "evidence:read",
    "evidence:write",
    "evidence:verify",
    "evidence:delete",
    "strategy:read",
    "strategy:write",
    "strategy:approve",
    "task:read",
    "task:write",
    "user:read",
    "user:write",
    "membership:read",
    "membership:write",
    "audit:read",
  ],
  analyst: [
    "tenant:read",
    "evidence:read",
    "evidence:write",
    "strategy:read",
    "strategy:write",
    "task:read",
    "task:write",
    "audit:read",
  ],
  reviewer: [
    "tenant:read",
    "evidence:read",
    "evidence:verify",
    "strategy:read",
    "strategy:approve",
    "task:read",
    "audit:read",
  ],
  observer: [
    "tenant:read",
    "evidence:read",
    "strategy:read",
    "task:read",
    "audit:read",
  ],
};

export function hasPermission(
  session: Session | null,
  permission: string
): boolean {
  if (!session || !session.user) return false;
  if (session.user.membershipStatus !== "active") return false;
  const roleCode = session.user.roleCode;
  if (!roleCode) return false;
  const perms = ROLE_PERMISSIONS[roleCode];
  if (!perms) return false;
  return perms.includes(permission);
}

export function requirePermission(
  session: Session | null,
  permission: string
): void {
  if (!hasPermission(session, permission)) {
    throw new PermissionDeniedError(permission);
  }
}

// ============================================================
// CURRENT-ROLE AUTHORIZATION (00-04 pre-setup)
// ------------------------------------------------------------
// For sensitive operations, the session roleCode may be stale.
// This helper fetches the CURRENT role from the DB via auth-bootstrap
// and checks permission against it, not the JWT role.
// ============================================================
import { loadMembershipForTenant, verifyUserActive } from "@/lib/auth-bootstrap";

export async function requirePermissionWithCurrentRole(
  session: Session | null,
  permission: string
): Promise<void> {
  if (!session || !session.user) {
    throw new PermissionDeniedError(permission);
  }
  const userId = session.user.id;
  const tenantId = session.user.tenantId;
  if (!userId || !tenantId) {
    throw new PermissionDeniedError(permission);
  }

  // Verify user is still active
  const userActive = await verifyUserActive(userId);
  if (!userActive) {
    throw new PermissionDeniedError(permission);
  }

  // Fetch CURRENT membership role from DB (not stale JWT)
  const membership = await loadMembershipForTenant(userId, tenantId);
  if (!membership || membership.status !== "active") {
    throw new PermissionDeniedError(permission);
  }

  // Check permission against CURRENT role
  const currentRoleCode = membership.roleCode;
  const perms = ROLE_PERMISSIONS[currentRoleCode];
  if (!perms || !perms.includes(permission)) {
    throw new PermissionDeniedError(permission);
  }
}

export class PermissionDeniedError extends Error {
  readonly permission: string;
  constructor(permission: string) {
    super(`Permission denied: ${permission}`);
    this.name = "PermissionDeniedError";
    this.permission = permission;
  }
}

export function isAuthenticated(session: Session | null): boolean {
  return !!session && !!session.user && session.user.membershipStatus === "active";
}

export function getTenantId(session: Session | null): string | null {
  if (!isAuthenticated(session)) return null;
  return session!.user.tenantId;
}

export function getUserId(session: Session | null): string | null {
  if (!session || !session.user) return null;
  return session.user.id;
}

// Role management helpers (for seed + tests)
export async function getRolePermissions(
  roleCode: string
): Promise<string[] | null> {
  return ROLE_PERMISSIONS[roleCode] ?? null;
}

export async function loadRoleFromDb(
  roleCode: string
): Promise<RoleReference | null> {
  return db.roleReference.findUnique({ where: { code: roleCode } });
}
