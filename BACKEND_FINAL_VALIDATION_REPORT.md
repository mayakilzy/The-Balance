# BACKEND_FINAL_VALIDATION_REPORT.md

## THE BALANCE — Backend Final Validation Report

**Delivery 05 — Hard Validation & Backend Stabilization**
**Date:** 2026-10-23
**Main HEAD:** `49fb334fd36d2a63ecb79760a2a8103d158f517c` (post-PR-#9-merge)
**Branch:** `g04-delivery-05-hard-validation`
**Previous D05 head (failing):** `8ab6d21f84927393b1893510ad867e33e118172f`
**D05 fix SHA:** `<pending push — see Phase C below>`

---

## 0. Session Recovery Summary

This session began as a session handover after the previous engineering
sandbox became unavailable. The recovery verified:

- **Environment restored** in a clean sandbox: PostgreSQL 16.4 + pgvector 0.7.4
  compiled from source (no sudo, no docker available); Bun 1.3.14; Next.js
  16.4.2 with Turbopack; Prisma 6.19.3 client.
- **Repository state verified** at PR #10 head `8ab6d21` — matches the
  owner's handoff brief.
- **Failing CI run identified**: run id `39794829672`, job id `119879395864`,
  step #28 "G04 Delivery 05 Hard Validation E2E" — all other 27 CI steps
  passed cleanly.
- **First actual exception** in the failing step was located (Phase B below),
  ending the previous session's unresolved speculation about signin rate
  limiting, fixtures, or test orchestration.

## 1. Functional Coverage by Module

| Module | Routes | E2E Tests | Status |
|--------|--------|-----------|--------|
| **State Builder (G01)** | 16 routes under `/api/v1/state-builder/` | 18 tests (T1 journey) | ✅ PASS |
| **State Observatory (G02)** | 13 routes under `/api/v1/state-observatory/` | 19 tests (T2 journey) | ✅ PASS |
| **Targeted Reform (G03-02)** | Routes under `/api/v1/reform/` | 45 tests | ✅ PASS |
| **Multi-Institution Coordination (G03-06)** | Coordination + shared snapshots + trust boundary | 19 tests | ✅ PASS |
| **Strategic Continuity (G04-D3)** | 10 routes under `/api/v1/continuity/` | 40 tests (8-step + supersession + handover acceptance) | ✅ PASS |
| **Intelligence (G04-D4)** | 1 route under `/api/v1/intelligence/` | 22 tests (cross-module + structured analysis + provider failure) | ✅ PASS |
| **Hard Validation (G04-D5)** | No new routes — tests only | 23 tests (full system integration, 5 sections) | ✅ PASS |

## 2. Phase B — CI Failure Root Cause (Confirmed)

The previous session observed that all 23 D05 tests failed "apparently due
to an exception in test initialization (`beforeAll`)" but the precise
exception was not identified. This session located it precisely:

### 2.1 The actual CI log evidence

From the downloaded GitHub Actions job log (job `119879395864`):

```
2026-10-22T14:35:48.1033203Z D5 hard validation server PID: 12807
2026-10-22T14:35:48.3828571Z ▲ Next.js 16.4.2 (Turbopack)
2026-10-22T14:35:48.3835166Z ✓ Ready in 219ms
2026-10-22T14:35:50.4119767Z  GET /api/v1/meta 200 in 290ms
2026-10-22T14:35:50.4124049Z D5 server ready after 2 attempts
2026-10-22T14:35:53.5371442Z prisma:error
Invalid `db.auditLog.create()` invocation in
/home/runner/work/The-Balance/The-Balance/.next/dev/server/chunks/...js:114:145
ConnectorError(ConnectorError { ... kind: QueryError(PostgresError {
  code: "42501",
  message: "new row violates row-level security policy for table \"audit_log\"",
  ...
}) })
2026-10-22T14:35:53.5399303Z  POST /api/v1/auth/signin 200 in 413ms
... 3 signins all return 200 ...
2026-10-22T14:35:55.6759183Z  GET /api/v1/continuity/strategies/.../history 401 in 679ms
... all subsequent requests return 401 ...
```

### 2.2 The confirmed root cause

**Bug in `tests/e2e/g04-delivery-05-hard-validation.e2e.test.ts` line 75:**
The `fetchWithCookies` helper reassigned its `cookies` parameter to a
**new array** returned by `Array.prototype.filter`:

```ts
cookies = cookies.filter((c) => !c.startsWith(`${name}=`));
cookies.push(cookiePart);
```

Reassignment only rebinds the LOCAL parameter; the caller's
`analystCookies` / `adminCookies` / `tenantBCookies` arrays are never
mutated. After `signIn(...)` returned, the test's cookie arrays were
still empty, so every subsequent request went out with no `Cookie:`
header and the server rejected them with HTTP 401 — *not* because
signin itself failed (it returned 200 and the audit-log RLS error was
tolerated), but because the captured session cookies never reached the
caller.

All other passing E2E helpers (g01, g02, g03-02, g03-06,
g04-continuity, g04-d4-intelligence) use the correct in-place pattern
(`splice(idx, 1)` + `push`).

### 2.3 Why the previous session was misled

The previous session's hypothesis list (signin rate limiting, fixtures,
test orchestration) was based on the visible symptom (all 18 tests
failed in CI) rather than the actual error. Reading the raw CI log
reveals:

- The signin rate limiter was NOT the cause: 3 signins returned 200,
  well below the 10/min limit.
- Fixtures were correctly seeded (`ensureHardValidationFixtures`
  succeeded).
- The `beforeAll` itself completed without throwing — the failure was
  in the per-test requests returning 401 because cookies were never
  captured.

### 2.4 A second, unrelated defect surfaced during local verification

While verifying the cookie fix locally, a TOCTOU (time-of-check /
time-of-use) race surfaced in `src/lib/strategy-service.ts::advanceDecision`:

- The original code read `decision.status`, validated the transition, and
  then issued `tx.decision.update({ where: { id }, data: { status } })`
  without holding any row lock.
- Two concurrent `advance(reviewed)` calls each saw status = "proposed",
  each passed validation, and each UPDATE succeeded — meaning both
  requests returned 200, even though the test contract requires exactly
  one to succeed and the other to fail with 400/409.
- Fix applied: a fail-closed `SELECT ... FOR UPDATE` (matching the
  existing `lockProposalRow` pattern in `src/lib/reform/lock-helper.ts`)
  is now acquired before reading the status, so the second concurrent
  call blocks until the first commits, then re-reads the now-`reviewed`
  row and correctly rejects the `reviewed → reviewed` transition.

## 3. Phase C — Fix Applied

Two minimal, targeted fixes inside PR #10. No production security
control was weakened; no test assertion was relaxed.

| File | Change | Reason |
|------|--------|--------|
| `tests/e2e/g04-delivery-05-hard-validation.e2e.test.ts` | `fetchWithCookies` now mutates the caller's array in place (`splice` + `push`) instead of rebinding the local parameter via `filter`. Inline comment added explaining why. | Cookie propagation — fixes the actual CI failure. |
| `src/lib/strategy-service.ts` | `advanceDecision` now acquires `SELECT id, status FROM decisions WHERE ... FOR UPDATE` before validating the transition. | Concurrency correctness — required for D5-2 test to pass. |

No changes to:
- Authentication flow (signin still uses `balance_auth` least-privilege role)
- RLS policies (no policy relaxation)
- Rate limiting (10/min signin preserved, in-memory counter scoped per
  Next.js process — same as before)
- Audit log writer (still best-effort with `AUDIT_WRITE_FAILED` log;
  see §7.1 below for the residual audit-log RLS observation)
- Production build / migrations / seed

## 4. Phase D — Verified Test Results (Local)

All tests were executed locally against real PostgreSQL 16.4 + pgvector
0.7.4 on port 5433 (locally compiled; CI runs on port 5432 via the
`pgvector/pgvector:pg16` Docker image — identical Prisma schema and
migrations). Each E2E suite was run with a fresh Next.js process and a
re-seed, matching the CI workflow's isolation pattern.

### 4.1 Lint + Typecheck + Build

| Step | Result |
|------|--------|
| `bun run lint` | ✅ PASS (3 pre-existing warnings about `<a>` vs `<Link>` in legacy G00 pages; no errors) |
| `bun run typecheck` (`tsc --noEmit`) | ✅ PASS |
| `bun run build` (production) | ✅ PASS |

### 4.2 Unit + Integration (CI-equivalent battery)

| Suite | Files | Tests | Result |
|-------|-------|-------|--------|
| Unit + Integration (`SKIP_E2E_SERVER=1`, `RUN_INTEGRATION_TESTS=1`) | 90 | 1283 | ✅ 1083 passed, 200 skipped, **0 failed** |

(The 200 skipped tests are E2E-gated; they are exercised separately
under `RUN_E2E_HTTP_TESTS=1` — see §4.4.)

### 4.3 G03-01 SQL acceptance suite

| Suite | Result |
|-------|--------|
| `scripts/g03-security-validation/g03_01_final_acceptance_rev2.sql` (25 SQL assertions) | ✅ 25/25 PASS — RLS+FORCE on all 12 tables, append-only enforcement, 6 split SA-03 sub-tests, FUNCTION privileges, migration finished_at, seed idempotency |

### 4.4 E2E HTTP suites (each isolated with fresh server + re-seed)

| Suite (CI step) | Files | Tests | Result |
|-----------------|-------|-------|--------|
| G01 + G03-02 + G03-06 (#23) | 3 | 82 | ✅ 82/82 PASS (Duration: 119.5s) |
| G02 State Observatory (#24) | 1 | 19 | ✅ 19/19 PASS |
| G04 Strategic Continuity (#25) | 1 | 40 | ✅ 40/40 PASS |
| G04 Delivery 04 Intelligence (#26) | 1 | 22 | ✅ 22/22 PASS |
| **G04 Delivery 05 Hard Validation (#28)** | **1** | **23** | ✅ **23/23 PASS** (Duration: 11.7s) |
| **TOTAL E2E** | **7** | **186** | **186/186 PASS** |

### 4.5 D5 Hard Validation breakdown (23 tests, 5 sections)

| Section | Tests | Result |
|---------|-------|--------|
| D5-1: Complete Government Workflow (cross-module, 8 steps) | 8 | ✅ 8/8 PASS |
| D5-2: Concurrency & Consistency | 2 | ✅ 2/2 PASS (concurrent dossier unique IDs + concurrent advance race) |
| D5-3: Failure Injection & Recovery | 3 | ✅ 3/3 PASS (Zod 400, invalid transition 400, immutability trigger) |
| D5-4: Authorization & Tenant Isolation | 5 | ✅ 5/5 PASS (cross-tenant alerts/dossiers/decisions blocked) |
| D5-5: Evidence & Scientific Integrity | 5 | ✅ 5/5 PASS (model_inference blocks, descriptive honesty labels, simulated flag, audit log recorded) |

### 4.6 Cross-module workflow coverage

The D5-1 section exercises **all 6 functional groups** in a single
connected 8-step scenario:

1. State Builder (approved strategy exists)
2. State Observatory (indicator + observation + variance + alert)
3. Intelligence (AI-assisted analysis with honesty labels)
4. Strategic Continuity (decision lifecycle: proposed → reviewed → approved)
5. Strategic Continuity (handover dossier generated + retrieved)
6. State Reform (proposals + actions inspectable)

All 8 cross-module steps pass. The system is verified to function as a
single coherent government intelligence platform, not just as a
collection of independent modules.

### 4.7 Real LLM provider verification

The ZAI provider integration (`z-ai-web-dev-sdk`, GLM-4-Plus model)
was previously verified in Delivery 04 with `RUN_REAL_LLM_TESTS=1` and
real credentials. CI runs the real-provider step with
`continue-on-error: true` because no `.z-ai-config` is provisioned in
CI. The stub provider path (used by all D5 tests) is verified to return
correctly-labeled `simulated: true` outputs with descriptive (not
causal) honesty labels.

## 5. Load and Stability Findings

No dedicated load-testing tool (k6, autocannon) was added in this
delivery; this remains a documented limitation (see §7.2). The
existing CI pipeline exercises the system with:

- 6 sequential E2E steps (each spawning a fresh Next.js dev server)
- PostgreSQL 16 + pgvector on a real GitHub Actions runner
- Each E2E step runs 15–82 tests against real HTTP + real PostgreSQL
- D5-2 explicitly tests concurrent dossier generation (3 simultaneous
  POSTs) and concurrent decision advance (2 simultaneous POSTs) — both
  produce consistent state

Observed characteristics during local verification:

- Each E2E step completes in 9–12 seconds (server boot + tests)
- No saturation observed at the current test concurrency
- The 10/min signin rate limit is preserved (not weakened) — each E2E
  step uses a fresh server process so the in-memory counter resets
- A known timing flake exists when running `g01 + g03-02 + g03-06`
  in a single vitest process: if cumulative signins within 60s exceed
  10, the next signin receives 429. This is documented in the CI
  workflow comments and the g01 test setup (it intentionally waits
  2s before signing in to avoid this). The flake is NOT introduced by
  D05; it is pre-existing. Re-running with a fresh server + re-seed
  (the CI workflow's standard pattern) resolves it consistently.

## 6. Failure/Recovery Verification

| Scenario | Test | Result |
|----------|------|--------|
| Provider TIMEOUT | `tests/unit/intelligence/provider-failure.test.ts` test 1 | ✅ Returns `missing_information` block with "TIMEOUT" |
| Provider AUTH_FAILED | `tests/unit/intelligence/provider-failure.test.ts` test 2 | ✅ Returns `missing_information` block with "AUTH_FAILED" |
| Invalid state transition (implemented → reviewed) | D5-3 test 2 | ✅ Returns 400 |
| Dossier content mutation (direct DB UPDATE) | D5-3 test 3 | ✅ DB trigger blocks UPDATE |
| Missing target for intelligence analysis | D5-3 test 1 | ✅ Returns 400 (Zod validation) |
| Concurrent dossier generation (3 simultaneous POSTs) | D5-2 test 1 | ✅ 3 unique IDs, no corruption |
| Concurrent decision advance race | D5-2 test 2 | ✅ One 200 + one 400/409, state consistent |
| Fresh install + recovery | CI recovery workflow | ✅ PASS — PostgreSQL + migrations + seed + restart (verified locally with compiled-from-source PG16) |

## 7. Security and Cross-Tenant Results

### 7.1 Audit-log RLS policy — pre-existing observed behavior (NOT a D5 blocker)

During local verification, the audit-log writer (`src/lib/audit.ts`)
emits the log line `AUDIT_WRITE_FAILED — primary flow continues;
investigate via logs.` whenever it cannot insert into `audit_log`. The
underlying error is:

```
PostgresError code: "42501", message: "new row violates row-level
security policy for table \"audit_log\""
```

This occurs for actions taken BEFORE a tenant context is established
(e.g., the `auth.signin` action itself, before the session exists; the
`health.check` action). The `audit_log` RLS policy requires
`app.tenant_id` to be set, which is impossible before authentication
completes. The audit module's design tolerates this — it logs and
continues — and the primary flow is unaffected. This is a pre-existing
condition observed in CI before D05 was attempted; it is **not** a
regression introduced by D05 and **not** a blocker for backend
readiness. However, it is a real production concern: audit records for
unauthenticated actions are not persisted. This is documented here for
transparency; remediation requires a dedicated security-policy follow-up
(allowing `balance_app` to INSERT audit rows with `tenantId IS NULL`),
which is out of scope for D05's "no new feature expansion" rule.

### 7.2 Tenant isolation tests

| Test | Result |
|------|--------|
| Tenant B GET /alerts → empty list | ✅ No leak |
| Tenant B GET /alerts/[id from A] → 404 | ✅ No existence leak |
| Tenant B GET /handover/dossiers/[id from A] → 404 | ✅ No leak |
| Tenant B POST /intelligence/analysis with A's alertId → 400 | ✅ Rejected |
| Tenant B GET /decisions → empty list | ✅ No leak |
| Dossier content immutability (DB trigger) | ✅ Published dossiers cannot be mutated via direct DB UPDATE |
| G03-01 SQL acceptance (25 assertions) | ✅ RLS+FORCE on all 12 tables; append-only; FUNCTION privileges; SA-03 split into 6 sub-tests |

## 8. Real vs Simulated Intelligence Coverage

| Aspect | Stub (CI / D5 tests) | Real ZAI (Delivery 04 verification) |
|--------|----------------------|--------------------------------------|
| Provider name | "stub" | "zai" |
| Model | "stub-v0" | "glm-4-plus" |
| Simulated flag | `true` (explicitly labeled) | `false` |
| JSON output | Deterministic canned | Real LLM reasoning |
| Strict JSON validation | N/A (canned) | ✅ PASS — 8 blocks with valid kinds |
| Structured analysis | Canned response | ✅ PASS — summary + blocks + `model_inference` |
| Provider failure | N/A | ✅ PASS — TIMEOUT + AUTH_FAILED tested |
| Live run | N/A | ✅ Documented + reproducible locally |

## 9. Known Limitations, Risks, and Unresolved Defects

1. **Audit-log RLS for unauthenticated actions** (see §7.1). Pre-existing;
   tolerated by design; out-of-scope for D05. Documented for a future
   security-policy follow-up. NOT a backend-readiness blocker.

2. **Load testing not implemented**. The system's behavior under sustained
   high load (>100 req/s) is unmeasured. A dedicated load-testing phase
   is recommended before production deployment.

3. **Real ZAI provider on CI**. The SDK requires credentials not
   provisioned in CI. The real-provider step runs with
   `continue-on-error: true`; live verification is documented and
   reproducible locally.

4. **Embeddings**. The ZAI SDK does not expose a public embeddings API.
   RAG-based evidence search would require a separate embedding
   provider. `LLMUnsupportedError` is thrown honestly when embeddings
   are requested.

5. **10/min signin rate limit**. Preserved in production code. Each CI
   E2E step uses a fresh server process to reset the in-memory counter.
   Known timing flake when running `g01 + g03-02 + g03-06` in a single
   vitest process — resolved by following the CI workflow's standard
   fresh-server + re-seed pattern. Production deployments with many
   concurrent users may need a distributed rate limiter.

6. **Playwright browser tests**. The CI runs Playwright tests against
   the existing G00 scaffold UI pages (capabilities, evidence,
   strategies, tasks). These pages are minimal. The Playwright tests
   verify the server renders but do not test the G04 functional UI
   (which does not exist yet — deferred to the UI design phase per
   owner policy).

7. **Audit log entries for `intelligence.analysis.requested` are
   recorded** in D5-5 test 5 — this confirms audit-log writes DO
   succeed inside authenticated tenant-scoped transactions. The
   pre-existing audit-log RLS issue (§7.1) only affects unauthenticated
   actions (signin, health-check), not authenticated ones.

## 10. References

| Reference | Value |
|-----------|-------|
| Main HEAD (post-PR-#9) | `49fb334fd36d2a63ecb79760a2a8103d158f517c` |
| PR #10 branch | `g04-delivery-05-hard-validation` |
| Previous D05 head (failing) | `8ab6d21f84927393b1893510ad867e33e118172f` |
| D05 fix SHA | `<pending push — will be filled after PR update>` |
| CI run (failing) | https://github.com/mayakilzy/The-Balance/actions/runs/39794829672 |
| CI job (failing) | id `119879395864`, step #28 |
| Recovery workflow | `.github/workflows/fresh-install-recovery.yml` |

## 11. Recommendation

### Backend readiness

**BACKEND_READY_FOR_UI = YES** (subject to owner approval per the binding
development policy).

The backend has been demonstrated to function correctly under demanding
real conditions:

- ✅ 186/186 E2E HTTP tests pass (across all 6 functional groups)
- ✅ 1083/1083 unit + integration tests pass (excluding E2E-gated skips)
- ✅ 25/25 SQL acceptance assertions pass (RLS, append-only, FUNCTION privileges)
- ✅ D5-1 exercises the full cross-module government workflow end-to-end
- ✅ D5-2 proves concurrent operations produce consistent state (incl. the
  newly-fixed `advanceDecision` TOCTOU race)
- ✅ D5-3 proves failure injection is rejected (no silent acceptance of
  wrong state, no silent skip of validation, DB trigger blocks mutation)
- ✅ D5-4 proves cross-tenant RLS isolation (5 independent probes)
- ✅ D5-5 proves evidence + scientific integrity (honesty labels,
  simulated flag, audit log entries recorded for intelligence requests)
- ✅ Real LLM provider plumbing verified in Delivery 04
- ✅ Production build succeeds

### Conditions (transparency — not blockers)

1. The audit-log RLS issue for unauthenticated actions (§7.1) is a
   documented production concern, not a D05 blocker. A dedicated
   security-policy follow-up is recommended before public-sector
   deployment.
2. Load testing should be performed before production deployment.
3. Real ZAI provider credentials should be configured via CI secrets
   for automated live verification (currently `continue-on-error`).
4. The 10/min signin rate limit should be reviewed for production
   concurrency requirements.
5. Embeddings provider should be added if RAG-based evidence search is
   needed.

### Owner-approval gate

Per the binding development policy:

> No UI/UX design until all required backend functionality is complete,
> integrated and successfully validated.

With D05 now passing 23/23 and full regression green, **the backend
qualifies for the owner-approval gate to begin UI/UX design**. The
owner's explicit authorization is required before that phase begins.
No merge of PR #10, no stable tag creation, and no UI/UX work should
proceed without that authorization.
