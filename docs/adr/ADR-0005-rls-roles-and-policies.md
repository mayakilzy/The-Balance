# ADR-0005 — RLS Roles and Policy Design

**Date:** 2026-10-16
**Status:** Accepted (founder-mandated)
**Mission:** 00-02

## Context

The founder directed in 00-02:

> "ابدأ تأسيس PostgreSQL Row-Level Security مع أدوار تطبيق محدودة الصلاحيات."
> (Begin PostgreSQL RLS with limited-privilege application roles.)

> "اختبر العزل باستخدام اتصالات وأدوار قاعدة البيانات الفعلية، وليس Prisma mocks أو دور مالك الجداول الذي قد يتجاوز RLS."
> (Test isolation using real DB connections and roles, not Prisma mocks or the table-owner role that may bypass RLS.)

This means:
1. The application must connect as a non-superuser, non-owner role.
2. RLS must be enforced — not bypassable by the app role.
3. Tests must use the app role (not admin) to prove RLS works.

## Decision

### Two database roles

| Role | Purpose | RLS | Used by |
|---|---|---|---|
| `balance_admin` | Migrations, schema changes, ops | `BYPASSRLS` | `DIRECT_URL` in Prisma migrate, CI migration step |
| `balance_app` | Application runtime queries | Enforced | `DATABASE_URL` in app + integration tests |

- `balance_admin` owns the tables (created via migrations). It can bypass RLS for ops.
- `balance_app` is granted DML (SELECT/INSERT/UPDATE/DELETE) on tables but NOT DDL. RLS policies apply.
- The application NEVER connects as `balance_admin` at runtime.

### RLS policy patterns

#### PRIVATE tables (tenant-scoped: `audit_log`, future `evidence`, `strategy`, `task`)

```sql
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;  -- applies even to table owner

CREATE POLICY tenant_isolation ON audit_log
  FOR ALL
  TO balance_app
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
```

- `USING` — filters existing rows on SELECT/UPDATE/DELETE.
- `WITH CHECK` — validates new rows on INSERT/UPDATE.
- `FORCE ROW LEVEL SECURITY` — ensures even the table owner (`balance_admin`) is subject to RLS unless they explicitly `BYPASSRLS`. This is defense-in-depth.
- `current_setting('app.tenant_id', true)` returns NULL if unset → comparison is false → no rows visible. **Fail-closed.**

#### PUBLIC tables (no tenant: `countries`, `state_hierarchy`, `institutions`, `role_references`, `source_registry`, `public_knowledge`)

```sql
ALTER TABLE countries ENABLE ROW LEVEL SECURITY;
ALTER TABLE countries FORCE ROW LEVEL SECURITY;

CREATE POLICY public_read ON countries
  FOR SELECT
  TO balance_app
  USING (true);

CREATE POLICY admin_write ON countries
  FOR ALL
  TO balance_admin
  USING (true)
  WITH CHECK (true);
```

- `balance_app` can SELECT but NOT INSERT/UPDATE/DELETE.
- `balance_admin` can do anything (for seeding/migration).
- This enforces "public knowledge is shared, but only admins curate it."

#### Special case: `tenants` table

The `tenants` table itself is tricky:
- A tenant needs to read its OWN row (to know its `countryId`, `displayName`).
- A tenant must NOT see other tenants' rows.

```sql
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_self_read ON tenants
  FOR SELECT
  TO balance_app
  USING (id = current_setting('app.tenant_id', true));
```

- A tenant sees only its own row.
- No INSERT/UPDATE/DELETE for `balance_app` (tenants are created by admin, not by the app at runtime).

### Setting `app.tenant_id`

The application sets `app.tenant_id` via `set_config('app.tenant_id', $1, true)` inside a transaction (see ADR-0003, updated in 00-01 corrective closure).

- `balance_app` can call `set_config()` for custom GUCs — this is allowed by default in PostgreSQL.
- `balance_app` CANNOT call `SET LOCAL role` or escalate to `balance_admin` — those are superuser-only operations.

### Sequence grants

`audit_log.id` is a `BIGSERIAL`. The sequence `audit_log_id_seq` must be granted to `balance_app`:

```sql
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO balance_app;
```

Without this, INSERT fails with "permission denied for sequence".

### Migration application

Migrations run as `balance_admin` (via `DIRECT_URL`). The migration SQL must:
1. Create tables (owner = `balance_admin`).
2. Create roles `balance_app` + `balance_admin` (IF NOT EXISTS).
3. Grant DML on all tables to `balance_app`.
4. Grant sequence usage to `balance_app`.
5. Enable + FORCE RLS on all tables.
6. Create policies.

### CI setup

The CI workflow must:
1. Start with the default `postgres` superuser (from the service container).
2. Run a setup script that creates `balance_admin` + `balance_app` roles.
3. Set `DATABASE_URL` (app role) + `DIRECT_URL` (admin role) for subsequent steps.
4. Run migrations as `balance_admin`.
5. Run tests as `balance_app`.

## Alternatives considered

### Single role with column-level tenant filter
- **Rejected:** founder explicitly requires RLS with limited-privilege roles. Application-level filters are insufficient.

### Application role = table owner
- **Rejected:** founder explicitly forbids. Table owner bypasses RLS by default, defeating the purpose.

### Per-tenant database role
- **Considered:** e.g., `balance_app_tenant_a`, `balance_app_tenant_b`.
- **Rejected for 00-02:** operational overhead. The `app.tenant_id` GUC approach achieves the same isolation with one role. Revisit if a tenant demands DB-level role isolation.

## Consequences

- **Positive:** Defense-in-depth. Application bugs cannot leak data — RLS enforces isolation at the DB level. Tests prove isolation using the actual app role.
- **Negative:** Slightly more complex setup (two roles, sequence grants, FORCE RLS). Migration SQL is longer.
- **Mitigation:** The migration SQL is idempotent and well-commented. CI setup is a single script.

## Verification (planned for 00-02)

1. **Cross-tenant read blocked:** Tenant A sets `app.tenant_id='A'`, queries `audit_log` → sees only A's rows. Tenant B's rows are invisible.
2. **Cross-tenant write blocked:** Tenant A attempts to INSERT a row with `tenant_id='B'` → RLS `WITH CHECK` rejects.
3. **Cross-tenant update blocked:** Tenant A attempts to UPDATE Tenant B's row → RLS `USING` returns 0 rows affected.
4. **Cross-tenant delete blocked:** Same as update.
5. **Fail-closed:** With `app.tenant_id` unset (empty/NULL), all PRIVATE tables return 0 rows.
6. **PUBLIC reads work:** Any tenant can SELECT from `countries`, `public_knowledge`, etc.
7. **PUBLIC writes blocked for app role:** `balance_app` cannot INSERT/UPDATE/DELETE `public_knowledge`.
8. **Tenants table self-isolation:** Tenant A sees only its own row in `tenants`.
9. **All tests use `balance_app` role** — not the admin/superuser role.
