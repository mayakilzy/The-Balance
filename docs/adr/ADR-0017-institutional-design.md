# ADR-0017 — Institutional Design & Program Contracts

**Date:** 2026-10-17
**Status:** Accepted
**Mission:** 01-04 (Institutional Design & Program Contracts)
**Builds on:** ADR-0013 (G01 Domain Model), ADR-0016 (Strategy Composer)

## Context

Mission 01-04 expands strategy alternative programs into full institutional contracts: each program gets an owning institution, legal mandate reference, required capabilities, and KPIs with measurement source. The expansion must be deterministic (no LLM), institutionally sound (no fabricated institutions or mandates), and preserve evidence provenance.

## Decision

### 1. Deterministic Institution Assignment

Institutions are matched to programs by sector using a static `SECTOR_INSTITUTION_MAP`. If no institution matches, `owningInstitutionId = null` and `mandateGap = true`. No fabrication.

### 2. Legal Mandate Honesty

Demolandia does not have explicit legal mandates documented. We do NOT fabricate legal references. `mandateGap = true` always (unless a legal reference is explicitly documented in the future). `legalMandateRef = null`.

### 3. KPI Source Kind

Each KPI has a `sourceKind` from: `official_statistics`, `administrative_data`, `survey`, `international_indicator`, `unspecified`. If the metric is not in the known map → `unspecified` with a note that the KPI cannot be verified.

### 4. Capabilities

Required capabilities are derived from the sector. Each capability has `status: "unknown"` (not assessed) — we don't fabricate availability claims.

### 5. Idempotent Storage

Before creating a Program, check if one exists with the same `(tenantId, strategyVersionId, title)`. If found, update its metadata. This prevents duplicates on re-expansion.

### 6. Permissions

- `expandPrograms()` → `strategy:write` (analyst + admin)
- `getPrograms()` → `program:read` (admin, analyst, reviewer — NOT observer)
