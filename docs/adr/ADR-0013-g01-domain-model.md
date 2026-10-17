# ADR-0013 — G01 Domain Model: State Builder Foundation

**Date:** 2026-10-17
**Status:** Accepted
**Mission:** 01-00 (G01 Bootstrap + Country Pack Extension)
**Supersedes:** None
**Builds on:** ADR-0004 (Country/Tenant Separation), ADR-0005 (RLS Roles), ADR-0009 (Evidence Fabric), ADR-0010 (Strategy Contracts)

## Context

GROUP 01 (State Builder) needs a domain model to represent a tenant's planning view of a country: objectives, programs, projects, budgets, dependencies, risks, assumptions, and per-tenant country pack configuration. The founder directive (correction A in the approved G01 Mission Pack §13) requires a strict separation between:

- **PUBLIC reference data** — country geography, institutions, legal mandates catalog (already in G00 tables: `countries`, `state_hierarchy`, `institutions`, `role_references`, `source_registry`, `public_knowledge`).
- **PRIVATE tenant planning data** — a tenant's goals, planning assumptions, observability assessments, programs, projects, budgets, dependencies, risks, assumptions (NEW G01 tables, all tenant-scoped).

The original draft of the mission pack described `CountryPackConfig` as a PUBLIC extension of the `countries` table. The founder corrected this: `CountryPackConfig` is PRIVATE (tenant-scoped). Two tenants operating on the same country share the country's geography and institutions, but NOT their planning assumptions, sector priorities, or observability assessments.

Additionally, corrections 2 and 3 from the approved mission pack require two additive schema extensions to existing G00 tables:

- `strategies.compositionBatchId String?` — groups strategy alternatives from the same composer run (mission 01-03).
- `strategy_versions.metadata Json @default("{}")` — stores provenance (`simulated`, `provider`, `composedAt`, `compositionBatchId`, `modelVersion`) for strategy versions, while preserving the immutability of approved versions (correction 3 + B).

## Decision

### 1. Eight new PRIVATE tables (all tenant-scoped, RLS ENABLE + FORCE)

| Table | Purpose | Key columns | Owned by |
|-------|---------|-------------|----------|
| `objectives` | Human-defined goals (e.g., "reduce unemployment to 10% in 5 years") | `tenantId, countryId, title, description, targetMetric, targetValue, horizon, status, createdBy` | Tenant |
| `country_pack_configs` | Per-tenant planning overlay on a country (sectors tracked, observability mode per dimension) | `tenantId, countryId, sectors Json, observability Json, planningAssumptions Json` | Tenant |
| `programs` | Reform programs within a strategy version | `tenantId, strategyVersionId, title, sector, owningInstitutionId, legalMandateRef, rationale, status` | Tenant |
| `projects` | Specific projects within a program | `tenantId, programId, title, description, status, startYear, endYear` | Tenant |
| `budget_lines` | Cost estimate line items (conditional ranges) | `tenantId, programId, currency, minAmount, maxAmount, horizonYears, assumptions Json, financingSources Json, modelVersion` | Tenant |
| `dependencies` | Directed edges between programs (A depends on B) | `tenantId, fromProgramId, toProgramId, type, rationale` | Tenant |
| `risk_registers` | Risks associated with a strategy version | `tenantId, strategyVersionId, title, description, severity, likelihood, mitigation` | Tenant |
| `assumptions` | Assumptions underpinning a strategy version | `tenantId, strategyVersionId, title, description, validationMethod, status` | Tenant |

All eight tables:
- Are PRIVATE (tenant-scoped) with ENABLE + FORCE ROW LEVEL SECURITY.
- Use the same RLS policy pattern as G00's 14 PRIVATE tables: `USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (...)` for `balance_app`, and `USING (true) WITH CHECK (true)` for `balance_admin`.
- Are owned by `balance_admin` (for migrations/seed); `balance_app` gets `SELECT, INSERT, UPDATE, DELETE` (DML) for tenant-scoped access.
- Have foreign keys to `tenants(id)` with `ON DELETE CASCADE` (consistent with G00 pattern).
- Have indexes on `(tenantId, ...)` for tenant-scoped queries.

### 2. Additive extensions to existing G00 tables (no breaking changes)

- `strategies` — add `compositionBatchId TEXT NULL` + index `(tenantId, compositionBatchId)`. Nullable, so existing G00 rows are unaffected. Groups alternatives from the same composer run (mission 01-03). RLS: the existing `strategies` policy applies (no weakening); cross-tenant access to the same `compositionBatchId` is blocked by RLS (the value is meaningless across tenants because RLS blocks the rows).
- `strategy_versions` — add `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`. Stores provenance: `{ simulated, provider, composedAt, compositionBatchId, modelVersion }`. **Immutability**: the existing G00 trigger `enforce_approved_version_immutability()` (migration 0013) blocks UPDATE on `content, createdBy, createdAt, approvedBy, approvedAt, approvalNotes, versionNumber, strategyId, tenantId` for approved versions. We extend this trigger to ALSO block UPDATE on `metadata` for approved versions — so the provenance record is frozen at approval time, exactly like the content. This is a clean extension of the existing trigger, not a replacement.

### 3. Country Pack Data Boundaries (correction A)

The `getCountryPack(session, { countryId })` service returns:
- **PUBLIC reference** (from existing G00 tables, readable by all tenants): `country`, `institutions[]`, `adminUnits[]` (state_hierarchy), `legalMandates[]` (role_references catalog).
- **PRIVATE planning** (from new G01 tables, tenant-scoped): `countryPackConfig` (this tenant's config for this country), `objectives[]` (this tenant's goals for this country).

Two tenants operating on the same country see the same PUBLIC reference data but different PRIVATE planning data. RLS enforces this at the DB level; the service layer composes the two scopes into a single response.

### 4. Reuse of G00 contracts

- `withAuthenticatedTenant(session, fn)` — sets `app.user_id` + `app.tenant_id`, verifies CURRENT membership, returns `{ tx, userId, tenantId, roleCode }`. Used by all new services.
- `requirePermissionWithCurrentRole(session, permission)` — checks the CURRENT DB role (not stale JWT). Used for permission-gated operations.
- `writeAudit(entry)` — append-only audit log writer. Will be used in mission 01-10 for approval audit; not needed in 01-00 (no privileged actions yet beyond objective CRUD).
- G00's `approveStrategyVersion()` + `createStrategyVersion()` — reused as-is in mission 01-10 (correction 6). No parallel approval system.
- G00's Strategy immutability trigger — extended (not replaced) to cover `metadata`.

### 5. Permissions (per correction 4 + 5)

No new permissions are introduced in mission 01-00. Objective CRUD uses the existing `strategy:write` (for create) and `strategy:read` (for list) — these are the permissions the composer (01-03) and advisor (01-09) will reuse. The `baseline:read`, `baseline:compute`, `gap:read`, `program:read`, `portfolio:read`, `budget:read` permissions listed in the mission pack §6 are for LATER missions (01-01 through 01-08), not 01-00.

For 01-00, the only permission checks are:
- `createObjective()` → `strategy:write` (analyst + admin)
- `listObjectives()` → `strategy:read` (all roles)
- `getCountryPack()` → `tenant:read` (all roles) — reading PUBLIC reference + own tenant's PRIVATE planning

## Alternatives considered

### Separate `strategy_composition_batches` table (rejected)
- **Considered**: A dedicated table to group strategy alternatives, with `id, tenantId, composedAt, provider, simulated`.
- **Rejected**: Overkill for G01. A nullable `compositionBatchId` column on `strategies` is simpler and sufficient. The batch metadata (provider, simulated, composedAt) is stored on each `strategy_versions.metadata` instead, so it travels with the version. If we later need batch-level metadata that differs across versions in the same batch, we can add the table then — but YAGNI for now.

### Storing `simulated` flag as a column on `strategy_versions` (rejected)
- **Considered**: `strategy_versions.simulated Boolean NOT NULL DEFAULT false`.
- **Rejected**: A single boolean is too rigid. The `metadata Json` column is more flexible — it stores `simulated`, `provider`, `composedAt`, `compositionBatchId`, `modelVersion`, and any future provenance fields. The immutability trigger extension protects it post-approval.

### Making `CountryPackConfig` PUBLIC (rejected — founder correction A)
- **Considered** (original draft): `CountryPackConfig` extends the PUBLIC `countries` table, readable by all tenants.
- **Rejected** (founder directive): A tenant's planning assumptions, sector priorities, and observability assessments are PRIVATE. Two tenants in the same country must NOT see each other's planning data. `CountryPackConfig` is PRIVATE (tenant-scoped).

### Adding a `strategy:compose` permission (rejected — correction 4)
- **Considered** (original draft): A new `strategy:compose` permission for the composer.
- **Rejected**: Redundant with the existing `strategy:write` (held by analyst + admin). Reusing `strategy:write` keeps the permission catalog small (ADR-0008 principle) and achieves the same separation of duties (`strategy:write` for compose vs `strategy:approve` for approve).

## Consequences

### Positive
- Clean additive migration (0017) — no G00 table's existing columns or RLS policies are modified.
- The 237 G00 tests remain valid and unchanged.
- The 8 new tables follow the exact RLS pattern of G00's 14 PRIVATE tables — consistent, auditable, and well-understood.
- `compositionBatchId` + `metadata` are nullable/defaulted, so existing G00 rows are unaffected.
- The immutability trigger extension is a 1-line addition to an existing function — low risk.

### Negative
- 8 new tables + 2 column additions = larger schema. Acceptable: this is the core domain model for State Builder.
- The `metadata Json` column is somewhat opaque (no DB-level schema enforcement). Mitigated by Zod validation in the service layer (mission 01-03 will define the `StrategyVersionMetadata` schema).

### Future impact
- Missions 01-01 through 01-10 will populate these tables and add services on top.
- If a real LLM provider is integrated (post-G01), the `metadata.provider` field will reflect it — no schema change needed.
- If batch-level metadata becomes necessary (e.g., a batch-level `simulated` flag distinct from per-version), a `strategy_composition_batches` table can be added in a later migration without breaking 0017.

## Verification (planned for 01-00)

1. Migration 0017 applies cleanly on a fresh DB (no modification to migrations 0001–0016).
2. RLS ENABLE + FORCE on all 8 new PRIVATE tables.
3. The 14 G00 PRIVATE tables remain RLS-enforced (no regression).
4. `strategies.compositionBatchId` + `strategy_versions.metadata` columns added; G00 tests still pass.
5. The extended immutability trigger blocks UPDATE on `metadata` for approved versions.
6. Cross-tenant `CountryPackConfig` isolation: Tenant B cannot read Tenant A's config for the same country.
7. Cross-tenant `Objectives` isolation: Tenant B cannot read Tenant A's objectives.
8. `compositionBatchId` grouping: querying by batch ID returns only this tenant's alternatives.
9. Seed (Demolandia v2) creates 5+ objectives + 1 CountryPackConfig per tenant; idempotent re-run.
10. `fresh-install-verify.sh` + `verify-restored-db.sh` pass with 22 private tables (14 G00 + 8 G01).
