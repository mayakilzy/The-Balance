# GROUP 01 — Master Context Handoff

**Document type:** Continuity / Knowledge Transfer
**Purpose:** Enable a new development chat to resume work on THE BALANCE project without re-discovering context.
**Date:** 2026-10-17
**Approved baseline SHA:** `dcbb8961dd588bb9e66a9076bc4e62625482a56f` (GROUP 00 final)
**Latest commit:** `476f6db` (G01 Mission Pack + G00 doc corrections)

---

## A. Project Identity and Vision

### Project Name
**THE BALANCE — الميزان**
Repository: `mayakilzy/The-Balance` (public)
Documentation repo: `mayakilzy/repo-info/The-Balance-Doc` (public)

### Core Purpose
The Balance is an **evidence-based state intelligence platform** built for legitimate, authorized governments. It helps governments:
1. Understand the actual state of the country (evidence-backed baseline)
2. Design interconnected reform strategies (multi-sector alternatives)
3. Accompany implementation (tracking + measurement)
4. Measure results independently (observatory)
5. Protect the state's strategic memory across changes of government (continuity)

### Target Audience and Usage
- **Primary user:** Government — cabinet offices, strategy units, ministries, independent evaluation bodies
- **Secondary users:** Researchers and the public (via permissioned read-only views)
- **NOT for:** Surveillance, political profiling, automated punishment, or replacing sovereign decision-making

### Engineering Philosophy
**Small in Code, Large in Capability.**
- Minimal codebase, maximal contractual capability
- No arbitrary development limits (time, tokens) in experimental phases
- No unnecessary frameworks or engines
- Reuse existing components rather than reinventing
- Every claim of capability must be backed by operational evidence

### Adopted Principles (Scientific, Governance, Human Sovereignty)
Per Master Blueprint §2:
1. **Evidence before conclusion** — every claim links to source, date, method
2. **Unknown is a valid result** — system says "unknown" rather than fabricating
3. **Multi-source & independence** — duplicate/cited sources are NOT independent
4. **Counter-evidence** — mandatory search for opposing evidence on high-impact claims
5. **Separating levels** — claim vs observation vs interpretation vs correlation vs causation vs recommendation
6. **State Vector** — separate dimensions (status, trend, quality, equity, execution); no single magic number
7. **Uncertainty calibration** — no fake confidence percentages; documented ranges where appropriate
8. **Temporal validity** — reality date vs discovery date vs correction versions
9. **Transferability** — no automatic "Singapore model" copying; compare conditions and institutions
10. **Human sovereignty** — no law, budget, spending, or program cancellation by AI agents
11. **Continuity without lock-in** — preserve knowledge without forcing old policy on new governments
12. **Reproducibility** — source, model, tool version, input data, recomputable output
13. **Security & privacy** — least privilege, tenant isolation, delegation, audit, no sensitive assumption leakage

### Global Scope
The platform is **global** (Universal Core + Country Pack). Syria is the first deep case study, NOT the product definition. Any country pack can be added. The platform does not impose a single governance model.

---

## B. Authoritative References

### Reference Priority (highest to lowest)
When references conflict, this order governs:
1. **Explicit founder decisions** in the current development dialogue
2. **This Master Context Handoff** (consolidates current state)
3. **GROUP 00 acceptance documents** (`docs/mission-reports/G00/`)
4. **ADRs** (`docs/adr/ADR-0001` through `ADR-0012`)
5. **Master Blueprint v2.0** (`The-Balance-Doc/01_The_Balance_Master_Blueprint_v2.0.md`)
6. **Six-Group Roadmap v1.0** (`The-Balance-Doc/02_The_Balance_Six_Group_Development_Roadmap_v1.0.md`)
7. **Reconciliation Matrix v0.3** (historical reconciliation)

**No new architectural decisions may be created without explicit founder approval.**

### Key Documents and Paths

#### In the repository (`mayakilzy/The-Balance`)
| Document | Path | Purpose |
|----------|------|---------|
| README | `README.md` | Project overview + quick start |
| RUNBOOK | `docs/RUNBOOK.md` | Install + operate + recover procedures |
| ADRs (12) | `docs/adr/ADR-0001-*.md` through `ADR-0012-*.md` | Architectural decision records |
| G00 Final Review | `docs/mission-reports/G00/GROUP_00_FINAL_REVIEW.md` | Evidence-based final review |
| G00 Acceptance Matrix | `docs/mission-reports/G00/GROUP_00_ACCEPTANCE_MATRIX.md` | Mission-by-mission acceptance |
| G00 Known Limitations | `docs/mission-reports/G00/GROUP_00_KNOWN_LIMITATIONS.md` | 14 documented limitations |
| G01 Readiness Handoff | `docs/mission-reports/G00/GROUP_01_READINESS_HANDOFF.md` | What G01 inherits + must build |
| G01 Mission Pack | `docs/mission-reports/G01/GROUP_01_MISSION_PACK.md` | 11-mission plan for State Builder |
| G00 Mission Report 00-01 | `docs/mission-reports/G00/00-01_REPORT.md` | Detailed 00-01 report |
| BASELINE | `BASELINE.md` | Repository baseline documentation |

#### External (in `mayakilzy/repo-info/The-Balance-Doc`)
| Document | Purpose |
|----------|---------|
| `01_The_Balance_Master_Blueprint_v2.0.md` | Master Blueprint (vision, principles, engines, tests) |
| `02_The_Balance_Six_Group_Development_Roadmap_v1.0.md` | Six-group roadmap + mission template |
| `Balance_Reconciliation_Matrix_v0.3.md` | Historical reconciliation of sources |

#### Related Repositories (READ-ONLY reference)
- `mayakilzy/swarm-engine` — candidate technical reference (MIT, audited, 0% code reuse per ADR-0011)
- `mayakilzy/AgentCraft-Toolkit` — NOT referenced in official docs

### ADRs Summary (12 total, all approved in G00)
| ADR | Title | Status |
|-----|-------|--------|
| ADR-0001 | Stack Selection (Next.js 16 + TS 5 + PG 16 + pgvector + Prisma 6 + Auth.js v5 + Zod 4 + pino + Vitest) | Approved |
| ADR-0002 | LLM Provider Abstraction (no exclusive binding; StubProvider default) | Approved |
| ADR-0003 | PostgreSQL RLS for tenant isolation (not Prisma-level) | Approved |
| ADR-0004 | Country/Tenant Separation (PUBLIC vs PRIVATE scope) | Approved |
| ADR-0005 | Three DB roles (balance_admin, balance_app, balance_auth) | Approved |
| ADR-0006 | Hierarchy Integrity (cycle detection, same-country parent) | Approved |
| ADR-0007 | Auth.js v5 (CredentialsProvider + bcrypt + JWT) | Approved |
| ADR-0008 | RBAC/ABAC (default-deny, current-role authorization) | Approved |
| ADR-0009 | Evidence Fabric (sources PUBLIC + evidence PRIVATE + pgvector 384-dim) | Approved |
| ADR-0010 | Strategy Contracts (immutable approved versions, evidence snapshots) | Approved |
| ADR-0011 | Capability Registry (ExpertAdapter contract, no silent fallback, 0% swarm-engine reuse) | Approved |
| ADR-0012 | Security Hardening (CSP, rate limiting, error/log sanitization, metrics) | Approved |

---

## C. GROUP 00 Final State

### Mission Summary (00-00 through 00-11)

| Mission | Title | Status | Key Deliverable |
|---------|-------|--------|-----------------|
| 00-00 | Reuse & Dependency Audit | PASS | Audit report (0% swarm-engine reuse) |
| 00-01 | Runnable Platform Skeleton | PASS | Next.js + Prisma + PG + CI |
| 00-02 | Tenant/Country Ontology + RLS | PASS | 20 tables, RLS, hierarchy integrity |
| 00-03 | Identity, Permissions, Tenant Isolation | PASS | Auth.js v5, 3 DB roles, RBAC/ABAC |
| 00-04 | Evidence + Scientific Source Fabric | PASS | Evidence + pgvector search |
| 00-05 | Strategy + Version + Decision Contracts | PASS | Immutable versions, append-only events |
| 00-06 | Durable Task Runtime + Balance Master Stub | PASS | Fencing + lease + idempotency |
| 00-07 | Capability Registry + ExpertAdapter | PASS | Registry + StubAdapter + no silent fallback |
| 00-08 | API + UI End-to-End Foundation | PASS | 6 pages + Playwright E2E |
| 00-09 | Security Hardening, Audit, Observability | PASS | CSP, rate limiting, log sanitization |
| 00-10 | Fresh Install, Integration CI, Recovery | PASS | Fresh install + backup/restore + restart |
| 00-11 | GROUP 00 Final Review | PASS | 4 deliverable docs + G01 mission pack |

### What Was Built (Foundation-validated, NOT production-hardened)

#### Database (16 migrations, 22 Prisma models)
- **8 PUBLIC tables:** countries, state_hierarchy, institutions, role_references, source_registry, public_knowledge, sources, capabilities
- **14 PRIVATE tables:** tenants, audit_log, users, memberships, evidence, evidence_embeddings, strategies, strategy_versions, decisions, decision_events, events, tasks, task_events, capability_invocations
- **RLS:** ENABLE + FORCE on all 14 PRIVATE tables
- **Append-only:** audit_log, decision_events, events, task_events (REVOKE UPDATE/DELETE from balance_app)
- **Immutability:** Approved strategy_versions frozen via trigger
- **pgvector:** 384-dim embeddings for evidence semantic search

#### Authentication & Authorization
- Auth.js v5 with CredentialsProvider (bcrypt cost 12)
- JWT carries: userId, tenantId, roleCode, membershipStatus
- `withAuthenticatedTenant`: verifies session + fetches CURRENT membership from DB
- `requirePermissionWithCurrentRole`: checks CURRENT DB role (not stale JWT)
- 4 roles: admin, analyst, reviewer, observer
- Tenant switching via `unstable_update`

#### Three DB Roles (ADR-0005)
- `balance_admin` — BYPASSRLS, used for migrations + seed only
- `balance_app` — RLS-enforced, used by application at runtime
- `balance_auth` — read-only, column-level grants for auth bootstrap

#### Evidence Fabric
- `createEvidence()` — tenant-scoped evidence with source linkage
- `searchEvidence()` — pgvector cosine similarity search
- `verifyEvidence()` — verification status tracking
- Evidence fields: source, claim_text, support_stance, verification_status, independence_group, quality_notes

#### Strategy Contracts
- `createStrategy()` → `createStrategyVersion()` → `approveStrategyVersion()` (freezes version)
- `createDecision()` — snapshots evidence at decision time (point-in-time integrity)
- Status transitions: draft → proposed → approved → active → amended → retired
- Approved versions immutable; changes require new version with `supersedes_version`

#### Durable Task Runtime
- `createTask()` with idempotency (UNIQUE partial index on idempotencyKey)
- `claimTask()` — SELECT FOR UPDATE SKIP LOCKED + claimGeneration increment
- `startTask()`, `updateProgress()`, `completeTask()`, `failTask()` — all verify fencing token
- `reclaimStaleTasks()` — atomic CTE with FOR UPDATE for expired leases
- Default lease: 60 seconds

#### Balance Master Stub
- `executeNextTaskWithProvider(session, provider)` — claim → start → progress → complete/fail
- Uses LLMProvider interface (StubProvider by default)

#### Capability Registry
- `registerCapability()` — PUBLIC table, admin-only writes
- `invokeCapability()` — tenant-scoped invocations with audit trail
- ExpertAdapter contract: `execute(input) → { output, provider, simulated }`
- StubAdapter: deterministic, SIMULATED, `readiness: "stub"`
- **No silent fallback** — missing adapter FAILS, not stub fallback

#### Security & Observability
- **Middleware:** CSP + 7 security headers, rate limiting (4 routes), request IDs
- **Trusted IP:** `extractClientIp()` gated on `TRUSTED_PROXY` env var (default false)
- **Error sanitization:** `buildApiErrorResponse()` — no `detail` field for unexpected errors
- **Log sanitization:** `sanitizeForLog()` strips 9 secret patterns (PG URLs, Bearer, JWT, API keys, etc.)
- **Metrics:** in-process counters (requestCount, errorCount, failedTasks, rateLimitedRequests)
- **Audit log:** `writeAudit()` with SHA-256 salted ipHash (never raw IP)

#### UI (6 pages, Arabic RTL, responsive)
- `/login` — Auth.js form (demo credentials conditional on SHOW_DEMO_CREDENTIALS)
- `/` — Home: tenant context + system health + SIMULATED notice
- `/tasks` — List + create + detail + events
- `/evidence` — List with verification status
- `/capabilities` — List with readiness classification
- `/strategies` — Strategy list

#### API (16 routes)
- `/api/health` — liveness + readiness
- `/api/v1/meta` — build metadata + feature flags
- `/api/v1/countries` — PUBLIC read-only
- `/api/v1/auth/signin`, `/signout`, `/me`, `/switch-tenant`
- `/api/v1/evidence` (CRUD), `/search`, `/[id]/verify`
- `/api/v1/tasks` (CRUD), `/[id]` (detail + execute)
- `/api/v1/capabilities` (list), `/[code]/invoke`
- `/api/v1/_metrics` — operational metrics (admin/reviewer/analyst only)

#### Testing (237 tests, 18 files)
- **7 unit test files** (82 tests): health, LLM provider, meta, error-sanitizer, log-sanitization, metrics, trusted-ip
- **10 integration test files** (145 tests): RLS isolation, auth-e2e, evidence, strategy, task, capability, tenant-context, role-passwords, security, recovery
- **1 e2e test file** (10 tests): http-auth (cookie persistence)
- **1 Playwright browser test file** (4 tests): full journey + unauth redirect + mobile screenshots
- Integration tests require PostgreSQL + `RUN_INTEGRATION_TESTS=1`

#### CI (2 workflows, both green)
- **Primary CI** (`.github/workflows/ci.yml`): 19 steps — checkout → Bun → install → Prisma → Postgres → roles → migrations → seed → privilege verify → lint → typecheck → test → build → Playwright → screenshots
- **Fresh Install + Recovery** (`.github/workflows/fresh-install-recovery.yml`): 7 phases — reset DB → fresh install verify → recovery tests → app restart → backup/restore drill → non-destructive verify → full test suite on restored DB → production build

### What is Stub/Mock (Honestly Labeled)
| Component | Status | Honesty Mechanism |
|-----------|--------|-------------------|
| LLM Provider | StubProvider (SIMULATED) | `simulated: true` in API + UI notice |
| Balance Master | Uses StubProvider | Same |
| StubAdapter (capability) | Deterministic simulated | `readiness: "stub"` in DB + UI |
| Metrics | In-process (single-instance) | Documented limitation |
| Rate limiting | In-memory (single-instance) | Documented limitation |

### What is NOT Implemented (Deferred)
- Real LLM providers (zai, openai, anthropic) — interface ready, no adapter
- Real ExpertAdapters (beyond stub) — contract ready, no implementations
- Distributed metrics (Prometheus) — pre-scale
- Distributed rate limiting (Redis) — pre-scale
- WAL archiving / PITR — production hardening
- External secrets management (Vault/SOPS) — production hardening
- Distributed tracing (OpenTelemetry) — post-G00
- Multi-region deployment — post-G00
- Automated backup schedule — production hardening

### Final CI Evidence
- **CI #73 (primary):** PASS — https://github.com/mayakilzy/The-Balance/actions/runs/38985956186
- **Fresh Install #11 (recovery):** PASS — https://github.com/mayakilzy/The-Balance/actions/runs/38985956161
- **Test count:** 237 passed | 10 skipped (247 total) across 18 test files

### Approved Baseline SHA
`dcbb8961dd588bb9e66a9076bc4e62625482a56f`

---

## D. Engineering Decisions That Cannot Be Reopened Automatically

These decisions are binding. Reopening any of them requires explicit founder approval.

1. **Do not rebuild foundation systems that passed.** Auth, RLS, Evidence Fabric, Strategy Contracts, Task Runtime, Capability Registry are foundation-validated. G01 builds ON them, not replaces them.

2. **Reuse existing components** rather than reinventing. The `LLMProvider` interface, `ExpertAdapter` contract, `withAuthenticatedTenant`, `writeAudit`, `buildApiErrorResponse`, `sanitizeForLog`, Task Runtime fencing — all are to be used as-is.

3. **Maintain RLS + RBAC + audit logs.** All new G01 tables must be PRIVATE with ENABLE+FORCE RLS. All privileged actions must be logged in the append-only audit_log.

4. **Preserve LLMProvider + ExpertAdapter contracts.** G01 uses the `LLMProvider` interface (StubProvider default). A real provider is a separate, explicitly-labeled step — never silently swapped.

5. **Never present simulated results as real.** Every LLM-dependent response must carry `simulated: true` when using StubProvider. The UI must display "SIMULATED". No mock output may be claimed as live evidence.

6. **No AI authority over sovereign decisions.** No law, budget, spending, program cancellation, or strategy approval by AI agents. Human approval is required for all `approved`/`active` status transitions. `strategy:compose` (draft) and `strategy:approve` (finalize) are separate permissions (separation of duties).

7. **No operational complexity without necessity.** No Kubernetes, no microservices, no new swarm engine, no separate codebases. Single repository, modular monolith.

8. **No arbitrary limits on execution time or token consumption** in experimental phases. The platform should not impose artificial constraints that block legitimate operations.

9. **Operational evidence required for PASS.** No mission is PASS just because tests pass. End-to-end use case must work, simulation/providers must be explicitly reported, user authorization must be reviewed, SHA + re-execution evidence must be recorded.

10. **Progressive Mission Authoring.** Detailed tasks for the next group are written ONLY after the previous group's acceptance report is approved. No pre-generating tasks for G02–G05.

11. **0% swarm-engine code reuse.** Per ADR-0011, swarm-engine is a pattern reference only. No code import.

12. **"unknown" is a valid result.** The system must say "unknown" when data is insufficient. It must never fabricate values or confidence.

13. **Counter-evidence is mandatory.** High-impact claims must include opposing evidence. No silent selection of one narrative.

14. **No fake precision.** Budget estimates are ranges with assumptions. Confidence is descriptive ("high/medium/low" + rationale), never a fake percentage.

---

## E. Current State of GROUP 01

### G01 Goals (State Builder)
Per Roadmap §4: A country with a baseline and goals can obtain multi-sector draft strategies that are reviewable and approvable.

### G01 Components (from Roadmap §4)
1. State Baseline
2. Gap Analysis
3. National Strategy Composer
4. Institutional Design
5. Portfolio & Dependency Graph
6. Budget/Financing Estimates
7. Implementation Roadmap
8. Scenario Comparisons
9. Development Advisor v1
10. Human Approval

### G01 Depends on G00 Outputs
- Evidence Fabric (for baseline + strategy evidence)
- Strategy Contracts (for version + approval lifecycle)
- Durable Task Runtime (for long-running composition tasks)
- Capability Registry (for Development Advisor registration)
- Auth + RBAC (for human approval gate)
- Audit log (for approval provenance)

### T1 Acceptance Test
The gate for G01 acceptance. Scenario:
Fictional or properly-sourced Country Pack → multiple strategy alternatives → evidence and uncertainty → dependencies and conditional costs → authorized human approval → active versioned Strategy.

**Without authorization, the result remains a draft.** No AI can approve on behalf of the authorized human party.

Full T1 details: 13 positive steps + 5 negative tests in `docs/mission-reports/G01/GROUP_01_MISSION_PACK.md` §2.

### What G01 Must Build
- 8 new Prisma models (Objective, Program, Project, BudgetLine, Dependency, RiskRegister, Assumption, CountryPackConfig)
- 7 new ADRs (ADR-0013 through ADR-0019)
- 9 new service modules in `src/lib/state-builder/`
- ~116 new tests
- 1 Playwright E2E for T1
- New permissions: `baseline:read/compute`, `gap:read`, `strategy:compose/approve`, `program:read`, `portfolio:read`, `budget:read`, `advisor:invoke`

### What G01 Must Avoid
1. No comprehensive economic forecasting model (budget estimates are conditional ranges)
2. No full sectoral implementation for every ministry
3. No live LLM provider (Stub only, `simulated: true`)
4. No AI auto-approval (human sovereignty absolute)
5. No real government data ingestion (Demolandia or properly-sourced public data only)
6. No external financial system integration
7. No claim of real-world policy impact
8. No rebuild of G00 contracts

### G01 Mission Pack Status
**Status: DRAFT FOR FOUNDER REVIEW — NOT YET APPROVED**

The mission pack (`docs/mission-reports/G01/GROUP_01_MISSION_PACK.md`) is complete with 11 missions (01-00 through 01-10), but:
- **No G01 code has been written**
- **No G01 migration has been created**
- **The founder has NOT yet approved implementation**

The mission pack was authored per the Progressive Mission Authoring principle (Roadmap §1) — written only after GROUP 00 acceptance.

### Awaiting Founder Decision
```
GROUP_01_MISSION_PACK = APPROVED / APPROVED WITH CHANGES / REJECTED
Implementation may begin: YES / NO
First mission to execute: 01-00
```

**Do not begin implementation before approval.**

---

## F. Development and Operating Environment

### Operating System and Tools
- **OS:** Linux (Ubuntu-based container)
- **Shell:** bash
- **Runtime:** Bun 1.3.14 (primary), Node.js 24+ (fallback)
- **Package manager:** Bun (lockfile: `bun.lock`)

### Technology Stack (per ADR-0001)
| Layer | Technology | Version |
|-------|------------|---------|
| Framework | Next.js | ^16.1.1 (App Router) |
| Language | TypeScript | ^5.7.2 |
| Database | PostgreSQL | 16 + pgvector |
| ORM | Prisma | ^6.11.1 |
| Auth | Auth.js (NextAuth) | 5.0.0-beta.25 |
| Validation | Zod | ^4.0.2 |
| Logging | pino | ^9.5.0 |
| Testing | Vitest | ^2.1.5 |
| E2E | Playwright | ^1.64.1 |
| Styling | Tailwind CSS | ^4.0.0 |

### Repository Paths
- **Local clone:** `/home/z/my-project/repos/The-Balance/`
- **Remote:** `https://github.com/mayakilzy/The-Balance.git`
- **Branch:** `main`
- **Worklog (shared):** `/home/z/my-project/worklog.md`
- **Scripts (generation):** `/home/z/my-project/scripts/`
- **Download (deliverables):** `/home/z/my-project/download/`

### How to Install Dependencies
```bash
cd /home/z/my-project/repos/The-Balance
bun install --frozen-lockfile
```

### How to Set Up the Environment
```bash
# 1. Start PostgreSQL (local dev)
docker compose up -d postgres

# 2. Copy env example
cp .env.example .env
# Edit .env with real AUTH_SECRET (openssl rand -base64 32)

# 3. Set up DB roles
export PGPASSWORD_BALANCE_ADMIN="<password>"
export PGPASSWORD_BALANCE_APP="<password>"
export PGPASSWORD_BALANCE_AUTH="<password>"
bash scripts/run-setup-roles.sh

# 4. Run migrations
bunx prisma migrate deploy

# 5. Seed ontology
bun run db:seed

# 6. Verify
bash scripts/fresh-install-verify.sh
```

### How to Run the Application
```bash
bun run dev    # Development (port 3000)
bun run build && bun run start   # Production
```

### How to Run Tests
```bash
# Unit tests only (no DB needed)
bun run test

# Unit + integration tests (requires PostgreSQL)
RUN_INTEGRATION_TESTS=1 bun run test

# Specific test file
bunx vitest run tests/integration/security.integration.test.ts --reporter=verbose

# Unit tests need AUTH_SECRET set
AUTH_SECRET="test_secret_min_16_chars" bun run test
```

### How to Run Playwright
```bash
# Install browsers (first time)
bunx playwright install --with-deps chromium

# Start dev server on port 3001
bunx next dev -p 3001 &
# Wait for readiness, then:
bunx playwright test --reporter=list
```

### How to Use GitHub Actions
- **CI triggers:** push to `main` or `g00/*`, PR to `main`
- **Primary workflow:** `.github/workflows/ci.yml` (19 steps)
- **Recovery workflow:** `.github/workflows/fresh-install-recovery.yml` (7 phases)
- **Monitor runs:** `https://github.com/mayakilzy/The-Balance/actions`

### Commit and Push Style
```bash
# Commit message convention: <type>(<mission>): <subject>
# Types: feat, fix, docs, refactor, test, chore
# Examples:
# feat(01-00): G01 bootstrap + country pack extension
# fix(00-10): use set +e for negative test

# Push (see GITHUB_ACCESS_CONTINUITY.md for authentication)
git push origin main
```

### Reading CI Results
- Use GitHub REST API to check run status:
  ```bash
  curl -s -H "Authorization: token <PAT>" \
    "https://api.github.com/repos/mayakilzy/The-Balance/actions/runs?per_page=5" \
    | jq -r '.workflow_runs[] | "Run #\(.run_number): \(.name) — \(.status)/\(.conclusion)"'
  ```
- Download logs for failure analysis:
  ```bash
  curl -s -L -H "Authorization: token <PAT>" \
    "https://api.github.com/repos/mayakilzy/The-Balance/actions/runs/<run_id>/logs" \
    -o /tmp/ci-logs.zip
  unzip -o /tmp/ci-logs.zip -d /tmp/ci-logs/
  ```

### How to Restore the Environment After Losing the Work Directory
If `/home/z/my-project/repos/The-Balance/` is deleted:
```bash
mkdir -p /home/z/my-project/repos
cd /home/z/my-project/repos
git clone https://github.com/mayakilzy/The-Balance.git
cd The-Balance
bun install --frozen-lockfile
bunx prisma generate
# Then follow "How to Set Up the Environment" above
```

The shared worklog at `/home/z/my-project/worklog.md` contains the full chronological history and survives repo deletion.

### Known Environment Limitations
1. **No PostgreSQL locally** — CI provides PostgreSQL 16 + pgvector; local development requires Docker
2. **No `psql` CLI locally** — DB scripts run in CI, not locally
3. **PAT may not persist between sessions** — see `GITHUB_ACCESS_CONTINUITY.md`
4. **Integration tests require real PostgreSQL** — set `RUN_INTEGRATION_TESTS=1` and have a running DB
5. **Unit tests require `AUTH_SECRET`** — set to any 16+ char string for testing
6. **Playwright requires a running Next.js server** — start on port 3001 before tests

---

## G. Transfer of Responsibility

| Aspect | GROUP 00 (Complete) | GROUP 01 (Awaiting Approval) |
|--------|---------------------|------------------------------|
| Foundation | ✅ Complete | Use as-is |
| Database schema | ✅ 22 models | Extend with new migrations (do NOT modify existing) |
| RLS policies | ✅ 14 tables | Extend for new tables (do NOT weaken existing) |
| Evidence Fabric | ✅ Complete | Build intelligence on top |
| Strategy Contracts | ✅ Complete | Build State Builder on top |
| Task Runtime | ✅ Complete | Use for async intelligence work |
| LLM Provider | Stub only | Continue using Stub; real provider is explicit step |
| ExpertAdapters | Stub only | Continue using Stub; real adapters are explicit step |
| UI | 6 foundation pages | Build government workflows (post-approval) |
| CI | ✅ 2 workflows green | Extend with G01 tests |
| Recovery | ✅ Proven | Maintain as-is |

---

## H. Key Reminders for the New Chat

1. **Read this document first**, then the G01 Mission Pack, then the G00 Final Review.
2. **Do NOT write any G01 code** until the founder approves the mission pack.
3. **Do NOT rebuild G00 systems** — use them as-is.
4. **Every LLM-dependent response must carry `simulated: true`** until a real provider is integrated.
5. **Human approval is sovereign** — no AI auto-approval, ever.
6. **"unknown" is a valid result** — never fabricate values.
7. **Counter-evidence is mandatory** for high-impact claims.
8. **Check the worklog** at `/home/z/my-project/worklog.md` for chronological history.
9. **Use the RUNBOOK** for install/operate/recover procedures.
10. **Never commit secrets** — PATs, passwords, API keys go in env vars or credential stores, never in git.

---

*This document is the single entry point for GROUP 01 development. It is self-contained: a new chat can read it and resume work without re-discovering context.*
