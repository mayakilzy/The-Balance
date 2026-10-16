# ADR-0003 — Tenant Isolation Strategy

**Date:** 2026-10-16
**Status:** Accepted (design); implementation in 00-03
**Mission:** 00-01 (design), 00-03 (implementation)

## Context

The Balance is a multi-tenant platform: each legitimate government is a tenant. A tenant's data — evidence, strategies, decisions, audit logs — must never leak to another tenant.

The founder corrected an imprecision in the G00 audit report:

> "ورد في التقرير وصف 'Prisma row-level security'. هذه صياغة تحتاج إلى تدقيق؛ لأن PostgreSQL هو الذي ينفذ Row-Level Security، بينما يجب ضمان ألا تتجاوز استعلامات Prisma سياسات العزل، وأن تُمرّر هوية المستأجر وسياق التفويض بصيرة صحيحة."

(Translation: PostgreSQL implements RLS, not Prisma. Prisma queries must not bypass isolation policies, and tenant identity + delegation context must be passed through correctly.)

## Decision

### Enforcement layer: PostgreSQL Row-Level Security (RLS)

PostgreSQL RLS is the **enforcement** layer. Every tenant-scoped table has RLS policies that filter rows based on `current_setting('app.tenant_id')`. The database itself rejects cross-tenant access — even if the application has a bug.

### Access layer: Prisma

Prisma is the **access** layer. It does NOT enforce isolation; it relies on RLS. To make this safe:

1. **Every tenant-scoped query runs inside a transaction** with `SET LOCAL app.tenant_id = '<id>'`.
2. The helper `withTenant(tenantId, fn)` in `src/lib/security/tenant-context.ts` wraps this pattern.
3. **No tenant-scoped query is ever run outside `withTenant`.** Lint rule + code review enforce this.
4. Prisma's `findMany` without `where: { tenantId }` is allowed ONLY because RLS will filter the result set. Belt-and-suspenders.

### Session context propagation

- Auth.js v5 JWT carries `tenantId` (added in 00-03).
- Server Components + Route Handlers read `tenantId` from `auth()`.
- The `withTenant` helper is called at the start of every tenant-scoped handler.

### System-level queries

Some queries span tenants (e.g., platform-wide metrics, super-admin views). These use `clearTenantContext(tx)` which sets `app.tenant_id = ''`. RLS policies must explicitly allow this for system-role connections only. The application role cannot clear context.

## Implementation plan (mission 00-03)

1. Create SQL migration enabling RLS on `tenants`, `audit_log`, and all future tenant-scoped tables.
2. Define policies: `USING (tenant_id = current_setting('app.tenant_id', true)::text)`.
3. Create two database roles:
   - `balance_app` — application role; RLS enforced; cannot clear context.
   - `balance_admin` — admin role; can `BYPASSRLS` for migrations + ops.
4. Prisma `DATABASE_URL` uses `balance_app`; `DIRECT_URL` uses `balance_admin` for migrations.
5. Negative tests: attempt cross-tenant read → expect empty result. Attempt cross-tenant write → expect RLS rejection.

## What 00-01 ships

Only the helper module (`src/lib/security/tenant-context.ts`) with the `withTenant`, `setTenantContext`, `clearTenantContext`, `getTenantContext` functions. No RLS policies yet — those come in 00-03. The helper is inert until RLS is enabled, but its API is stable so 00-03 is purely additive.

## Alternatives considered

### Application-level isolation (where: { tenantId })
- **Rejected as sole defense:** one forgotten `where` clause = data leak. RLS is defense-in-depth.

### Separate database per tenant
- **Rejected for GROUP 00:** operational overhead (N databases to back up, migrate, monitor). Revisit if a tenant demands physical isolation.

### Schema-per-tenant
- **Rejected:** Prisma doesn't handle dynamic schemas well; migration complexity explodes.

## Consequences

- **Positive:** Database-enforced isolation — application bugs cannot leak data. Single database, simple ops.
- **Negative:** Every query needs a transaction (slight overhead). Prisma queries that bypass transactions are forbidden.
- **Mitigation:** The `withTenant` helper makes the transaction pattern ergonomic. Lint rule (planned for 00-03) catches raw `db.findMany` outside `withTenant`.

## Verification (planned for 00-03)

1. Tenant A creates a record. Tenant B attempts to read it → empty result.
2. Tenant B attempts to update Tenant A's record → RLS rejection.
3. Application role attempts `SET LOCAL app.tenant_id = ''` → permission denied.
4. Audit log entries are visible only to the tenant that created them (or to admin role).
