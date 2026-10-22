# ADR-0008 — RBAC/ABAC Permission Design

**Date:** 2026-10-16
**Status:** Accepted
**Mission:** 00-03

## Context

The Balance requires permission checks beyond authentication. Not all authenticated users can do everything. The founder directed:
- RBAC and ABAC with default-deny
- Only authorized roles can approve
- Forged client tenant parameter does not bypass server checks

## Decision

### RBAC (Role-Based Access Control)

Four roles seeded in `role_references`:
- `admin` — full tenant access
- `analyst` — read + create evidence/strategy
- `reviewer` — read + approve/reject strategies
- `observer` — read only

Each role has a permission catalog in `src/lib/permissions.ts`:
```typescript
const ROLE_PERMISSIONS = {
  admin: ["tenant:read", "tenant:write", "evidence:read", "evidence:write", ...],
  analyst: ["tenant:read", "evidence:read", "evidence:write", ...],
  reviewer: ["tenant:read", "evidence:read", "strategy:read", "strategy:approve", ...],
  observer: ["tenant:read", "evidence:read", "strategy:read", ...],
};
```

Permission format: `resource:action` (e.g., `evidence:write`, `strategy:approve`).

### ABAC (Attribute-Based Access Control)

ABAC attributes:
- **User**: userId, status (active/suspended/disabled)
- **Tenant**: tenantId, status (active/suspended/archived)
- **Membership**: roleCode, status (active/revoked)
- **Resource**: tenant-scoped (PRIVATE) or global (PUBLIC)
- **Action**: read/write/approve

ABAC is enforced via:
1. **RLS policies** (DB level) — tenant isolation on PRIVATE tables.
2. **`withAuthenticatedTenant`** (app level) — verifies membership before setting DB context.
3. **`hasPermission`** (app level) — checks role's permission catalog.

### Default-deny

- If `session.user.membershipStatus !== "active"` → deny.
- If `roleCode` is null or unknown → deny.
- If permission is not in the role's catalog → deny.
- If RLS context is not set → deny (fail-closed at DB level).

### Permission helpers

```typescript
hasPermission(session, "evidence:write"): boolean
requirePermission(session, "evidence:write"): void  // throws PermissionDeniedError
isAuthenticated(session): boolean
getTenantId(session): string | null  // from session, NOT from client input
```

### Client cannot forge tenantId

- `tenantId` comes from the JWT (set by `jwt` callback from DB lookup).
- The client cannot override it via request parameters.
- `switch-tenant` endpoint VERIFIES membership before switching.
- `withAuthenticatedTenant` sets `app.tenant_id` from the session, not from request input.

## Alternatives considered

### CASL (JavaScript authorization library)
- **Considered**: Provides rule-based authorization.
- **Rejected for 00-03**: Overkill. The permission catalog is small (4 roles, ~12 permissions). A static map is simpler and sufficient. Revisit if permission complexity grows.

### Database-driven permission catalog (in `role_references.permissions` JSON)
- **Considered**: Store permissions in the DB for runtime configuration.
- **Deferred**: The `permissions` column exists in `role_references` (seeded empty). In 00-03, the static map in `permissions.ts` is the source of truth. A future mission may migrate to DB-driven permissions for runtime configurability.

### Policy as code (OPA/Rego)
- **Rejected**: Adds operational complexity. Not justified for 00-03's scope.

## Consequences

- **Positive**: Simple, explicit permission checks. Default-deny. Client cannot forge context.
- **Negative**: Permission changes require code deployment (not runtime). Acceptable for 00-03.
- **Future impact**: When `evidence` (00-04) and `strategy` (00-05) are added, they use `requirePermission(session, "evidence:write")` etc. The permission catalog may expand but the pattern stays the same.

## Verification (planned for 00-03)

1. `admin` can access all permission-gated endpoints.
2. `analyst` cannot approve strategies (no `strategy:approve`).
3. `observer` cannot write evidence.
4. Unauthenticated requests → 401.
5. Authenticated but no membership → 403.
6. Client sends forged tenantId → ignored (session tenantId used).
