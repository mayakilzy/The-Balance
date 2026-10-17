# GROUP 00 — Acceptance Matrix

**Mission 00-11 deliverable.** Maps every GROUP 00 mission to its acceptance criteria, evidence, and verdict.

**Final SHA:** `deccc963daf051d82e0b237df3793f003ca50744` (plus 00-11 cleanup commit)
**CI (primary):** Run #72 — PASS — https://github.com/mayakilzy/The-Balance/actions/runs/38984112379
**CI (recovery):** Run #10 — PASS — https://github.com/mayakilzy/The-Balance/actions/runs/38984112377
**Test count:** 237 passed | 10 skipped (247 total) across 18 test files

---

## Legend

- **PASS** — Criterion met, evidence verified in CI.
- **PARTIAL** — Criterion mostly met with documented limitation.
- **FAIL** — Criterion not met (none in GROUP 00).

---

## Mission 00-00 — Reuse & Dependency Audit

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| Audit swarm-engine code read-only | PASS | G00_REUSE_AND_DEPENDENCY_AUDIT.md (download/), 0% code reuse, pattern reference only |
| Audit AgentCraft-Toolkit | PASS | Not referenced in official docs; flagged in audit report |
| Distinguish running behavior from README claims | PASS | All swarm-engine components identified as 100% mock |
| Produce audit report | PASS | `/home/z/my-project/download/G00_REUSE_AND_DEPENDENCY_AUDIT.md` |

---

## Mission 00-01 — Runnable Platform Skeleton

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| Next.js 16 + TypeScript 5 project | PASS | `package.json`: next ^16.1.1, typescript ^5.7.2 |
| PostgreSQL 16 + pgvector connection | PASS | Migration 0001 creates pgvector extension; CI service `pgvector/pgvector:pg16` |
| Prisma 6 schema | PASS | `prisma/schema.prisma` — 22 models |
| Auth.js v5 skeleton | PASS | `src/lib/auth.ts`, `src/app/api/auth/[...nextauth]/route.ts` |
| Zod 4 env validation | PASS | `src/lib/env.ts` |
| pino structured logging | PASS | `src/lib/observability.ts` |
| Vitest test runner | PASS | `vitest.config.ts`, 20 test files |
| Health endpoint | PASS | `src/app/api/health/route.ts` — GET returns DB + LLM status |
| Meta endpoint | PASS | `src/app/api/v1/meta/route.ts` — GET returns build metadata + feature flags |
| CI pipeline | PASS | `.github/workflows/ci.yml` — 19 steps, all green |

---

## Mission 00-02 — Tenant/Country Ontology + RLS Foundation

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| Country ≠ Tenant separation (ADR-0004) | PASS | `countries` (PUBLIC) vs `tenants` (PRIVATE) in schema |
| State hierarchy (nation → province → district) | PASS | `state_hierarchy` model, migration 0002 + 0004 (cycle detection) |
| Institutions | PASS | `institutions` model, PUBLIC scope |
| PUBLIC vs PRIVATE scope tables | PASS | 8 PUBLIC tables, 14 PRIVATE tables (ADR-0004) |
| RLS enabled on all PRIVATE tables | PASS | `fresh-install-verify.sh` strict assertion: 14/14 ENABLE + FORCE |
| RLS policies enforce tenant isolation | PASS | `tests/integration/rls-isolation.integration.test.ts` — 19 tests |
| Hierarchy integrity triggers | PASS | Migration 0004 — cycle detection, same-country parent, country-change-with-children |
| Audit log append-only | PASS | Migration 0003 — REVOKE UPDATE/DELETE from balance_app; `security.integration.test.ts` verifies |
| Seed Demolandia fixture | PASS | `prisma/seed-ontology.ts` — 1 country, 2 tenants, 4 users, 4 roles |

---

## Mission 00-03 — Identity, Permissions, Tenant Isolation

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| Users + Memberships tables | PASS | Migration 0005; `User`, `Membership` models |
| Auth.js v5 CredentialsProvider | PASS | `src/lib/auth.ts` — bcrypt cost 12 |
| JWT carries userId, tenantId, roleCode, membershipStatus | PASS | `src/lib/auth.ts` callbacks |
| Three DB roles (ADR-0005) | PASS | `balance_admin` (BYPASSRLS), `balance_app` (RLS), `balance_auth` (read-only) |
| balance_auth column-level grants | PASS | Migration 0007 + 0009 — column-level SELECT on users for auth bootstrap |
| `withAuthenticatedTenant` | PASS | `src/lib/security/tenant-context.ts` — verifies session + fetches CURRENT membership |
| `requirePermissionWithCurrentRole` | PASS | `src/lib/permissions.ts` — checks CURRENT DB role (not stale JWT) |
| Tenant switching via `unstable_update` | PASS | `src/app/api/v1/auth/switch-tenant/route.ts` |
| Test users (admin, analyst, suspended, revoked) | PASS | `prisma/seed-ontology.ts` — 4 users @demolandia.test |
| Auth E2E (cookie persistence) | PASS | `tests/e2e/http-auth.e2e.test.ts` — 10 tests |
| Auth integration tests | PASS | `tests/integration/auth-e2e.integration.test.ts` — 20 tests |

---

## Mission 00-04 — Evidence + Scientific Source Fabric

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| Sources table (PUBLIC) | PASS | `Source` model, migration 0008 |
| Evidence table (PRIVATE) | PASS | `Evidence` model, migration 0008 |
| Evidence embeddings (pgvector 384-dim) | PASS | `EvidenceEmbedding` model, migration 0008 |
| Evidence creation with source linkage | PASS | `src/lib/evidence-service.ts` |
| Vector search (cosine similarity) | PASS | `src/app/api/v1/evidence/search/route.ts` — GET |
| Evidence verification | PASS | `src/app/api/v1/evidence/[id]/verify/route.ts` — POST |
| Evidence integrity closure | PASS | Migration 0011 — 3 founder gaps closed |
| balance_app can INSERT sources | PASS | Migration 0010 — allows tenant source references |
| Evidence integration tests | PASS | `tests/integration/evidence.integration.test.ts` — 15 tests |

---

## Mission 00-05 — Strategy + Version + Decision + Event Contracts

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| Strategies table | PASS | `Strategy` model, migration 0012 |
| Strategy versions (immutable when approved) | PASS | `StrategyVersion` model, trigger freezes approved versions |
| Decisions (evidence snapshot at decision time) | PASS | `Decision` model, migration 0012 |
| Decision events (append-only) | PASS | `DecisionEvent` model — REVOKE UPDATE/DELETE |
| Events (append-only) | PASS | `Event` model — REVOKE UPDATE/DELETE |
| Strategy lifecycle: proposed → implemented → approved → superseded | PASS | `tests/integration/strategy.integration.test.ts` — 18 tests |
| Contract integrity closure | PASS | Migration 0013 — 3 founder gaps closed |
| Invalid state transitions rejected | PASS | Strategy integration tests verify |

---

## Mission 00-06 — Durable Task Runtime + Balance Master Stub

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| Tasks table with fencing token | PASS | `Task` model, `claimGeneration` column, migration 0014 |
| Task events (append-only) | PASS | `TaskEvent` model — REVOKE UPDATE/DELETE |
| Claim task (SELECT FOR UPDATE SKIP LOCKED) | PASS | `src/lib/task-service.ts` — `claimTask()` |
| Fencing: claimGeneration increments on each claim | PASS | All operations verify claimedBy + claimGeneration + lease |
| Lease expiry + reclaim | PASS | `reclaimStaleTasks()` — atomic CTE with FOR UPDATE |
| Idempotency (UNIQUE partial index on idempotencyKey) | PASS | Migration 0014; `createTask()` handles P2002 |
| Balance Master stub | PASS | `src/lib/balance-master.ts` — uses LLMProvider |
| `executeNextTaskWithProvider` | PASS | claim → start → progress → complete/fail cycle |
| Runtime integrity closure | PASS | Migration 0015 — 3 founder gaps closed |
| Task integration tests | PASS | `tests/integration/task.integration.test.ts` — 13 tests |

---

## Mission 00-07 — Capability Registry + ExpertAdapter + Swarm Audit

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| Capabilities table (PUBLIC) | PASS | `Capability` model, migration 0016 |
| Capability invocations (PRIVATE) | PASS | `CapabilityInvocation` model — audit trail |
| ExpertAdapter contract | PASS | `src/lib/capability-service.ts` — interface with `execute()` |
| StubAdapter (deterministic, SIMULATED) | PASS | `src/lib/capability-service.ts` — `StubAdapter` class |
| No silent adapter fallback | PASS | Missing adapter FAILS (not stub fallback); integration test #9 verifies |
| Readiness classification (Stub/Mock/Live/Untested) | PASS | `readiness` field in Capability model |
| Swarm-engine 0% code reuse | PASS | G00_REUSE_AND_DEPENDENCY_AUDIT.md; pattern reference only |
| Capability integration tests | PASS | `tests/integration/capability.integration.test.ts` — 13 tests |

---

## Mission 00-08 — API + UI End-to-End Foundation

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| Login page (Auth.js real) | PASS | `src/app/login/page.tsx` |
| Home page (tenant context + system health) | PASS | `src/app/page.tsx`, `src/components/home-client.tsx` |
| Tasks page (list + create + detail + events) | PASS | `src/app/tasks/page.tsx` |
| Evidence page (list + verification status) | PASS | `src/app/evidence/page.tsx` |
| Capabilities page (readiness classification) | PASS | `src/app/capabilities/page.tsx` |
| Strategies page | PASS | `src/app/strategies/page.tsx` |
| Arabic RTL support | PASS | `src/app/layout.tsx` — dir="rtl", lang="ar" |
| Responsive (desktop + tablet + mobile) | PASS | Playwright mobile screenshot test |
| SIMULATED label on stub/mock results | PASS | UI shows SIMULATED notice; API responses include `simulated: true` |
| Page protection + API protection | PASS | All routes check `auth()` session |
| Playwright E2E (login → create task → view → logout) | PASS | `tests/browser/browser-journey.spec.ts` — 4 tests, CI screenshots |
| Demo credentials safety (SHOW_DEMO_CREDENTIALS env) | PASS | Login page conditionally shows creds |

---

## Mission 00-09 — Security Hardening, Audit and Observability

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| Security headers + CSP | PASS | `src/middleware.ts` — 7 headers including CSP |
| Rate limiting (auth, tasks, capabilities) | PASS | `src/middleware.ts` — 4 routes rate-limited |
| Trusted client IP (TRUSTED_PROXY gating) | PASS | `src/middleware.ts` — `extractClientIp()`; 12 unit tests |
| Structured logging with request/trace IDs | PASS | `src/lib/observability.ts` + `audit-observability.ts` |
| Basic operational metrics | PASS | `src/lib/metrics.ts` — 5 counters wired to middleware + routes |
| Audit log review (no secret leakage) | PASS | `tests/unit/log-sanitization.test.ts` — 26 tests with mocked logger |
| API error sanitization (no internal details) | PASS | `src/lib/error-sanitizer.ts` — `buildApiErrorResponse()`; 24 tests |
| Sensitive data redaction in logs | PASS | `sanitizeForLog()` — 9 secret patterns (PG URLs, Bearer, JWT, API keys, etc.) |
| ADR-0012 Security Hardening | PASS | `docs/adr/ADR-0012-security-hardening-design.md` |
| Security integration tests | PASS | `tests/integration/security.integration.test.ts` — 37 tests |

---

## Mission 00-10 — Fresh Install, Integration CI and Recovery

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| Fresh install from empty DB | PASS | `scripts/fresh-install-verify.sh` — CI Phase 1 |
| PostgreSQL migrations + seed | PASS | 16 migrations applied; seed creates Demolandia fixture |
| Login + Browser E2E | PASS | Playwright in CI #72 |
| Tenant RLS + RBAC | PASS | `rls-isolation.integration.test.ts` (19) + `security.integration.test.ts` (37) |
| Restart with data persistence | PASS | `scripts/restart-verify.sh` — CI Phase 3; `recovery.integration.test.ts` (9) |
| Task crash/reclaim | PASS | `recovery.integration.test.ts` — crash + reclaim + fencing tests |
| Database backup/restore drill | PASS | `scripts/backup-restore-test.sh` — CI Phase 4, fail-closed + negative test |
| Non-destructive restored DB verification | PASS | `scripts/verify-restored-db.sh` — CI Phase 4b |
| CI + production build | PASS | Both workflows green; `bun run build` succeeds |
| Operations runbook | PASS | `docs/RUNBOOK.md` — install + operate + recover |

---

## Summary

| Mission | Verdict | Key Evidence |
|---------|---------|--------------|
| 00-00 | PASS | Audit report |
| 00-01 | PASS | Runnable platform, CI green |
| 00-02 | PASS | 20 tables, RLS, hierarchy integrity |
| 00-03 | PASS | Auth.js v5, 3 DB roles, RBAC/ABAC |
| 00-04 | PASS | Evidence Fabric + pgvector search |
| 00-05 | PASS | Strategy contracts + immutability |
| 00-06 | PASS | Durable task runtime + fencing |
| 00-07 | PASS | Capability registry + ExpertAdapter |
| 00-08 | PASS | 6 UI pages + Playwright E2E |
| 00-09 | PASS | Security hardening + log sanitization |
| 00-10 | PASS | Fresh install + recovery + backup/restore |

**GROUP 00 = COMPLETE**
