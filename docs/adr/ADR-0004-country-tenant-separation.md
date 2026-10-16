# ADR-0004 — Country/Tenant Separation + PUBLIC vs PRIVATE Scope

**Date:** 2026-10-16
**Status:** Accepted (founder-mandated)
**Mission:** 00-02

## Context

The Balance is a multi-tenant platform where each tenant is an authorized organization (typically a government body) operating within a country. The founder directed:

> "لا تجعل Country وTenant كياناً واحداً؛ يمكن أن تتعدد الجهات المستأجرة المرتبطة بالدولة نفسها."
> (Don't make Country and Tenant one entity; multiple tenant organizations can be linked to the same country.)

> "يجب ألا تؤدي سياسات RLS إلى عزل المعرفة العامة عن الدول. فالبيانات الدولية والأبحاث والمؤشرات العامة يمكن مشاركتها وفق صلاحياتها، بينما تبقى الخطط الداخلية والوثائق الحكومية الخاصة معزولة بين المستأجرين."
> (RLS must NOT isolate public knowledge from countries. International data, research, and public indicators can be shared per their access policies; internal plans and government documents stay isolated between tenants.)

This directive creates a two-axis access model:
- **Axis 1: Country** — the geographic/political entity (Syria, Jordan, etc.).
- **Axis 2: Tenant** — the authorized organization operating within a country.

And a two-scope data classification:
- **PUBLIC scope** — international research, indicators, public references. Visible to all authenticated tenants regardless of country.
- **PRIVATE scope** — internal plans, government documents, tenant-specific data. Visible only to the tenant that owns it.

## Decision

### Country ≠ Tenant

- `Country` is a geographic/political entity. Identified by `id` (cuid) + `iso3` (unique, e.g. "SYR", "JOR"). Multiple tenants can reference the same country.
- `Tenant` is an authorized organization. Identified by `id` (cuid) + `code` (unique, e.g. "SY-MIN-PLAN", "SY-CB"). Each tenant references exactly one `Country` via `countryId`.
- A Country does not "own" a Tenant. The relationship is `Tenant → Country` (many-to-one), not the reverse.
- `Tenant.code` is independent of `Country.iso3`. Do NOT assume `Tenant.code` starts with `Country.iso3`.

### State Hierarchy

- `StateHierarchy` represents administrative units within a country: nation → province → district → municipality → neighborhood.
- Each `StateHierarchy` row references a `Country` and an optional parent `StateHierarchy` (for nested units).
- `StateHierarchy` is PUBLIC by default — administrative geography is public knowledge. A tenant does not "own" a province.
- Tenants reference `StateHierarchy` rows to scope their private data (e.g., "this strategy applies to Province X").

### Institutions

- `Institution` represents a government body within a country: ministry, agency, authority.
- `Institution` references a `Country` and an optional parent `Institution` (e.g., a directorate within a ministry).
- `Institution` is PUBLIC by default — institutional structure is public knowledge.
- Tenants reference `Institution` rows to attribute private data (e.g., "this plan is owned by Ministry Y").

### Role Reference

- `RoleReference` is a controlled vocabulary of roles a user can hold within a tenant: `admin`, `analyst`, `reviewer`, `observer`, etc.
- `RoleReference` is PUBLIC — the role catalog is shared across tenants.
- Tenants assign roles to users (in 00-03) from this catalog.

### Source Registry

- `SourceRegistry` is a catalog of evidence sources: international organizations, academic databases, government statistics offices.
- `SourceRegistry` is PUBLIC — source metadata (name, type, license, URL) is shared.
- Tenants reference `SourceRegistry` entries when creating private `Evidence` rows (in 00-04).

### Public Knowledge

- `PublicKnowledge` is a table for international research, indicators, and references that any tenant can read.
- `PublicKnowledge` rows have NO `tenantId` — they are global.
- RLS policy: any authenticated tenant can SELECT; no tenant can INSERT/UPDATE/DELETE (only `balance_admin` role can, for curation).
- This is the founder's "shared knowledge" channel.

### PRIVATE vs PRIVATE — Tenant Isolation

- All tenant-scoped tables (`AuditLog` from 00-01, plus future `Evidence`, `Strategy`, `Task`, etc.) carry `tenantId`.
- RLS policy: a row is visible only if `tenant_id = current_setting('app.tenant_id')`.
- This is the founder's "isolated private data" channel.

### Fail-closed default

- If `app.tenant_id` is not set (empty string or NULL), RLS denies access to all PRIVATE rows.
- The `balance_app` role cannot set `app.tenant_id` to an arbitrary value — it can only set it within a transaction started by the application.
- The `balance_admin` role can bypass RLS for migrations and ops, but is never used by the application at runtime.

## Data model summary (Prisma)

```prisma
model Country {
  id          String   @id @default(cuid())
  iso3        String   @unique          // "SYR", "JOR"
  iso2        String?  @unique          // "SY", "JO"
  displayName String
  status      String   @default("active") // active | suspended | archived
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenants         Tenant[]
  stateHierarchy  StateHierarchy[]
  institutions    Institution[]
}

model Tenant {
  id          String   @id @default(cuid())
  code        String   @unique          // "SY-MIN-PLAN"
  displayName String
  countryId   String
  status      String   @default("active")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  country     Country  @relation(fields: [countryId], references: [id])
  auditLogs   AuditLog[]
}

model StateHierarchy {
  id          String   @id @default(cuid())
  countryId   String
  parentId    String?                     // self-reference for nesting
  code        String                       // "SY-DAM" for Damascus
  displayName String
  level       String                       // "nation" | "province" | "district" | "municipality"
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  country     Country  @relation(fields: [countryId], references: [id])
  parent      StateHierarchy? @relation("StateHierarchyTree", fields: [parentId], references: [id])
  children    StateHierarchy[] @relation("StateHierarchyTree")

  @@unique([countryId, code])
  @@index([countryId, level])
}

model Institution {
  id          String   @id @default(cuid())
  countryId   String
  parentId    String?
  code        String
  displayName String
  type        String                       // "ministry" | "agency" | "authority" | "directorate"
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  country     Country  @relation(fields: [countryId], references: [id])
  parent      Institution? @relation("InstitutionTree", fields: [parentId], references: [id])
  children    Institution[] @relation("InstitutionTree")

  @@unique([countryId, code])
}

model RoleReference {
  id          String   @id @default(cuid())
  code        String   @unique           // "admin", "analyst", "reviewer", "observer"
  displayName String
  description String
  permissions Json                          // catalog of permissions for this role
  createdAt   DateTime @default(now())
}

model SourceRegistry {
  id          String   @id @default(cuid())
  code        String   @unique
  displayName String
  type        String                       // "international_org" | "academic" | "government" | "media"
  license     String?
  url         String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model PublicKnowledge {
  id          String   @id @default(cuid())
  sourceId    String?                      // FK to SourceRegistry (optional — some public knowledge is curated)
  title       String
  content     String
  metadata    Json
  publishedAt DateTime?
  createdAt   DateTime @default(now())

  source      SourceRegistry? @relation(fields: [sourceId], references: [id])

  @@index([title])
  @@index([publishedAt])
}
```

## Alternatives considered

### Country = Tenant (single entity)
- **Rejected:** violates founder directive. Multiple tenants may operate in the same country.

### PUBLIC knowledge per-tenant (denormalized)
- **Rejected:** wastes storage; creates update anomalies; violates the "shared knowledge" intent.

### Column-level scope flag on every table
- **Considered:** add `scope: "public" | "private"` to every table.
- **Rejected:** conflates two different concerns. PUBLIC knowledge has no tenant; PRIVATE data always has a tenant. A scope flag implies a row could be either, which is confusing. Better to have separate tables: `PublicKnowledge` (no tenant) vs tenant-scoped tables (always tenant).

### Separate database per country
- **Rejected:** would prevent PUBLIC knowledge sharing. Single database with RLS is the right model.

## Consequences

- **Positive:** Clean separation of public vs private. RLS policies are simple: PRIVATE rows filter by `tenant_id`; PUBLIC rows have no filter. Country ≠ Tenant enables multi-tenant-per-country scenarios.
- **Negative:** Two access patterns (PUBLIC vs PRIVATE) — application code must know which table it's querying. Mitigated by clear table naming (`PublicKnowledge` vs tenant-scoped tables).
- **Future impact:** When `Evidence` is added in 00-04, it will be PRIVATE (tenant-scoped) but reference PUBLIC `SourceRegistry` entries. When `Indicator` is added, it may be PUBLIC (international indicators) or PRIVATE (tenant-specific measurements). The schema supports both.

## Verification (planned for 00-02)

1. Two tenants in the same country — each sees only its own private data.
2. A tenant in country A cannot see tenant B's private data (even if same country).
3. Any tenant can read `PublicKnowledge` rows.
4. No tenant can INSERT/UPDATE/DELETE `PublicKnowledge` (only admin).
5. `Country`, `StateHierarchy`, `Institution`, `RoleReference`, `SourceRegistry` are all PUBLIC-read.
6. Fail-closed: with no `app.tenant_id` set, PRIVATE tables return empty; PUBLIC tables still readable.
