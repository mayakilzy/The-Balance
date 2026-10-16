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
    "strategy:read",
    "strategy:write",
    "strategy:approve",
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
    "audit:read",
  ],
  reviewer: [
    "tenant:read",
    "evidence:read",
    "strategy:read",
    "strategy:approve",
    "audit:read",
  ],
  observer: [
    "tenant:read",
    "evidence:read",
    "strategy:read",
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
