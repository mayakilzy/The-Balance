# ADR-0005 — RLS Roles and Policy Design

**Date:** 2026-10-16
**Status:** Accepted (founder-mandated); updated 00-02 corrective closure
**Mission:** 00-02 (initial + corrective closure)

## Updates in corrective closure (00-02)

1. **Audit log append-only**: `balance_app` can only SELECT + INSERT on `audit_log`. UPDATE and DELETE are revoked at the GRANT level and have no RLS policy. See §"Audit log append-only enforcement" below.

2. **Role setup separated from migrations**: Role creation + password management moved to `scripts/setup-roles.sql`. Migration 0002 historically created roles; going forward, this script is the canonical source. See §"Role setup separation" below.

3. **CI vs production privilege distinction**: CI grants SUPERUSER to `balance_admin` for CREATE EXTENSION. Production must NOT. See §"CI vs production" below.

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

## Audit log append-only enforcement (corrective closure)

**Problem identified by founder:** The original `audit_log` RLS policy used `FOR ALL TO balance_app`, which allowed UPDATE and DELETE of the tenant's own rows. This violates the append-only contract — an operational user could delete audit evidence of their own actions.

**Solution (migration 20261016000003):**
1. Dropped the `FOR ALL` policy.
2. Created two separate policies:
   - `audit_log_select_balance_app` (FOR SELECT) — read own tenant's rows.
   - `audit_log_insert_balance_app` (FOR INSERT) — write own tenant's rows.
3. No UPDATE or DELETE policy exists for `balance_app` → RLS denies these commands entirely.
4. `REVOKE UPDATE, DELETE ON audit_log FROM balance_app` — belt-and-suspenders at the GRANT level.

**Maintenance path (balance_admin):**
- `balance_admin` retains all privileges (BYPASSRLS).
- For legitimate operations (e.g., GDPR erasure, court-ordered correction), an admin connects as `balance_admin` and modifies `audit_log` directly.
- This admin action MUST be logged in a separate audit entry (recording who, when, why, what was changed).
- The application NEVER connects as `balance_admin` at runtime.

**Verified by integration tests:**
- Test 11: "Tenant A cannot UPDATE its own audit_log row (append-only)" — proves UPDATE is blocked.
- Test 12: "Tenant A cannot DELETE its own audit_log row (append-only)" — proves DELETE is blocked.
- Test 15: "balance_admin can UPDATE/DELETE audit_log (documented maintenance path)" — proves the admin path works for legitimate maintenance.

## Role setup separation (corrective closure)

**Problem identified by founder:** Database role names + dev passwords were hardcoded inside migration 0002. This conflates schema management with security configuration, and risks dev passwords becoming permanent production settings.

**Solution:**
1. Created `scripts/setup-roles.sql` as the canonical role management script.
2. This script:
   - Creates `balance_admin` + `balance_app` (idempotent DO block).
   - Sets dev-only passwords (documented as dev-only).
   - Grants schema privileges (CREATE for admin, USAGE for app).
   - Pre-creates pgvector extension (requires superuser).
3. CI runs this script as the postgres superuser before migrations.
4. Docker-compose mounts this script as `init-roles.sql` in `/docker-entrypoint-initdb.d/`.
5. Migration 0002's role creation remains as historical bootstrap (idempotent, harmless).
6. Future migrations (0003+) do NOT touch roles.

**Production deployment:**
- DBA runs `setup-roles.sql` with password overrides via environment.
- DBA rotates the dev-only passwords set in migration 0002.
- DBA pre-installs pgvector extension (no SUPERUSER grant to balance_admin).
- `DATABASE_URL` uses `balance_app`; `DIRECT_URL` uses `balance_admin`.

## CI vs production privileges (corrective closure)

**Problem identified by founder:** CI grants SUPERUSER to `balance_admin` (for CREATE EXTENSION). This must NOT become a production setting.

**Solution:**
- CI workflow explicitly documents: "CI-ONLY: grant SUPERUSER to balance_admin for CREATE EXTENSION."
- The `Verify role privileges` CI step asserts:
  - `balance_app` is NOT superuser.
  - `balance_app` does NOT have BYPASSRLS.
  - `balance_app` does NOT have CREATE on schema public.
  - `balance_app` does NOT have UPDATE/DELETE on audit_log.
- Production checklist documented in `scripts/setup-roles.sql`:
  - balance_admin is NOSUPERUSER (only BYPASSRLS).
  - balance_app is NOSUPERUSER, NOBYPASSRLS, no DDL.
  - Passwords rotated from dev defaults.
  - pgvector pre-installed by DBA.
