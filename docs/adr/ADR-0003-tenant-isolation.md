# ADR-0003 — Tenant Isolation Strategy

**Date:** 2026-10-16
**Status:** Accepted (design); implementation starts in 00-02 (per founder directive)
**Mission:** 00-01 (design + helpers + integration test), 00-02 (RLS policies + Country/Tenant models), 00-03 (User + Auth providers)

## Context

The Balance is a multi-tenant platform: each legitimate government is a tenant. A tenant's data — evidence, strategies, decisions, audit logs — must never leak to another tenant.

The founder corrected an imprecision in the G00 audit report:

> "ورد في التقرير وصف 'Prisma row-level security'. هذه صياغة تحتاج إلى تدقيق؛ لأن PostgreSQL هو الذي ينفذ Row-Level Security، بينما يجب ضمان ألا تتجاوز استعلامات Prisma سياسات العزل، وأن تُمرّر هوية المستأجر وسياق التفويض بصورة صحيحة."

(Translation: PostgreSQL implements RLS, not Prisma. Prisma queries must not bypass isolation policies, and tenant identity + delegation context must be passed through correctly.)

## Founder directive (mission 00-01 corrective closure)

> "نبدأ تأسيسه واختباره في 00-02، ولا نؤجله بالكامل إلى 00-03. السبب أن المرحلة 00-02 ستضيف نماذج Country و StateHierarchy وعلاقاتها بالمستأجرين. الأفضل اختبار العزل أثناء بناء هذه العلاقات، لا بعد تراكم الجداول."

(Translation: Start RLS foundation and testing in 00-02, don't fully defer to 00-03. RLS should be tested while building Country/StateHierarchy relationships, not after tables accumulate.)

Additionally, the founder distinguished Country identity from Tenant identity:

> "يجب أن يميز GLM بين هوية الدولة وهوية المستأجر. فالدولة الواحدة قد تخدمها جهات متعددة ذات صلاحيات مختلفة، ولا ينبغي أن يكون Tenant.code = Country.code افتراضاً دائماً."

(Translation: Country identity ≠ Tenant identity. One country may be served by multiple authorized entities with different permissions; do not assume Tenant.code = Country.code.)

## Decision

### Enforcement layer: PostgreSQL Row-Level Security (RLS)

PostgreSQL RLS is the **enforcement** layer. Every tenant-scoped table has RLS policies that filter rows based on `current_setting('app.tenant_id')`. The database itself rejects cross-tenant access — even if the application has a bug.

### Access layer: Prisma

Prisma is the **access** layer. It does NOT enforce isolation; it relies on RLS. To make this safe:

1. **Every tenant-scoped query runs inside a transaction** with `set_config('app.tenant_id', '<id>', true)`.
2. The helper `withTenant(tenantId, fn)` in `src/lib/security/tenant-context.ts` wraps this pattern.
3. **No tenant-scoped query is ever run outside `withTenant`.** Lint rule + code review enforce this.
4. Prisma's `findMany` without `where: { tenantId }` is allowed ONLY because RLS will filter the result set. Belt-and-suspenders.

### SQL implementation: `set_config()` (not `SET LOCAL`)

The helpers use `set_config('app.tenant_id', $1, true)` instead of `SET LOCAL app.tenant_id = $1` because:

- `set_config()` accepts the value as a function argument → Prisma's tagged-template parameterization works correctly.
- `SET LOCAL` does not accept bind parameters in PostgreSQL — Prisma would have to interpolate the value, creating an injection risk.
- The third argument `true` makes the setting LOCAL (transaction-scoped), equivalent to `SET LOCAL`.

Verified by `tests/integration/tenant-context.integration.test.ts` (runs in CI against PostgreSQL 16):
- `setTenantContext` sets the value correctly.
- `getTenantContext` reads it back.
- `clearTenantContext` resets it.
- The setting does NOT leak outside the transaction.
- A malicious tenantId containing SQL is stored verbatim (no injection).
- Empty strings and over-length values are rejected before reaching SQL.

### Country vs Tenant separation

Per founder directive:
- `Country` is a geographic/political entity (Syria, Jordan, etc.).
- `Tenant` is an authorized organization operating within a country.
- One Country may have multiple Tenants (e.g., different government bodies, different levels of administration).
- `Tenant.code` is NOT `Country.code` by default. They are independent identifiers.
- A Tenant MAY reference a Country (foreign key), but a Country does not "own" a Tenant.

### Session context propagation

- Auth.js v5 JWT carries `tenantId` (added in 00-03 when User model + providers land).
- Server Components + Route Handlers read `tenantId` from `auth()`.
- The `withTenant` helper is called at the start of every tenant-scoped handler.
- In 00-02, integration tests use fixed test tenant identities until the User model exists in 00-03.

### System-level queries

Some queries span tenants (e.g., platform-wide metrics, super-admin views). These use `clearTenantContext(tx)` which sets `app.tenant_id = ''`. RLS policies must explicitly allow this for system-role connections only. The application role cannot clear context.

## Implementation plan (mission 00-02, per founder directive)

1. Create SQL migration enabling RLS on `tenants`, `audit_log`, and the new `countries` + `state_hierarchy` tables.
2. Define policies: `USING (tenant_id = current_setting('app.tenant_id', true)::text)`.
3. Create two database roles:
   - `balance_app` — application role; RLS enforced; cannot clear context.
   - `balance_admin` — admin role; can `BYPASSRLS` for migrations + ops.
4. Prisma `DATABASE_URL` uses `balance_app`; `DIRECT_URL` uses `balance_admin` for migrations.
5. Negative tests: attempt cross-tenant read → expect empty result. Attempt cross-tenant write → expect RLS rejection.
6. Country/Tenant relationship tests: verify one country can have multiple tenants, tenants are isolated from each other.

## What 00-01 ships

- The helper module (`src/lib/security/tenant-context.ts`) with `withTenant`, `setTenantContext`, `clearTenantContext`, `getTenantContext` functions.
- Integration test (`tests/integration/tenant-context.integration.test.ts`) verifying the helpers against real PostgreSQL 16 in CI.
- RLS policies are NOT created yet — those come in 00-02. The helper is functional (sets the session variable correctly) but unenforced (no RLS policies to consume it yet).

## Alternatives considered

### Application-level isolation (where: { tenantId })
- **Rejected as sole defense:** one forgotten `where` clause = data leak. RLS is defense-in-depth.

### Separate database per tenant
- **Rejected for GROUP 00:** operational overhead (N databases to back up, migrate, monitor). Revisit if a tenant demands physical isolation.

### Schema-per-tenant
- **Rejected:** Prisma doesn't handle dynamic schemas well; migration complexity explodes.

### `SET LOCAL` with manual escaping
- **Rejected:** `SET LOCAL` doesn't accept bind parameters, so we'd need to escape the tenantId ourselves. `set_config()` is the PostgreSQL-sanctioned way to set a custom GUC with a parameterized value.

## Consequences

- **Positive:** Database-enforced isolation — application bugs cannot leak data. Single database, simple ops. SQL-injection-safe tenant context setting.
- **Negative:** Every query needs a transaction (slight overhead). Prisma queries that bypass transactions are forbidden.
- **Mitigation:** The `withTenant` helper makes the transaction pattern ergonomic. Lint rule (planned for 00-02) catches raw `db.findMany` outside `withTenant`.

## Verification (planned for 00-02)

1. Tenant A creates a record. Tenant B attempts to read it → empty result.
2. Tenant B attempts to update Tenant A's record → RLS rejection.
3. Application role attempts `SET LOCAL app.tenant_id = ''` → permission denied.
4. Audit log entries are visible only to the tenant that created them (or to admin role).
5. One Country with two Tenants — each tenant sees only its own data, both reference the same Country.
