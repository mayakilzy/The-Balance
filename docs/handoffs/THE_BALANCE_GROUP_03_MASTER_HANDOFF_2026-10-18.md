# THE BALANCE — GROUP 03 MASTER HANDOFF

> **Document type:** Project-specific chat handoff (per `PROJECT_CHAT_HANDOFF_PROTOCOL.md` v1.0, MODE A — PREPARE_HANDOFF)
> **Date:** 2026-10-18
> **Prepared by:** GLM (outgoing implementation agent)
> **Prepared for:** GLM (incoming implementation agent in a new chat)
> **Authorization scope:** Documentation only. **GROUP 03 implementation is NOT AUTHORIZED.**

---

## 1. Executive Project Overview

### Project Identity

- **Name:** THE BALANCE (الميزان)
- **Tagline:** Global State Intelligence & State-Building Platform
- **Repository:** https://github.com/mayakilzy/The-Balance
- **Planning documents:** https://github.com/mayakilzy/repo-info/tree/main/The-Balance-Doc
- **Default branch:** `main`
- **Working branch:** `main` (direct push authorized by owner; feature branches used when appropriate)
- **Final verified commit SHA:** `0c04d535b0ed01aca4c1264729bb46e8a4be61b8`

### Mission

THE BALANCE is an evidence-based state intelligence platform intended for legitimate governments. It helps governments:

1. Understand the actual state of the country (observatory)
2. Design interconnected reform strategies (state builder)
3. Accompany implementation (targeted reform — GROUP 03, not yet built)
4. Measure results (observatory)
5. Protect the state's strategic memory across changes of government (audit + append-only records)

### Intended Users

- **Government planners** (analyst role) — design strategies, ingest observations, review alerts
- **Senior reviewers** (reviewer role) — approve strategies, document alert decisions, verify execution
- **Ministry/institutional staff** (analyst role, scoped to their institution) — view their institution's observatory data
- **Government leadership** (admin role) — see permissioned government projection (public evidence only)
- **Researchers / public** (observer role / anonymous) — currently fail-closed (G02-L25); no publication workflow exists yet

### Long-Term Vision

A six-group roadmap:

| Group | Name | Status |
|-------|------|--------|
| GROUP 00 | Foundation | APPROVED |
| GROUP 01 | State Builder | APPROVED — FINAL PASS |
| GROUP 02 | State Observatory | APPROVED — FINAL PASS — CLOSED |
| GROUP 03 | Targeted Reform | **READY FOR SCOPE REVIEW — IMPLEMENTATION NOT AUTHORIZED** |
| GROUP 04 | (TBD by roadmap) | NOT STARTED |
| GROUP 05 | (TBD by roadmap) | NOT STARTED |
| GROUP 06 | (TBD by roadmap) | NOT STARTED |

### Main Problems Solved

- **Strategic amnesia across governments**: append-only observations + atomic audit log preserve institutional memory
- **Opaque planning vs. execution gap**: VarianceRecord surfaces planned-vs-actual deviations descriptively (no causal claims)
- **Unaccountable alert pipelines**: Alert lifecycle (detected → notified → reviewed → decision_documented → closed) is separated from execution verification (not_applicable → pending → verified → disputed), with `verifyExecution` requiring both `verifiedAction` and `evidenceSource`
- **Sovereignty erosion by AI**: all intelligence is structural (deterministic algorithms); LLM is advisory only, never replaces human review; no automatic reform creation, no automatic approval, no automatic execution

---

## 2. Repositories and Authoritative Resources

### Primary Repository

| Field | Value |
|-------|-------|
| Name | `mayakilzy/The-Balance` |
| URL | https://github.com/mayakilzy/The-Balance |
| Visibility | Public |
| Default branch | `main` |
| Final verified SHA | `0c04d535b0ed01aca4c1264729bb46e8a4be61b8` |
| Stable tag/release | None (development mainline) |
| CI workflow | `.github/workflows/ci.yml` — Lint + Typecheck + Test + Integration |
| Recovery workflow | `.github/workflows/fresh-install-recovery.yml` — Fresh Install + Recovery (00-10) |

### Related Repositories

| Repository | Purpose |
|------------|---------|
| `mayakilzy/repo-info` | Project planning documents, ADR source, the chat handoff protocol, GitHub access continuity doc |
| `mayakilzy/repo-info/The-Balance-Doc` | Blueprint, roadmap, mission specifications |
| `mayakilzy/repo-info/GeneralGH` | GitHub token source (for the development agent's push access) — see Section 10 |

### Documentation Folders (in the primary repo)

| Path | Content |
|------|---------|
| `docs/adr/` | 17 ADRs (ADR-0001 through ADR-0017) — every architectural decision |
| `docs/mission-reports/G00/` | GROUP 00 final review, acceptance matrix, known limitations, 00-01 report, G01 readiness handoff |
| `docs/mission-reports/G01/` | GROUP 01 final review, acceptance matrix, known limitations, mission pack, G02 readiness handoff, per-mission reports |
| `docs/mission-reports/G02/` | GROUP 02 final review, acceptance matrix, known limitations, G03 readiness handoff, per-mission reports (02-00 through 02-05) |
| `docs/handoffs/` | Cross-session handoff documents (this file lives here), GitHub access continuity doc, prior GROUP 01 handoffs |
| `docs/RUNBOOK.md` | Operational runbook |

### Authoritative GROUP 02 Closure Documents (read these in full before any GROUP 03 work)

1. `docs/mission-reports/G02/GROUP_02_FINAL_REVIEW.md` — comprehensive completion summary
2. `docs/mission-reports/G02/GROUP_02_ACCEPTANCE_MATRIX.md` — per-mission acceptance grid with evidence
3. `docs/mission-reports/G02/GROUP_02_KNOWN_LIMITATIONS.md` — closed, documented, and deferred limitations register
4. `docs/mission-reports/G02/GROUP_03_READINESS_HANDOFF.md` — what GROUP 03 will pick up (documentation only)

### Issue Tracker

GitHub Issues (not actively used during GROUP 02 — work was tracked via mission reports and the worklog file).

### Design References

- **Blueprint:** lives in `mayakilzy/repo-info/The-Balance-Doc` (the planning repository)
- **Six-Group Roadmap:** referenced in GROUP_03_READINESS_HANDOFF.md Section "GROUP 03 Scope (Expected — Not Frozen)"
- **Arabic UI:** the platform UI is Arabic-first, RTL, responsive — see `src/app/` and `src/app/globals.css`

---

## 3. Architecture and Technology

### Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| Framework | Next.js 16 (App Router) | TypeScript 5 end-to-end |
| Runtime | Bun 1.3+ (or Node.js 22+) | Bun is the primary dev runtime |
| Database | PostgreSQL 16 + pgvector | See `docker-compose.yml` |
| ORM | Prisma 6 | Schema in `prisma/schema.prisma` |
| Auth | Auth.js v5 (NextAuth) | Three DB roles (see below) |
| Validation | Zod 4 | Env validation in `src/lib/env.ts`, all service inputs in `src/lib/state-observatory/contracts.ts` |
| Logging | pino | Structured NDJSON in production |
| Testing | Vitest | Unit + integration; Playwright for browser E2E |
| LLM | Provider Abstraction | Stub by default; swap via `LLM_PROVIDER` env var. **No LLM is used in GROUP 02 services.** |

### Database Roles (three-role design — see ADR-0005)

| Role | Purpose | RLS Behavior |
|------|---------|--------------|
| `balance_app` | Application runtime | RLS-enforced (tenant-scoped) |
| `balance_admin` | Migrations + seed only | BYPASSRLS |
| `balance_auth` | Auth bootstrap (read-only, column-level grants) | Read-only on auth tables |

### Components

```
src/
├── app/                         # Next.js App Router (UI + API routes)
│   ├── api/v1/                  # REST API (auth, evidence, tasks, capabilities, meta, metrics, health, countries)
│   ├── capabilities/            # UI page
│   ├── evidence/                # UI page
│   ├── strategies/              # UI page
│   ├── tasks/                   # UI page
│   ├── login/                   # UI page
│   ├── layout.tsx               # Root layout (Arabic RTL)
│   └── globals.css              # Tailwind + RTL
├── components/                  # React components
├── lib/
│   ├── state-builder/           # GROUP 01 services (READ-ONLY — diff must stay 0)
│   ├── state-observatory/       # GROUP 02 services (17 modules, 5,334 lines)
│   ├── llm/                     # LLM provider abstraction (stub by default)
│   ├── security/                # tenant-context (RLS wrapper)
│   ├── audit.ts                 # writeAudit + writeAuditTx (atomic)
│   ├── auth.ts                  # Auth.js v5
│   ├── db.ts                    # Prisma client
│   ├── permissions.ts           # RBAC permission catalog
│   ├── strategy-service.ts      # G00 + 01-10 atomic approval
│   ├── task-service.ts          # Durable task runtime
│   ├── evidence-service.ts      # Evidence fabric
│   ├── capability-service.ts    # Capability registry
│   ├── password.ts              # Password hashing
│   ├── env.ts                   # Zod env validation
│   ├── error-sanitizer.ts       # Error scrubbing
│   ├── metrics.ts               # Prometheus metrics
│   ├── observability.ts         # Structured logging
│   └── audit-observability.ts   # Audit observability hooks
└── middleware.ts                # Auth middleware
```

### Critical API Contracts (read-only consumption for GROUP 03)

#### GROUP 01 Services (`src/lib/state-builder/`)

| Service | Contract |
|---------|----------|
| Baseline | `computeBaseline(session, { countryId }) → { taskId, report }` |
| Gap Analysis | `computeGaps(session, { countryId, objectiveIds }) → { taskId, report }` |
| Strategy Composer | `composeStrategies(session, { countryId, objectiveIds }) → ComposeResult` |
| Program | `expandPrograms(session, { strategyAlternativeId }) → ExpandProgramsResult` |
| Portfolio | `buildPortfolio(session, { strategyAlternativeId }) → Portfolio` |
| Budget | `estimateBudgets(session, { strategyAlternativeId }) → BudgetResult` |
| Roadmap | `buildRoadmap(session, { strategyAlternativeId }) → ImplementationRoadmap` |
| Comparison | `compareScenarios(session, { alternativeIds }) → ScenarioComparison` |
| Advisor | `advise(session, { countryId, objectiveIds, alternativeIds }) → AdvisoryReport` |
| Approval | `approveStrategyVersionWithAuditSafe(session, versionId, notes?) → { versionId, status, approvedBy }` |

#### GROUP 02 Services (`src/lib/state-observatory/`)

| Service | Contract |
|---------|----------|
| Indicator Registry | `defineIndicator`, `listIndicators`, `retireIndicator` |
| Observation | `ingestObservation`, `correctObservation` (F2 atomic), `listObservations`, `getCurrentObservation` |
| Variance | `computeVariance` (R2 + F4), `listVariance` |
| Alert | `evaluateAndRaise`, `markReviewed`, `documentDecision`, `verifyExecution` (F6), `closeAlert` |
| Provenance Validator | `validateObservationProvenance` (pure function, 11 rules) |
| Evidence Country Validator | `verifyEvidenceCountryScope` |
| Evidence Independence | `analyzeIndependence` (per-observation) |
| Aggregate Independence | `analyzeAggregateIndependence` (national claim support) |
| Observatory Query | 4-layer snapshot (indicator → observation → variance → alert) |
| Temporal Trend | `analyzeTemporalTrend` (lookback, ≥2 data points) |
| Early Warning | `assessEarlyWarning` (uncalibrated, descriptive) |
| Institutional View | `getInstitutionalView` (per-institution, cross-tenant isolated) |
| Sector View | `getSectorView` (counts only; observability not computed) |
| Permissioned View | `getPermissionedView` (3 tiers: public/research/government) |
| Threshold Evaluator | `evaluateThresholds` (pure function, no eval/Function/vm) |

### Audit Infrastructure

- `writeAudit(entry)` — best-effort, global db client, swallows errors
- `writeAuditTx(tx, entry)` — ATOMIC, transaction-scoped, throws on failure
- Both available for GROUP 03 to use for sovereign audit trails

### Environments

| Environment | Status |
|-------------|--------|
| Local dev | Docker Compose (`docker-compose.yml`) — PostgreSQL 16 + pgvector |
| CI | GitHub Actions: PostgreSQL 16 service container, real RLS testing |
| Recovery | GitHub Actions: fresh install + backup/restore drill |
| Staging | NOT DEPLOYED |
| Production | NOT DEPLOYED — platform is foundation-validated, not production-hardened |

---

## 4. Product and UX Requirements

### Approved Experiences

- **Arabic-first, RTL, responsive UI** — see `src/app/layout.tsx` and `src/app/globals.css`
- **Six UI pages**: home (`/`), login (`/login`), strategies (`/strategies`), evidence (`/evidence`), tasks (`/tasks`), capabilities (`/capabilities`)
- **REST API v1** under `/api/v1/` — auth, evidence, tasks, capabilities, meta, metrics, health, countries
- **Demo credentials** are gated behind `SHOW_DEMO_CREDENTIALS="true"` env var (off by default)

### Design System

- Tailwind CSS for styling
- RTL-aware layout (`dir="rtl"` on `<html>`)
- No external design system (custom components)

### Languages

- **UI:** Arabic (primary), English (fallback for technical terms)
- **Code identifiers:** English
- **Documentation:** English (technical) + Arabic (owner's review language)
- **Tests:** English

### Accessibility

- Semantic HTML, ARIA where needed
- Keyboard-navigable forms
- Color contrast per WCAG AA where feasible

### Essential Asset References

- Country seed: `prisma/seed-ontology.ts` — "Demolandia" (DML) fictional country with seeded tenants, users, evidence, objectives
- Two tenants: `DML-MOP-TENANT` (Ministry of Planning) and `DML-CB-TENANT` (Central Bank)
- Seeded users: `admin@demolandia.test`, `analyst@demolandia.test` (passwords gated behind demo flag)

### Browser E2E

- Playwright config in `playwright.config.ts`
- Browser tests in `tests/browser/`: `browser-journey.spec.ts`, `t1-state-builder.spec.ts`
- HTTP E2E in `tests/e2e/http-auth.e2e.test.ts` (10 tests, all skipped in non-browser contexts)
- GROUP 02 added no browser UI for observatory — this is a known limitation (G02-L03)

---

## 5. Engineering Principles and Constraints

### Reuse Policies

- **GROUP 01 code (`src/lib/state-builder/`) is READ-ONLY** — diff must stay 0
- **GROUP 02 code (`src/lib/state-observatory/`) should be EXTENDED, not modified** — new services live in a new directory (e.g., `src/lib/reform/` for GROUP 03)
- **No new tables/migrations/permissions without explicit owner approval** — GROUP 02 followed the pattern of one bootstrap mission for schema, subsequent missions for services
- **StrategyVersion referenced as READ-ONLY FK** — never modified by observatory or reform services
- **Observations are append-only** — correction chains (R4) only; no in-place mutation

### Preferred Implementation Agents

- **Owner** (project owner): designs, reviews, approves. The owner is the gate.
- **GLM (ChatGPT technical reviewer)**: conducts independent code review, verifies CI/Recovery, issues acceptance decisions (FINAL PASS / PENDING / FAIL). Reviews in Arabic.
- **GLM (implementation agent)**: writes code, writes tests, runs CI, pushes to main. The current model is GLM (this outgoing session was GLM).

### Forbidden Shortcuts

- **No self-approval** — GLM (implementation) never marks its own work as FINAL PASS. Only the owner or GLM (reviewer) can.
- **No `eval` / `Function` / `vm` in threshold evaluation** — pure deterministic functions only (see `threshold-evaluator.ts`)
- **No text-based exception suppression** — `FixtureTracker.cleanup()` surfaces all real DB errors (G02-L21 closure)
- **No silent policy mutation** — RLS policies are explicit, version-controlled, and tested
- **No secrets in Git** — `.env` is gitignored; `.env.example` contains placeholders only
- **No automatic reform creation** (when GROUP 03 starts) — the human remains sovereign
- **No causal attribution claims** — `attributionLevel = "descriptive"` is platform-wide invariant

### Licensing/Security Rules

- Repository is public; license is NOT declared (verify with owner before any external contribution)
- Security hardening per ADR-0012: rate limiting, error sanitization, IP hashing, audit logging
- RLS ENABLE + FORCE on all PRIVATE tables (no BYPASSRLS leaks except `balance_admin` for migrations)

### Test Methodology

- **Unit tests** (`tests/unit/`): pure function tests, mocked Prisma where needed
- **Integration tests** (`tests/integration/`): real PostgreSQL 16, real RLS, real audit; gated by `RUN_INTEGRATION_TESTS=1`
- **Sentinel regression tests** (`tests/integration/g02-l21-sentinel.integration.test.ts`): 7 tests exercising the FixtureTracker cleanup path on real PostgreSQL
- **Browser E2E** (`tests/browser/`): Playwright, gated by separate config
- **HTTP E2E** (`tests/e2e/`): Vitest with HTTP layer, gated by `RUN_E2E_TESTS=1`
- **FixtureTracker** (`tests/integration/helpers/fixture-tracker.ts`): ownership-aware test cleanup — REUSE for GROUP 03 integration tests

### Definition of Done (per mission)

1. Code written and committed
2. Unit tests pass locally (`AUTH_SECRET=... bun run test`)
3. Typecheck passes (`bunx tsc --noEmit`)
4. Lint passes (`bun run lint`)
5. Pushed to `main`
6. CI workflow passes (Lint + Typecheck + Test + Integration on real PostgreSQL 16)
7. Recovery workflow passes (Fresh Install + Backup/Restore drill)
8. Owner reviews and issues FINAL PASS / PENDING / FAIL
9. Mission report published in `docs/mission-reports/G0X/`

---

## 6. Decisions Already Frozen (DO NOT REOPEN Without Owner Consent)

### GROUP 00 (Foundation) — 12 ADRs

- ADR-0001: Stack Selection (Next.js + TypeScript + Prisma + PostgreSQL 16 + pgvector)
- ADR-0002: LLM Provider Abstraction (Stub default; ZAI/OpenAI/Anthropic swappable)
- ADR-0003: Tenant Isolation (RLS-based)
- ADR-0004: Country/Tenant Separation
- ADR-0005: RLS Roles and Policies (three-role design)
- ADR-0006: Hierarchy Integrity
- ADR-0007: Authentication Design (Auth.js v5)
- ADR-0008: RBAC/ABAC Design
- ADR-0009: Evidence Fabric Design
- ADR-0010: Strategy Contracts Design
- ADR-0011: Capability Registry Design
- ADR-0012: Security Hardening Design

### GROUP 01 (State Builder) — 5 ADRs

- ADR-0013: G01 Domain Model
- ADR-0014: State Baseline Observability Modes (FULL/PARTIAL/LOW)
- ADR-0015: Gap Analysis Engine
- ADR-0016: Strategy Composer
- ADR-0017: Institutional Design

### GROUP 02 (State Observatory) — 100+ Frozen Decisions

- **Q1-Q15** (02-00 architecture): 5 tables, 4 services, R1 originType/verification split, R2 periodMilestone-first, R3 per-indicator thresholds, R4 append-only corrections, R5 lifecycle/execution separation
- **R1-R5** (02-00 refinements)
- **E1-E8** (02-00 execution)
- **F1-F6** (02-00 final fixes)
- **A1-A18** (02-01 provenance validation)
- **B1-B16** (02-02 evidence independence + observability snapshot)
- **C1-C18** (02-03 temporal integrity + early warnings; C18 = G02-L21, now CLOSED)
- **D1-D14** (02-04 institutional + sector views)
- **E1-E16** (02-05 permissioned views)

### Architectural Invariants (NOT Limitations — Must Not Change)

1. `attributionLevel = "descriptive"` always — no causal claims without evidence
2. StrategyVersion referenced as READ-ONLY FK — never modified by observatory or reform services
3. Observations are append-only with correction chains (R4) — no in-place mutation
4. isCurrent uniqueness via partial unique index with `COALESCE(geo_ref_id, '')` (F1)
5. Chain integrity via DB trigger — no branching, no cycles, no self-reference (F3)
6. VarianceRecord.observationId is NULLABLE — null when unknown (F4)
7. Alert separates `lifecycleStage` from `executionStatus` (R5/F6)
8. `verifyExecution` requires `verifiedAction` + `evidenceSource` (F6)
9. No new tables/migrations/permissions in 02-01 through 02-05 (GROUP 02 pattern — GROUP 03 should follow the same incremental approach)
10. `src/lib/state-builder/` diff = 0 — GROUP 01 code untouched
11. `src/lib/state-observatory/` diff = 0 unless explicitly approved — GROUP 02 code should be extended, not modified
12. Fail-closed for public/research publication (G02-L25) — no automatic publication
13. Government projection limited to `classification="public"` evidence (G02-L26) — conservative clearance
14. The human remains sovereign — no automatic reform creation, approval, or execution (when GROUP 03 starts)

---

## 7. Work Accomplished

### GROUP 00 — Foundation (APPROVED)

- **Missions:** 00-00 through 00-10 (11 missions)
- **Final SHA:** `dcbb8961dd588bb9e66a9076bc4e62625482a56f`
- **CI:** PASS
- **Recovery:** PASS
- **Total Tests:** 237 (at end of G00)
- **Key deliverables:**
  - 16 migrations applied cleanly to fresh PostgreSQL 16 + pgvector
  - 22 Prisma models (8 PUBLIC + 14 PRIVATE tables)
  - 12 ADRs
  - 16 API routes with auth + RBAC
  - 6 UI pages (Arabic RTL, responsive)
  - 2 CI workflows (primary + fresh-install-recovery), both green
  - RLS enabled + forced on all 14 PRIVATE tables
  - Three-role DB design (`balance_app`, `balance_admin`, `balance_auth`)
  - Auth.js v5 authentication
  - Evidence fabric with pgvector
  - Strategy contracts
  - Durable task runtime
  - Capability registry
  - Security hardening (rate limiting, error sanitization, IP hashing)
- **Authoritative docs:** `docs/mission-reports/G00/GROUP_00_FINAL_REVIEW.md`, `GROUP_00_ACCEPTANCE_MATRIX.md`, `GROUP_00_KNOWN_LIMITATIONS.md`

### GROUP 01 — State Builder (APPROVED — FINAL PASS)

- **Missions:** 01-00 through 01-10 (11 missions)
- **Final SHA:** `9dc88d7349b04fc3e2515a634ed9262a76d12e86`
- **CI:** PASS — https://github.com/mayakilzy/The-Balance/actions/runs/39053937234
- **Recovery:** PASS — https://github.com/mayakilzy/The-Balance/actions/runs/39053937226
- **Total Tests:** 536 passed | 10 skipped | 0 failed (at end of G01)
- **Key deliverables:**
  - 8 G01 models (Objective, CountryPackConfig, Program, Project, BudgetLine, Dependency, RiskRegister, Assumption)
  - 4 G01 migrations (total: 20 migrations = 16 G00 + 4 G01)
  - 10 state-builder services (baseline, gap-analysis, strategy-composer, program, portfolio, budget, roadmap, comparison, advisor, approval)
  - T1 integration test (full chain: baseline → advisory → human approval)
  - Atomic approval workflow (`writeAuditTx` inside transaction)
  - All LLM-dependent services use StubProvider (deterministic, simulated: true)
  - 5 ADRs (ADR-0013 through ADR-0017)
- **Per-mission SHAs:**
  | Mission | SHA |
  |---------|-----|
  | 01-00 | `a6b162e` |
  | 01-01 | `6d981e7` |
  | 01-02 | `dd1fff1` |
  | 01-03 | `0927d11` |
  | 01-04 | `84942cc` |
  | 01-05 | `72999e5` |
  | 01-06 | `7dd3653` |
  | 01-07 | `a7d113a` |
  | 01-08 | `110ed14` |
  | 01-09 | `bc61940` |
  | 01-10 | `9dc88d7` |
- **Authoritative docs:** `docs/mission-reports/G01/GROUP_01_FINAL_REVIEW.md`, `GROUP_01_ACCEPTANCE_MATRIX.md`, `GROUP_01_KNOWN_LIMITATIONS.md`

### GROUP 02 — State Observatory (APPROVED — FINAL PASS — CLOSED)

- **Missions:** 02-00 through 02-05 (6 missions)
- **Final implementation SHA:** `b5fb96503ab4a11bc0204c6cf6a020b1c2d2cbd3` (mission code complete)
- **Final closure SHA:** `0c04d535b0ed01aca4c1264729bb46e8a4be61b8` (documentation-only commit after closure)
- **CI #167:** SUCCESS — https://github.com/mayakilzy/The-Balance/actions/runs/39120570514
- **Recovery #105:** SUCCESS — https://github.com/mayakilzy/The-Balance/actions/runs/39120570511
- **CI #168 (on closure SHA):** SUCCESS — https://github.com/mayakilzy/The-Balance/actions/runs/39140433813
- **Recovery #106 (on closure SHA):** SUCCESS — https://github.com/mayakilzy/The-Balance/actions/runs/39140433786
- **Total Tests:** 817 passed | 10 skipped | 0 failed
- **Key deliverables:**
  - 5 new G02 tables (IndicatorDefinition, ObservationPeriod, Observation, VarianceRecord, Alert) — all RLS ENABLE + FORCE
  - 1 G02 migration (total: 21 migrations = 16 G00 + 4 G01 + 1 G02: `20261018000021_g02_observatory_bootstrap`)
  - 17 state-observatory modules (5,334 lines): contracts, threshold-evaluator, 4 core services (02-00), provenance-validator, evidence-country-validator (02-01), evidence-independence, aggregate-independence, observatory-query (02-02), temporal-trend, early-warning (02-03), institutional-view, sector-view (02-04), permissioned-view (02-05), index barrel
  - 8 new permissions (`observatory:indicator:*`, `observatory:observation:*`, `observatory:variance:*`, `observatory:alert:*`)
  - 7 sentinel regression tests for FixtureTracker ownership semantics
  - 100+ frozen decisions (Q1-Q15, R1-R5, E1-E8, F1-F6, A1-A18, B1-B16, C1-C18, D1-D14, E1-E16)
- **Per-mission SHAs:**
  | Mission | SHA | Status |
  |---------|-----|--------|
  | 02-00 | `6672460` | APPROVED |
  | 02-01 | `7c29b83` | APPROVED |
  | 02-02 | `1a983bd` | FINAL PASS |
  | 02-03 | `0945aef` | FINAL PASS |
  | 02-04 | `8ca300c` | FINAL PASS |
  | 02-05 | `b5fb965` | FINAL PASS |
- **G02-L21 closure path (3 commits):**
  1. `6c18c7a` — removed 146 redundant `track.observationPeriod` bypass lines; added ownership-aware `trackOwned` tracking for all `beforeAll` shared fixtures; added 4 sentinel regression tests
  2. `11a813b` — removed text-based exception suppression in `FixtureTracker.cleanup()`; added FINAL-1 (negative regression), FINAL-2 (parallel cleanup), FINAL-2b (parallel with overlap)
  3. `b5fb965` — fixed FINAL-1 test (broken PrismaClient for deterministic DB error)
- **Authoritative docs:**
  - `docs/mission-reports/G02/GROUP_02_FINAL_REVIEW.md`
  - `docs/mission-reports/G02/GROUP_02_ACCEPTANCE_MATRIX.md`
  - `docs/mission-reports/G02/GROUP_02_KNOWN_LIMITATIONS.md`
  - `docs/mission-reports/G02/GROUP_03_READINESS_HANDOFF.md`

### GROUP 03 — Targeted Reform (NOT STARTED — IMPLEMENTATION NOT AUTHORIZED)

No work accomplished. GROUP 03 is in scope review only. See Section 9 for the expected roadmap.

---

## 8. Present Condition

### Verified State (as of 2026-10-18)

- **Repository:** `mayakilzy/The-Balance` on `main` branch
- **HEAD SHA:** `0c04d535b0ed01aca4c1264729bb46e8a4be61b8`
- **Working tree:** CLEAN (verified after `git config core.fileMode false` to ignore filesystem mode-bit noise)
- **Remote main SHA:** matches HEAD (`0c04d535b0ed01aca4c1264729bb46e8a4be61b8`)
- **CI #168:** SUCCESS on `0c04d53` — https://github.com/mayakilzy/The-Balance/actions/runs/39140433813
- **Recovery #106:** SUCCESS on `0c04d53` — https://github.com/mayakilzy/The-Balance/actions/runs/39140433786
- **Test counts:** 817 passed | 10 skipped | 0 failed (no regressions from documentation commit)
- **GROUP 00:** APPROVED
- **GROUP 01:** APPROVED — FINAL PASS
- **GROUP 02:** APPROVED — FINAL PASS — CLOSED
- **GROUP 03:** READY FOR SCOPE REVIEW — IMPLEMENTATION NOT AUTHORIZED

### Current Defects

**None.** All open defects from GROUP 02 are closed (G02-L21) or documented as deliberate design choices (G02-L25, G02-L26) or deferred (G02-L22, G02-L23, G02-L24).

### Open Risks

1. **G02-L25 (Publication Approval Gap)** — Public and Research tiers return `publication_unavailable`. This is deliberate fail-closed. Future mission must design a publication approval workflow. Until then, no claim of operational public publication.
2. **G02-L26 (Government Projection Limited to Public Evidence)** — Government tier shows only `classification="public"` evidence. Conservative security design. Granular clearance model requires explicit owner approval.
3. **G02-L22 (Institutional Early Warning Not Computed)** — deferred to future mission
4. **G02-L23 (No Hierarchical Institution Aggregation)** — deferred to future mission
5. **G02-L24 (Sector View Observability Not Computed)** — deferred to future mission
6. **Simulated Intelligence (StubProvider)** — all LLM-dependent services use StubProvider; no real LLM is integrated
7. **No Real Country Data** — Demolandia (fictional) only
8. **No Browser UI for Observatory** — G02-L03, not implemented
9. **Audit Failure Injection Test** — structural verification only; forced failure injection of `writeAuditTx` was NOT implemented
10. **Sub-Year Granularity** — yearly/quarterly/monthly only (G02-L01)
11. **alertThresholds Limited to 2 Rules per Indicator** — G02-L02
12. **No Real Data Integration** — World Bank, IMF, etc. not integrated (G02-L04)
13. **No External Integrations** — Email/SMS/webhooks not implemented (G02-L05)
14. **LLM-assisted Interpretation** — not implemented (G02-L06, advisory only)
15. **Subnational Variance Computation** — not implemented (G02-L09)
16. **Idempotency on Variance Computation** — not implemented (G02-L11)

### Known Limitations (Authoritative Register)

See `docs/mission-reports/G02/GROUP_02_KNOWN_LIMITATIONS.md` for the full register. Status summary:

- **CLOSED:** G02-L21 (test cleanup isolation)
- **DOCUMENTED (deliberate):** G02-L25 (publication approval gap), G02-L26 (government projection limited to public evidence)
- **DEFERRED:** G02-L22 (institutional early warning), G02-L23 (hierarchical institution aggregation), G02-L24 (sector view observability)
- **CARRIED FROM GROUP 01:** 11 limitations (simulated intelligence, evidence support assessment, counter-evidence provenance, budget estimates, timeline, advisor abstention, browser E2E, no real country data, single-tenant testing, counter-evidence country scope [RESOLVED in 02-01], audit failure injection)
- **CARRIED FROM 02-00:** 11 limitations (G02-L01 through G02-L11, with G02-L08 RESOLVED in 02-01 and G02-L10 RESOLVED)

### Accepted Technical Debt

- Browser UI for observatory not built (G02-L03) — platform has API-only observatory
- Real data integration not built (G02-L04) — Demolandia only
- LLM-assisted interpretation not built (G02-L06) — all intelligence is structural
- Audit failure injection test not built — structural verification only
- Sub-year granularity not supported — yearly/quarterly/monthly only
- alertThresholds capped at 2 rules per indicator

---

## 9. Future Roadmap

### Six-Group Roadmap (High-Level)

| Group | Name | Status | Next Action |
|-------|------|--------|-------------|
| GROUP 00 | Foundation | APPROVED | None |
| GROUP 01 | State Builder | APPROVED — FINAL PASS | None |
| GROUP 02 | State Observatory | APPROVED — FINAL PASS — CLOSED | None |
| GROUP 03 | Targeted Reform | READY FOR SCOPE REVIEW | **Owner defines scope** |
| GROUP 04 | (TBD) | NOT STARTED | TBD |
| GROUP 05 | (TBD) | NOT STARTED | TBD |
| GROUP 06 | (TBD) | NOT STARTED | TBD |

### GROUP 03 — Expected Sequence (NOT FROZEN — Owner Defines Scope)

Based on the Six-Group Roadmap and `GROUP_03_READINESS_HANDOFF.md`, GROUP 03 (Targeted Reform) is expected to:

1. **Consume observatory signals** (`VarianceRecord`, `Alert`) as reform triggers — read-only consumption, no automatic reform creation
2. **Generate reform proposals** in response to alerts — with LLM assistance (advisory only, never replacing human review)
3. **Route proposals through the human approval workflow** — inherited from GROUP 01 (`approveStrategyVersionWithAuditSafe` pattern)
4. **Track reform implementation progress** — against the originating alert
5. **Close the loop:** alert → reform proposal → approval → implementation → verification
6. **NOT automatically create reform proposals** — the human remains sovereign
7. **NOT claim causal attribution** — `attributionLevel = "descriptive"` is platform-wide

### Expected Mission Decomposition (NOT FROZEN)

Following the GROUP 02 pattern (one bootstrap mission for schema, subsequent missions for services):

- **03-00:** Targeted Reform Bootstrap — schema (new tables), permissions, vertical slice
- **03-01+:** Service missions (proposal generation, approval workflow integration, implementation tracking, verification)

The exact decomposition will be defined by the owner after reviewing `GROUP_03_READINESS_HANDOFF.md`.

### How Observatory Results Become Reform Proposals (Without Causal Claims)

This is the central epistemic design constraint for GROUP 03:

1. **Observatory outputs are descriptive, not causal.** VarianceRecord reports "planned X, observed Y, variance Z." It does NOT claim "X caused Y" or "Y caused Z."
2. **Reform proposals reference variance, not causation.** A proposal says: "Variance of Z observed in indicator I, period P. Proposed reform: action A." It does NOT say: "Action A will fix variance Z."
3. **LLM assistance is advisory only.** If GROUP 03 uses LLM to draft proposals, the LLM output is a draft for human review — never an automatic proposal.
4. **The human remains sovereign.** No automatic reform creation, no automatic approval, no automatic execution. Every step requires explicit human action with audit trail.
5. **`attributionLevel = "descriptive"` is the platform-wide invariant.** This is preserved from GROUP 02 and MUST be preserved in GROUP 03.

### Separation of Concerns (Observatory vs. Decision vs. Approval vs. Execution vs. Verification)

| Layer | Owner | Responsibility |
|-------|-------|----------------|
| Observatory | GROUP 02 (DONE) | Measure, compute variance, raise alerts |
| Decision | GROUP 03 (NOT STARTED) | Document human decision on alert (inherited from G02 alert lifecycle: detected → notified → reviewed → **decision_documented** → closed) |
| Approval | GROUP 01 (DONE) + GROUP 03 (NOT STARTED) | Atomic approval workflow (`writeAuditTx` inside transaction) |
| Execution | GROUP 03 (NOT STARTED) | Track reform implementation progress |
| Verification | GROUP 02 (DONE) + GROUP 03 (NOT STARTED) | `verifyExecution` requires `verifiedAction` + `evidenceSource` (F6) |

GROUP 03 must preserve this separation. Reform proposals do not modify observatory data; observatory data informs reform proposals (read-only).

### Proposed Next Action (NOT Authorization)

**AWAITING OWNER AUTHORIZATION TO START GROUP 03 IMPLEMENTATION.**

Until then:
- No GROUP 03 code is to be written
- No GROUP 03 schema changes or migrations are to be created
- No GROUP 03 tests are to be added
- The `GROUP_03_READINESS_HANDOFF.md` and this master handoff are the only GROUP 03 artifacts

---

## 10. Secrets/Access Handoff (Metadata Only — NO Values)

### Required Credentials (Names and Scopes Only)

| Credential alias | Purpose | Required access | Owner-managed source | Storage method | Rotation owner | Availability |
|------------------|---------|-----------------|----------------------|----------------|----------------|--------------|
| `PROJECT_GITHUB_TOKEN` | Read/write to `mayakilzy/The-Balance` (push to `main`) | `repo` scope (fine-grained preferred, contents:write, actions:read, metadata:read) | GitHub Personal Access Token issued by project owner | Local credential file at an undocumented path outside version control (chmod 600, gitignored) | Project owner | `AVAILABLE` (provisioned by owner; re-provision required in new environment — see Note below) |
| `AUTH_SECRET` | Auth.js v5 session signing (required for tests) | N/A (local secret) | Generated locally with `openssl rand -base64 32` | `.env` file (gitignored) | Developer | `AVAILABLE` (generate locally) |
| `DATABASE_URL` | App runtime DB connection (RLS-enforced `balance_app` role) | PostgreSQL 16 + pgvector | `docker-compose.yml` (local dev) | `.env` file (gitignored) | Developer | `AVAILABLE` (local dev) |
| `DIRECT_URL` | Migrations + seed DB connection (`balance_admin` BYPASSRLS role) | PostgreSQL 16 + pgvector | `docker-compose.yml` (local dev) | `.env` file (gitignored) | Developer | `AVAILABLE` (local dev) |
| `AUTH_DATABASE_URL` | Auth bootstrap DB connection (`balance_auth` read-only role) | PostgreSQL 16 + pgvector | `docker-compose.yml` (local dev) | `.env` file (gitignored) | Developer | `AVAILABLE` (local dev) |
| `LLM_PROVIDER` | Selects LLM provider (default: `stub`) | N/A | `.env.example` | `.env` file (gitignored) | Developer | `AVAILABLE` (default `stub`) |
| `ZAI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Real LLM provider keys (only if `LLM_PROVIDER` is set to non-stub) | Provider-specific | Provider dashboards | `.env` file (gitignored) | Project owner | `NOT VERIFIED` (stub is default; real keys not required for any current mission) |

### Note on `PROJECT_GITHUB_TOKEN` Re-provisioning

> **Important for the new chat session:** The GitHub token does NOT carry over between chats, agents, machines, browser sessions, or sandboxes. The outgoing session's local credential file at `/home/z/my-project/secrets/.glm-tokens` will NOT persist.

The owner provisions the token via a private archive at:
- **Source URL:** `https://github.com/mayakilzy/repo-info/raw/main/GeneralGH/GeneralGH.zip`
- **Decode step:** `head -1 "General GH.md" | tr -d '\r\n+'` (removes `+` obfuscation)
- **Storage:** local file with `chmod 600`, gitignored, path NOT documented in any committed file
- **Push usage:** `GIT_ASKPASS=<askpass-script> GIT_TERMINAL_PROMPT=0 git push origin <branch>:main`

The incoming session MUST request token re-provisioning from the owner (or follow the same download-decode-store sequence) before any push to `main` is possible. **Do NOT request that the owner paste the token into an ordinary chat message.** Ask the owner to confirm the source URL and decode step instead.

### How to Push (Without Exposing the Token)

```bash
# 1. Provision token to local file (path NOT documented in any committed file)
# 2. Create askpass script:
cat > /path/to/.askpass.sh << 'EOF'
#!/bin/bash
cat /path/to/.glm-tokens
EOF
chmod 700 /path/to/.askpass.sh

# 3. Push using askpass (token never appears in command line or logs):
GIT_ASKPASS=/path/to/.askpass.sh GIT_TERMINAL_PROMPT=0 git push origin main
```

### What NOT to Do

- **Never** include real tokens, passwords, private keys, recovery codes, or full environment files in any handoff, public repo, chat transcript, issue, screenshot, log, or commit
- **Never** embed tokens in clone URLs or Git remote URLs
- **Never** print token values for debugging
- **Never** request that the owner paste credentials into an ordinary chat message
- **Never** assume credentials carry over from a prior chat — they do not

### End-of-Development Cleanup (Owner-Requested Later)

The owner plans to request credential removal at the end of development. Until then, do not revoke or delete a working credential without instruction. When explicitly asked:
- Identify credential locations and dependencies first, without printing values
- Remove project secrets from disposable workspaces, ignored environment files, credential-store entries, or connected environments within the agent's actual access and authority
- Have the owner revoke/rotate the relevant GitHub credential using GitHub's settings and remove unused CI/deployment secrets
- Confirm no sensitive files are tracked; inspect git history for exposures
- If a token was ever committed or publicly exposed, **revoke/rotate it immediately**; merely deleting the current file is insufficient

---

## 11. Resumption Checkpoint

```
PROJECT_NAME              = THE BALANCE (الميزان)
REPOSITORY                = https://github.com/mayakilzy/The-Balance
DEFAULT_BRANCH            = main
LAST_VERIFIED_CODE_SHA    = b5fb96503ab4a11bc0204c6cf6a020b1c2d2cbd3
LAST_VERIFIED_DOCS_SHA    = 0c04d535b0ed01aca4c1264729bb46e8a4be61b8
LAST_APPROVED_GROUP       = GROUP 02 (State Observatory) — FINAL PASS — CLOSED
LAST_APPROVED_MISSION     = 02-05 (Permissioned Observatory Views) — FINAL PASS
CURRENT_MISSION           = NONE (GROUP 03 scope review pending owner action)
NEXT_PLANNED_MISSION      = 03-00 (Targeted Reform Bootstrap) — TBD by owner
CI_VERIFIED               = CI #168 SUCCESS on 0c04d53
                            https://github.com/mayakilzy/The-Balance/actions/runs/39140433813
RECOVERY_VERIFIED         = Recovery #106 SUCCESS on 0c04d53
                            https://github.com/mayakilzy/The-Balance/actions/runs/39140433786
WORKTREE_STATUS           = CLEAN (verified 2026-10-18; `git config core.fileMode false` to ignore mode-bit noise)
ENVIRONMENT               = DEVELOPMENT (no staging/production deployed)
GROUP_00_STATUS           = APPROVED
GROUP_01_STATUS           = APPROVED — FINAL PASS
GROUP_02_STATUS           = APPROVED — FINAL PASS — CLOSED
GROUP_03_STATUS           = READY FOR SCOPE REVIEW — IMPLEMENTATION NOT AUTHORIZED
NEXT_ACTION               = WAIT_FOR_OWNER_INSTRUCTIONS
```

### Verification Date and Source of Critical Facts

- **Date:** 2026-10-18
- **Source:** Direct inspection of `mayakilzy/The-Balance` repository at `0c04d535b0ed01aca4c1264729bb46e8a4be61b8`
- **Verification method:** `git ls-remote origin main` + GitHub Actions API for CI/Recovery run status
- **Authoritative closure documents:** 4 files in `docs/mission-reports/G02/` (see Section 2)

---

## 12. Instructions to the Next Conversation

### Step 1 — Read the protocol and this handoff in full

1. Read `https://github.com/mayakilzy/repo-info/blob/main/PROJECT_CHAT_HANDOFF_PROTOCOL.md` (MODE B — RESUME_FROM_HANDOFF)
2. Read this handoff document in full
3. Read the 4 authoritative GROUP 02 closure documents:
   - `docs/mission-reports/G02/GROUP_02_FINAL_REVIEW.md`
   - `docs/mission-reports/G02/GROUP_02_ACCEPTANCE_MATRIX.md`
   - `docs/mission-reports/G02/GROUP_02_KNOWN_LIMITATIONS.md`
   - `docs/mission-reports/G02/GROUP_03_READINESS_HANDOFF.md`

### Step 2 — Verify repository access and current state

1. Clone or pull `https://github.com/mayakilzy/The-Balance` to a local working directory
2. Verify the HEAD SHA matches `0c04d535b0ed01aca4c1264729bb46e8a4be61b8` (or a later authorized commit — inspect new commits if Git has advanced)
3. Verify `git status` is clean (if mode-bit noise appears, run `git config core.fileMode false`)
4. Verify GitHub Actions: latest CI and Recovery runs on the latest commit are both SUCCESS
5. Compare the repository's latest verified state to the handoff checkpoint. If Git has advanced, inspect the new commits to determine if they are authorized changes. **Never silently roll back or overwrite them.**

### Step 3 — Check required access (without revealing secrets)

| Access | How to verify | Status to report |
|--------|---------------|------------------|
| Repository read | `git clone` or `git pull` succeeds | `available` / `missing` / `inaccessible` |
| Repository write (push to `main`) | Owner confirms token provision; do NOT print token value | `available` / `not verified` / `missing` |
| Local PostgreSQL | `docker compose up -d postgres` succeeds; `psql` connects | `available` / `missing` |
| Auth.js secret | `.env` contains `AUTH_SECRET` of ≥16 chars | `available` / `missing` |
| Test execution | `AUTH_SECRET=... bun run test` runs | `available` / `missing` |

**Do NOT request that the owner paste credentials into an ordinary chat message.** Ask the owner to confirm the token source URL and decode step (see Section 10) or to provision via a trusted integration.

### Step 4 — Produce a RESUMPTION READINESS REPORT

Summarize:
- The checkpoint (Section 11)
- Any discrepancy between the handoff and the verified repository state
- Any blockers (missing access, failing CI, etc.)
- The exact next intended mission (GROUP 03 scope review — NOT implementation)

### Step 5 — WAIT for the owner's next instruction

**Do NOT:**
- Start GROUP 03 implementation
- Edit code
- Create new branches
- Run deployment commands
- Install new integrations
- Rotate credentials
- Push commits

**DO:**
- Confirm readiness
- Wait for the owner's explicit authorization to proceed with GROUP 03 scope review or implementation

### Stop Boundary

This handoff is **PREPARE_HANDOFF only**. The outgoing session stops after publishing this document. The incoming session stops after producing the RESUMPTION READINESS REPORT and waits for the owner.

---

## 13. Appendix

### A. Glossary

| Term | Definition |
|------|------------|
| **RLS** | Row-Level Security (PostgreSQL feature for tenant isolation) |
| **RBAC** | Role-Based Access Control |
| **ABAC** | Attribute-Based Access Control |
| **BYPASSRLS** | PostgreSQL role attribute allowing RLS bypass (only `balance_admin` has this) |
| **F1-F6** | GROUP 02 final-fix decisions (NULL-safe index, atomic correction, chain trigger, nullable source, inline test specs, verifiedAction semantic) |
| **R1-R5** | GROUP 02 refinements (origin/verification split, period-comparable targets, per-indicator thresholds, history preservation, decision/execution separation) |
| **Q1-Q15** | GROUP 02 architectural decisions (5 tables, 4 services, etc.) |
| **A1-A18** | 02-01 provenance validation decisions |
| **B1-B16** | 02-02 evidence independence + observability snapshot decisions |
| **C1-C18** | 02-03 temporal integrity + early warning decisions (C18 = G02-L21) |
| **D1-D14** | 02-04 institutional + sector view decisions |
| **E1-E16** | 02-05 permissioned view decisions |
| **T1** | GROUP 01 integration test (baseline → advisory → human approval) |
| **T2** | GROUP 02 integration test (ingest → variance → alert → review → decide → verify → close) |
| **G02-L21** | Test Cleanup Isolation limitation — CLOSED |
| **G02-L25** | Publication Approval Gap — DOCUMENTED (deliberate fail-closed) |
| **G02-L26** | Government Projection Limited to Public Evidence — DOCUMENTED (conservative security) |
| **Demolandia (DML)** | Fictional country used for testing |
| **FixtureTracker** | Ownership-aware test cleanup helper (`tests/integration/helpers/fixture-tracker.ts`) |
| **trackOwned** | FixtureTracker API that only tracks records with `createdByThisSuite=true` |
| **StubProvider** | Deterministic non-AI LLM provider (default) |
| **attributionLevel** | Platform-wide invariant; always `"descriptive"` (no causal claims) |

### B. Critical Links

| Resource | URL |
|----------|-----|
| Repository | https://github.com/mayakilzy/The-Balance |
| Latest CI run | https://github.com/mayakilzy/The-Balance/actions/runs/39140433813 |
| Latest Recovery run | https://github.com/mayakilzy/The-Balance/actions/runs/39140433786 |
| Handoff protocol | https://github.com/mayakilzy/repo-info/blob/main/PROJECT_CHAT_HANDOFF_PROTOCOL.md |
| Planning documents | https://github.com/mayakilzy/repo-info/tree/main/The-Balance-Doc |
| GitHub access continuity | `docs/handoffs/GITHUB_ACCESS_CONTINUITY.md` (in repo) |
| Token source (owner-provisioned) | https://github.com/mayakilzy/repo-info/raw/main/GeneralGH/GeneralGH.zip |

### C. Critical Commands

```bash
# Clone the repository
git clone https://github.com/mayakilzy/The-Balance.git
cd The-Balance

# Disable fileMode noise (if mode-bit flips appear)
git config core.fileMode false

# Install dependencies
bun install

# Start PostgreSQL
docker compose up -d postgres

# Configure environment
cp .env.example .env
# Edit .env — set AUTH_SECRET with: openssl rand -base64 32

# Generate Prisma client + push schema
bunx prisma generate
bunx prisma db push

# Seed ontology (Demolandia)
bunx tsx prisma/seed-ontology.ts

# Run tests (unit + integration on real PostgreSQL)
AUTH_SECRET="ci_only_secret_not_for_production_min_16_chars" bun run test

# Run only G02 sentinel tests
AUTH_SECRET="..." bunx vitest run tests/integration/g02-l21-sentinel.integration.test.ts

# Run integration tests (requires real PostgreSQL)
RUN_INTEGRATION_TESTS=1 AUTH_SECRET="..." bun run test

# Typecheck
bunx tsc --noEmit

# Lint
bun run lint

# Push to main (with token provisioned — see Section 10)
GIT_ASKPASS=/path/to/.askpass.sh GIT_TERMINAL_PROMPT=0 git push origin main
```

### D. Evidence Index

| Claim | Evidence |
|-------|----------|
| GROUP 02 APPROVED — FINAL PASS | `docs/mission-reports/G02/GROUP_02_FINAL_REVIEW.md` + owner's verbatim approval (see Section 7) |
| G02-L21 CLOSED | CI #167 + Recovery #105 on `b5fb965` + 7 sentinel tests PASS |
| 817 tests passed | CI #168 logs: "Tests 817 passed | 10 skipped (827)" |
| No production observatory changes in closure | Diff between `b5fb965` and `0c04d53` is documentation-only (5 doc files) |
| `attributionLevel = "descriptive"` always | `prisma/schema.prisma` VarianceRecord model + `src/lib/state-observatory/variance-service.ts` |
| RLS ENABLE + FORCE on all G02 tables | `prisma/migrations/20261018000021_g02_observatory_bootstrap/migration.sql` |
| No GROUP 03 work started | `git log --oneline` shows no GROUP 03 commits; `src/lib/reform/` does not exist |

### E. Unresolved Questions (None at Handoff Time)

All critical questions are resolved. The only open question is owner-defined: **what is the GROUP 03 scope?** This is for the owner to define, not for GLM to assume.

### F. Worklog Reference

A multi-agent worklog is maintained at `/home/z/my-project/worklog.md` during the outgoing session. This file is NOT committed to the repository (it lives in the agent's working directory). The incoming session should start a new worklog at the same path. Prior worklog content is summarized in this handoff document.

---

## Footer

**Document version:** 1.0
**Protocol compliance:** MODE A — PREPARE_HANDOFF, sections A1-A5 + 13-section structure
**Authorization:** Documentation only. **GROUP 03 implementation is NOT AUTHORIZED.**
**Next action:** WAIT_FOR_OWNER_INSTRUCTIONS

The platform is ready. The foundation is solid. The human remains sovereign. ☕⚖️🤝
