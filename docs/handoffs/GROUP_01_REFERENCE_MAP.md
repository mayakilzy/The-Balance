# GROUP 01 — Reference Map

**Document type:** File and directory responsibility map
**Purpose:** Quick navigation guide for the THE BALANCE repository.
**Date:** 2026-10-17

---

## 1. Documentation (specs, reports, ADRs)

### Root
| Path | Responsibility |
|------|----------------|
| `README.md` | Project overview, stack, quick start |
| `BASELINE.md` | Repository baseline documentation |
| `.env.example` | Environment variable template (no real secrets) |
| `.gitignore` | Git ignore rules (includes `.env`, `.secrets/`) |
| `docker-compose.yml` | PostgreSQL 16 + pgvector local dev container |
| `package.json` | Dependencies + scripts |
| `tsconfig.json` | TypeScript configuration |
| `vitest.config.ts` | Vitest test configuration |
| `playwright.config.ts` | Playwright E2E configuration |
| `eslint.config.mjs` | ESLint configuration |
| `next.config.ts` | Next.js configuration |
| `postcss.config.mjs` | PostCSS (Tailwind) configuration |

### `docs/`
| Path | Responsibility |
|------|----------------|
| `docs/RUNBOOK.md` | Operations runbook: install + operate + recover |
| `docs/adr/ADR-0001-stack-selection.md` | Stack selection decision |
| `docs/adr/ADR-0002-llm-provider-abstraction.md` | LLM provider abstraction |
| `docs/adr/ADR-0003-tenant-isolation.md` | RLS tenant isolation |
| `docs/adr/ADR-0004-country-tenant-separation.md` | Country/Tenant + PUBLIC/PRIVATE scope |
| `docs/adr/ADR-0005-rls-roles-and-policies.md` | Three DB roles design |
| `docs/adr/ADR-0006-hierarchy-integrity.md` | Hierarchy integrity triggers |
| `docs/adr/ADR-0007-authentication-design.md` | Auth.js v5 design |
| `docs/adr/ADR-0008-rbac-abac-design.md` | RBAC/ABAC permission design |
| `docs/adr/ADR-0009-evidence-fabric-design.md` | Evidence Fabric design |
| `docs/adr/ADR-0010-strategy-contracts-design.md` | Strategy Contracts design |
| `docs/adr/ADR-0011-capability-registry-design.md` | Capability Registry design |
| `docs/adr/ADR-0012-security-hardening-design.md` | Security hardening design |

### `docs/mission-reports/G00/`
| Path | Responsibility |
|------|----------------|
| `GROUP_00_FINAL_REVIEW.md` | Evidence-based final review of G00 |
| `GROUP_00_ACCEPTANCE_MATRIX.md` | Mission-by-mission acceptance mapping |
| `GROUP_00_KNOWN_LIMITATIONS.md` | 14 documented limitations (none blocking G01) |
| `GROUP_01_READINESS_HANDOFF.md` | What G01 inherits + must build + must not touch |
| `00-01_REPORT.md` | Detailed 00-01 mission report |

### `docs/mission-reports/G01/`
| Path | Responsibility |
|------|----------------|
| `GROUP_01_MISSION_PACK.md` | 11-mission plan for State Builder (DRAFT — awaiting approval) |

### `docs/handoffs/`
| Path | Responsibility |
|------|----------------|
| `GROUP_01_MASTER_CONTEXT_HANDOFF.md` | Comprehensive context for new development chat |
| `GITHUB_ACCESS_CONTINUITY.md` | Non-sensitive GitHub authentication guidance |
| `GROUP_01_NEW_CHAT_INTRODUCTION.md` | Arabic opening message for new chat |
| `GROUP_01_REFERENCE_MAP.md` | This file — repository navigation map |

---

## 2. Software Contracts (interfaces, types, schemas)

### `prisma/`
| Path | Responsibility |
|------|----------------|
| `prisma/schema.prisma` | 22 Prisma models (8 PUBLIC + 14 PRIVATE) |
| `prisma/migrations/` | 16 migrations (0001–0016) + `migration_lock.toml` |
| `prisma/seed-ontology.ts` | Demolandia fixture seed (fictional country) |

### `src/lib/` (top-level contracts)
| Path | Responsibility |
|------|----------------|
| `src/lib/env.ts` | Zod-validated environment access |
| `src/lib/db.ts` | Prisma client singleton |
| `src/lib/auth.ts` | Auth.js v5 configuration (CredentialsProvider + JWT) |
| `src/lib/auth-bootstrap.ts` | Least-privilege auth queries (balance_auth role) |
| `src/lib/permissions.ts` | RBAC/ABAC permission service (4 roles, current-role auth) |
| `src/lib/password.ts` | bcrypt password hashing (cost 12) |
| `src/lib/audit.ts` | Append-only audit log writer (SHA-256 salted ipHash) |
| `src/lib/observability.ts` | pino structured logging |
| `src/lib/audit-observability.ts` | Request-scoped logger + sensitive data redaction |
| `src/lib/metrics.ts` | In-process operational metrics counters (edge-safe) |
| `src/lib/error-sanitizer.ts` | API error sanitization + log sanitization (9 secret patterns) |
| `src/lib/task-service.ts` | Durable Task Runtime (fencing + lease + idempotency) |
| `src/lib/balance-master.ts` | Balance Master stub (uses LLMProvider) |
| `src/lib/evidence-service.ts` | Evidence creation + pgvector search |
| `src/lib/strategy-service.ts` | Strategy + Version + Decision contracts |
| `src/lib/capability-service.ts` | Capability Registry + ExpertAdapter contract |

### `src/lib/llm/` (LLM Provider Abstraction)
| Path | Responsibility |
|------|----------------|
| `src/lib/llm/provider.ts` | `LLMProvider` interface (complete, stream, embed, health) |
| `src/lib/llm/stub-provider.ts` | StubProvider — deterministic SIMULATED responses |
| `src/lib/llm/index.ts` | Provider factory (`getLLMProvider()`) |

### `src/lib/security/`
| Path | Responsibility |
|------|----------------|
| `src/lib/security/tenant-context.ts` | `withAuthenticatedTenant` + `withPublicScope` (RLS enforcement) |

### `src/middleware.ts`
| Path | Responsibility |
|------|----------------|
| `src/middleware.ts` | Security headers, CSP, rate limiting, request IDs, trusted IP extraction |

---

## 3. Services (business logic — G00 complete)

All services in `src/lib/` are foundation-validated. G01 will add new services in `src/lib/state-builder/`.

### Existing Services (do NOT rebuild)
| Service | Key Functions |
|---------|---------------|
| `evidence-service.ts` | `createEvidence()`, `searchEvidence()`, `verifyEvidence()` |
| `strategy-service.ts` | `createStrategy()`, `createStrategyVersion()`, `approveStrategyVersion()`, `createDecision()` |
| `task-service.ts` | `createTask()`, `claimTask()`, `startTask()`, `completeTask()`, `failTask()`, `reclaimStaleTasks()` |
| `capability-service.ts` | `registerCapability()`, `discoverCapabilities()`, `checkEligibility()`, `invokeCapability()` |
| `audit.ts` | `writeAudit()` |
| `permissions.ts` | `hasPermission()`, `requirePermission()`, `requirePermissionWithCurrentRole()` |

### G01 Services (to be built — NOT yet implemented)
| Planned Service | Mission |
|-----------------|---------|
| `src/lib/state-builder/objective-service.ts` | 01-00 |
| `src/lib/state-builder/country-pack-service.ts` | 01-00 |
| `src/lib/state-builder/baseline-service.ts` | 01-01 |
| `src/lib/state-builder/gap-analysis-service.ts` | 01-02 |
| `src/lib/state-builder/strategy-composer-service.ts` | 01-03 |
| `src/lib/state-builder/program-service.ts` | 01-04 |
| `src/lib/state-builder/portfolio-service.ts` | 01-05 |
| `src/lib/state-builder/budget-service.ts` | 01-06 |
| `src/lib/state-builder/roadmap-service.ts` | 01-07 |
| `src/lib/state-builder/comparison-service.ts` | 01-08 |
| `src/lib/state-builder/advisor-service.ts` | 01-09 |
| `src/lib/state-builder/approval-service.ts` | 01-10 |

---

## 4. Database and Migrations

### Migration Files (16 total, in `prisma/migrations/`)
| Migration | Mission | Purpose |
|-----------|---------|---------|
| `20261016000001_init` | 00-01 | pgvector + tenants + audit_log |
| `20261016000002_ontology_and_rls` | 00-02 | countries, hierarchy, institutions, role_refs + RLS |
| `20261016000003_corrective_closure` | 00-02 | audit_log append-only (REVOKE UPDATE/DELETE) |
| `20261016000004_hierarchy_integrity` | 00-02 | cycle detection, same-country parent |
| `20261016000005_identity` | 00-03 | users, memberships |
| `20261016000006_auth_closure` | 00-03 | privilege tightening |
| `20261016000007_balance_auth_role` | 00-03 | least-privilege auth role |
| `20261016000008_evidence_fabric` | 00-04 | sources, evidence, evidence_embeddings |
| `20261016000009_regrant_balance_auth` | 00-04 | column-level SELECT re-grant |
| `20261016000010_sources_insert` | 00-04 | allow balance_app INSERT sources |
| `20261016000011_evidence_integrity` | 00-04 | 3 founder gaps closed |
| `20261016000012_strategy_contracts` | 00-05 | strategies, versions, decisions, events |
| `20261016000013_contract_integrity` | 00-05 | 3 founder gaps closed |
| `20261016000014_durable_tasks` | 00-06 | tasks, task_events, fencing |
| `20261016000015_runtime_integrity` | 00-06 | 3 founder gaps closed |
| `20261016000016_capability_registry` | 00-07 | capabilities, capability_invocations |

### G01 Migrations (planned, NOT yet created)
- Migration 0017 (01-00): Objectives, Programs, Projects, BudgetLines, Dependencies, Risks, Assumptions, CountryPackConfig

### Role Setup Scripts (in `scripts/`)
| Path | Responsibility |
|------|----------------|
| `scripts/setup-roles.sql` | Canonical SQL for 3 DB roles |
| `scripts/run-setup-roles.sh` | Wrapper with env-var-aware passwords |
| `scripts/init-roles.sql` | Docker Compose init script (runs on container creation) |

---

## 5. API Routes

### `src/app/api/` (16 routes)
| Route | Methods | Purpose |
|-------|---------|---------|
| `api/auth/[...nextauth]/route.ts` | (Auth.js handler) | Auth.js catch-all |
| `api/health/route.ts` | GET | Liveness + readiness (DB + LLM) |
| `api/v1/meta/route.ts` | GET | Build metadata + feature flags |
| `api/v1/countries/route.ts` | GET | PUBLIC countries list |
| `api/v1/auth/signin/route.ts` | POST | Login |
| `api/v1/auth/signout/route.ts` | POST | Logout |
| `api/v1/auth/me/route.ts` | GET | Current user + tenant |
| `api/v1/auth/switch-tenant/route.ts` | POST | Switch tenant context |
| `api/v1/evidence/route.ts` | GET, POST | List + create evidence |
| `api/v1/evidence/search/route.ts` | GET | pgvector semantic search |
| `api/v1/evidence/[id]/verify/route.ts` | POST | Verify evidence |
| `api/v1/tasks/route.ts` | GET, POST | List + create tasks |
| `api/v1/tasks/[id]/route.ts` | GET, POST | Task detail + execute |
| `api/v1/capabilities/route.ts` | GET | List capabilities |
| `api/v1/capabilities/[code]/invoke/route.ts` | POST | Invoke capability |
| `api/v1/_metrics/route.ts` | GET | Operational metrics (admin/reviewer/analyst) |

### G01 API Routes (planned, NOT yet created)
- `api/v1/objectives` (GET, POST)
- `api/v1/baseline` (GET, POST)
- `api/v1/gaps` (GET)
- `api/v1/strategies/compose` (POST)
- `api/v1/programs` (GET)
- `api/v1/portfolio/[altId]` (GET)
- `api/v1/budgets/[altId]` (GET)
- `api/v1/roadmap/[altId]` (GET)
- `api/v1/comparison` (POST)
- `api/v1/advisor/invoke` (POST)
- `api/v1/strategies/[id]/approve` (POST)

---

## 6. UI Pages

### `src/app/` (6 pages, Arabic RTL)
| Path | Responsibility |
|------|----------------|
| `src/app/layout.tsx` | Root layout (RTL, Arabic, Tailwind) |
| `src/app/page.tsx` | Home: tenant context + system health + SIMULATED notice |
| `src/app/login/page.tsx` | Auth.js login form |
| `src/app/tasks/page.tsx` | Tasks: list + create + detail + events |
| `src/app/evidence/page.tsx` | Evidence: list + verification status |
| `src/app/strategies/page.tsx` | Strategies: list |
| `src/app/capabilities/page.tsx` | Capabilities: list + readiness classification |
| `src/components/home-client.tsx` | Client component for home page |

### G01 UI Pages (planned, NOT yet created)
- Country dashboard
- Strategy builder workflow
- Baseline + Gap analysis views
- Portfolio + dependency graph view
- Budget + comparison views
- Approval workflow UI

---

## 7. Tests

### `tests/unit/` (7 files, 82 tests)
| File | Tests | Purpose |
|------|-------|---------|
| `health.test.ts` | 3 | Health endpoint unit tests |
| `llm-provider.test.ts` | 7 | StubProvider interface tests |
| `meta.test.ts` | 1 | Meta endpoint unit test |
| `error-sanitizer.test.ts` | 24 | Error sanitization + non-disclosure tests |
| `log-sanitization.test.ts` | 26 | Log sanitization with mocked logger |
| `metrics.test.ts` | 9 | Metrics counter behavior |
| `trusted-ip.test.ts` | 12 | Trusted IP extraction + spoofing negative tests |

### `tests/integration/` (10 files, 145 tests — require PostgreSQL)
| File | Tests | Purpose |
|------|-------|---------|
| `rls-isolation.integration.test.ts` | 19 | RLS tenant isolation |
| `auth-e2e.integration.test.ts` | 20 | Auth end-to-end + privilege escalation prevention |
| `evidence.integration.test.ts` | 15 | Evidence CRUD + search + verification |
| `strategy.integration.test.ts` | 18 | Strategy lifecycle + immutability |
| `task.integration.test.ts` | 13 | Task runtime: claim, fence, reclaim, idempotency |
| `capability.integration.test.ts` | 13 | Capability registry + adapter + no silent fallback |
| `tenant-context.integration.test.ts` | 7 | Tenant context enforcement |
| `role-passwords.integration.test.ts` | 3 | Role password verification |
| `security.integration.test.ts` | 37 | Security: API disclosure, trusted IP, metrics |
| `recovery.integration.test.ts` | 9 | Recovery: restart, crash/reclaim, backup/restore |

### `tests/e2e/` (1 file, 10 tests — require running Next.js server)
| File | Tests | Purpose |
|------|-------|---------|
| `http-auth.e2e.test.ts` | 10 | HTTP auth journey with cookie persistence |

### `tests/browser/` (1 file, 4 tests — Playwright with real Chromium)
| File | Tests | Purpose |
|------|-------|---------|
| `browser-journey.spec.ts` | 4 | Full browser journey: login → task → logout + mobile screenshots |

### G01 Tests (planned, NOT yet created)
| Planned File | Est. Tests | Type |
|---------------|------------|------|
| `tests/integration/baseline.integration.test.ts` | 12 | Integration |
| `tests/integration/gap-analysis.integration.test.ts` | 10 | Integration |
| `tests/integration/strategy-composer.integration.test.ts` | 14 | Integration |
| `tests/integration/portfolio.integration.test.ts` | 11 | Integration |
| `tests/integration/budget.integration.test.ts` | 9 | Integration |
| `tests/integration/comparison.integration.test.ts` | 8 | Integration |
| `tests/integration/advisor.integration.test.ts` | 10 | Integration |
| `tests/integration/approval.integration.test.ts` | 13 | Integration |
| `tests/integration/t1-journey.integration.test.ts` | 18 | Integration (T1) |
| `tests/browser/t1-state-builder.spec.ts` | 1 (long) | Playwright E2E |

---

## 8. CI Workflows

### `.github/workflows/`
| File | Purpose |
|------|---------|
| `ci.yml` | Primary CI: 19 steps (lint, typecheck, test, build, Playwright) |
| `fresh-install-recovery.yml` | Recovery CI: 7 phases (fresh install, recovery tests, restart, backup/restore, full tests on restored DB) |

---

## 9. Runbooks and Recovery Scripts

### `scripts/` (7 files)
| File | Purpose | Destructive? |
|------|---------|--------------|
| `fresh-install-verify.sh` | Verify fresh install from empty DB (runs migrations + seed) | YES — requires empty DB |
| `verify-restored-db.sh` | Non-destructive verification of restored DB | NO — read-only |
| `restart-verify.sh` | App restart + data persistence test | YES — starts/stops server |
| `backup-restore-test.sh` | Full backup → drop → restore drill + negative test | YES — drops + recreates DB |
| `run-setup-roles.sh` | Create 3 DB roles with env-var passwords | NO — idempotent |
| `setup-roles.sql` | Canonical role setup SQL | NO — idempotent |
| `init-roles.sql` | Docker Compose init script | NO — runs on container creation |

---

## 10. Closure Reports

### `docs/mission-reports/G00/` (GROUP 00 closure)
See §1 above for the 5 files in this directory.

### `docs/mission-reports/G01/` (GROUP 01 — draft)
| File | Status |
|------|--------|
| `GROUP_01_MISSION_PACK.md` | DRAFT — awaiting founder approval |

---

## 11. Quick Navigation by Task

| If you need to... | Look at... |
|-------------------|-----------|
| Understand the project vision | `docs/handoffs/GROUP_01_MASTER_CONTEXT_HANDOFF.md` §A |
| Find an ADR | `docs/adr/ADR-XXXX-*.md` |
| Understand a service contract | `src/lib/<service>.ts` (first comment block) |
| Find the Prisma schema | `prisma/schema.prisma` |
| Find a migration | `prisma/migrations/20261016NNNNNN_*/migration.sql` |
| Run the app | `docs/RUNBOOK.md` §1.8 |
| Run tests | `docs/RUNBOOK.md` or this doc §7 |
| Recover from failure | `docs/RUNBOOK.md` §3 |
| Understand G01 scope | `docs/mission-reports/G01/GROUP_01_MISSION_PACK.md` |
| Push to GitHub | `docs/handoffs/GITHUB_ACCESS_CONTINUITY.md` |
| Find test evidence | CI run logs (links in closure reports) |
| Find chronological history | `/home/z/my-project/worklog.md` |

---

*This map points to files and paths. It does not copy code. For full context, read the Master Context Handoff document.*
