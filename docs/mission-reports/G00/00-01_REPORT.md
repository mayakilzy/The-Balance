# 00-01 — Runnable Platform Skeleton — REPORT

**Project:** THE_BALANCE
**GROUP:** 00
**MISSION:** 00-01
**BASE_SHA:** (empty repository — no prior commits)
**FINAL_SHA:** `1091ddc50d9f083fb92abb819480c5fa7964a1e6`
**WORKTREE:** clean
**Date:** 2026-10-16
**Author:** GLM (super-z)
**Status:** PASS

---

## IMPLEMENTED

### Application code (`src/`)
```
src/
├── app/
│   ├── api/
│   │   ├── health/route.ts              # GET /api/health — liveness + readiness
│   │   ├── v1/meta/route.ts             # GET /api/v1/meta — build metadata
│   │   └── auth/[...nextauth]/route.ts  # Auth.js v5 mount (inert in 00-01)
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx                         # UI shell — live health display
└── lib/
    ├── env.ts                           # Zod-validated env access
    ├── db.ts                            # Prisma client singleton
    ├── audit.ts                         # Append-only audit log writer
    ├── observability.ts                 # pino structured logger
    ├── auth.ts                          # Auth.js v5 config (no providers)
    ├── security/
    │   └── tenant-context.ts            # RLS context helpers (SET LOCAL app.tenant_id)
    └── llm/
        ├── provider.ts                  # LLMProvider interface (abstraction)
        ├── stub-provider.ts             # Deterministic stub (default)
        └── index.ts                     # Factory + singleton
```

### Schema + migrations (`prisma/`)
```
prisma/
├── schema.prisma                                     # Tenant + AuditLog models
└── migrations/20261016000001_init/migration.sql      # pgvector ext + tables (RLS deferred to 00-03)
```

### Tests (`tests/`)
```
tests/unit/
├── health.test.ts         # 3 tests: positive, negative (DB down), ISO timestamp
├── llm-provider.test.ts   # 7 tests: StubProvider contract + determinism
└── meta.test.ts           # 1 test: build metadata + feature flags
```
**Total: 11 tests, all passing.**

### Documentation
```
README.md                                  # Setup + scripts + layout
BASELINE.md                                # Repo baseline (00-00 deliverable)
docs/adr/
├── ADR-0001-stack-selection.md            # Next.js + PG + Prisma + Auth.js v5 rationale
├── ADR-0002-llm-provider-abstraction.md   # No exclusive z-ai-web-dev-sdk binding
└── ADR-0003-tenant-isolation.md           # PostgreSQL RLS design (impl in 00-03)
docs/mission-reports/G00/00-01_REPORT.md   # This file
```

### Infrastructure
```
package.json                    # Next 16, React 19, Prisma 6, Auth.js v5, Zod 4, pino, Vitest
tsconfig.json                   # Strict TS 5 with noUncheckedIndexedAccess
next.config.ts                  # Security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
eslint.config.mjs               # ESLint 9 flat config + eslint-config-next
vitest.config.ts                # Node env, @/ alias, coverage on src/lib + src/app/api
docker-compose.yml              # PostgreSQL 16 + pgvector (pgvector/pgvector:pg16)
.env.example                    # Template — NO secrets, safe to commit
.env                            # Local dev — gitignored
.gitignore                      # node_modules, .next, .env, tsconfig.tsbuildinfo, etc.
.github/workflows/ci.yml        # lint + typecheck + test on push/PR
```

---

## COMMANDS_RUN

| Command | Exit code | Notes |
|---|---|---|
| `bun install` | 0 | 462 packages, 8.85s |
| `bunx prisma generate` | 0 | Prisma client generated |
| `bun run lint` | 0 | ESLint 9, 0 errors, 0 warnings |
| `bun run typecheck` | 0 | `tsc --noEmit` strict mode |
| `bun run test` | 0 | 11/11 tests pass |
| `bun run ci` | 0 | lint + typecheck + test parity |
| `bun run dev` (manual) | 0 (timeout) | Server starts in ~2s, responds 200 on /api/v1/meta, 503 on /api/health (no DB) |
| `curl http://localhost:3000/api/v1/meta` | 0 | Returns 200 with build metadata |
| `curl http://localhost:3000/api/health` | 0 | Returns 503 with `status: "degraded"` (DB unreachable) |
| `git commit` | 0 | 37 files committed |
| `git push` | 0 | Pushed to `mayakilzy/The-Balance` main branch |

---

## TESTS

### Unit tests (Vitest, all passing)
```
tests/unit/health.test.ts (3 tests)
  ✓ returns 200 with status=ok when DB is reachable
  ✓ returns 503 with status=degraded when DB is unreachable
  ✓ includes timestamp in ISO format

tests/unit/llm-provider.test.ts (7 tests)
  ✓ implements the LLMProvider interface
  ✓ complete() returns deterministic canned content
  ✓ complete() handles empty messages array
  ✓ stream() yields chunks and terminates with done=true
  ✓ embed() returns deterministic vectors
  ✓ embed() handles array input
  ✓ health() always returns true (in-process provider)

tests/unit/meta.test.ts (1 test)
  ✓ returns build metadata with all feature flags off

Test Files  3 passed (3)
     Tests  11 passed (11)
  Duration  ~700ms
```

### Negative path evidence
The health test "returns 503 with status=degraded when DB is unreachable" explicitly mocks a DB failure (`ECONNREFUSED`) and asserts:
- HTTP status 503
- `body.status === "degraded"`
- `body.checks[0].status === "down"`
- `body.checks[0].detail` contains the error message
- Audit log records the error with `status: "error"`

### Live verification (dev server)
- `GET /api/v1/meta` → 200 with correct build metadata
- `GET /api/health` → 503 with `status: "degraded"` (DB not running in sandbox)
  - `database` check: `status: "down"`, detail: `"Can't reach database server at localhost:5432"`
  - `llm` check: `status: "ok"`, detail: `"provider=stub"`
- UI shell renders HTML correctly (verified via curl)

---

## LIVE_VS_MOCK

| Component | Classification | Evidence |
|---|---|---|
| `/api/health` route handler | **LIVE** | Real route handler, real Prisma call (mocked in tests, real in dev server) |
| `/api/v1/meta` route handler | **LIVE** | Real route handler, returns actual env values |
| Prisma database access | **LIVE (no DB running in sandbox)** | Real Prisma client; DB unreachable in sandbox → 503. In CI, Postgres service container is configured. |
| Audit log writer | **LIVE (write fails gracefully when DB down)** | Real `db.auditLog.create()` call; on failure, logs error and continues (by design) |
| Auth.js v5 | **LIVE (inert)** | Real NextAuth() call, but `providers: []` — no authentication happens. This is intentional for 00-01. |
| LLM Provider | **SIMULATED (stub)** | `LLM_PROVIDER=stub` is the default. StubProvider returns deterministic canned responses. No real LLM is called. **This is honestly disclosed in the UI footer and /api/v1/meta.** |
| Tenant isolation helpers | **LIVE (inert)** | `setTenantContext()` runs `SET LOCAL app.tenant_id` for real, but RLS policies are NOT created yet (deferred to 00-03). So the helper is functional but unenforced. |
| pino logger | **LIVE** | Real pino instance, structured JSON output |
| CI workflow | **LIVE (not yet triggered)** | `.github/workflows/ci.yml` is committed; will run on next push/PR |

**No mock is disguised as live.** The UI footer explicitly states: "All LLM outputs in this build are SIMULATED (stub provider)."

---

## SECURITY

### Secrets handling
- **PAT** (GitHub Personal Access Token): stored at `/home/z/my-project/.secrets/github_pat` (mode 0600), gitignored at sandbox level. Used only for `git push`; not present in any committed file. **Verified**: `git diff --cached | grep -E "ghp_|github_pat_"` returns empty.
- **AUTH_SECRET**: `.env` contains a dev-only placeholder (`dev_only_secret_do_not_use_in_production_generate_a_real_one`). `.env` is gitignored. `.env.example` contains `"CHANGE_ME_generate_with_openssl_rand_base64_32"`.
- **DATABASE_URL**: `.env` contains `postgresql://balance:balance@localhost:5432/balance` — local dev credentials only, gitignored.

### Pre-commit verification
```bash
git check-ignore -v .env       # → .gitignore:20:.env .env  ✓
git diff --cached --name-only | grep -E "^\.env$"  # → empty  ✓
git diff --cached | grep -E "ghp_|github_pat_|sk-"  # → empty  ✓
```

### Security headers (in `next.config.ts`)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`

### Audit log design
- `audit_log` table is designed as append-only. RLS policies (00-03) will forbid UPDATE/DELETE for the application role.
- `ipHash` column stores SHA-256 of the raw IP salted with AUTH_SECRET — never the raw IP.
- Audit write failures are logged at `error` level but do NOT throw — audit must not break the primary flow.

### Auth.js v5
- `AUTH_SECRET` is validated by Zod to be at least 16 chars.
- `AUTH_TRUST_HOST` defaults to `true` for dev; must be set explicitly in production.
- No providers in 00-01 — auth is intentionally inert. CSRF protection is handled by Auth.js internally.

### What is NOT yet secured (deferred to later missions)
- **RLS policies**: not created. Tenant isolation helpers exist but are unenforced. (00-03)
- **Rate limiting**: not implemented. (00-09)
- **CSP headers**: not set. (00-09)
- **Input sanitization beyond Zod**: not implemented for domain models. (00-02+)

---

## CONTRACT_CHANGES

### Initial schema (no prior version to migrate from)
- **`tenants` table**: `id (TEXT PK), code (TEXT UNIQUE), displayName (TEXT), status (TEXT DEFAULT 'active'), createdAt, updatedAt`
- **`audit_log` table**: `id (BIGSERIAL PK), at, tenantId (FK→tenants, ON DELETE SET NULL), actor, action, route, method, ipHash, details (JSONB), status, errorCode`
- **Extension**: `CREATE EXTENSION IF NOT EXISTS vector;` (pgvector, for 00-04)
- **Indexes**: `tenants(status)`, `audit_log(tenantId, at)`, `audit_log(action, at)`

### Compatibility impact
- This is the initial migration — no existing data to preserve.
- Future migrations will add: `users` (00-03), `evidence` + `evidence_embeddings` (00-04), `strategies` + `events` (00-05), `tasks` (00-06), `capabilities` (00-07).

### RLS deferred
The migration SQL includes commented-out RLS activation lines. RLS policies will be created in a separate migration in mission 00-03, after the `balance_app` and `balance_admin` database roles are created. See `ADR-0003` for the full plan.

---

## DEFECTS

### Defect D-00-01-1: Sandbox `.env` shadowing (environment, NOT a The-Balance bug)
- **Severity**: Low (does not affect CI or production)
- **Description**: The sandbox environment at `/home/z/my-project/.env` contains `DATABASE_URL=file:/home/z/my-project/db/custom.db` (leftover from a prior swarm-engine template). When running `bun run dev` from `/home/z/my-project/repos/The-Balance/`, bun loads the parent directory's `.env` first, shadowing The-Balance's `.env`.
- **Impact**: In the sandbox, `DATABASE_URL` resolves to a SQLite file path, causing Prisma to throw a URL validation error instead of a clean connection error.
- **Workaround**: `export DATABASE_URL="postgresql://..."` before `bun run dev` in the sandbox.
- **Reproduction**: `cd /home/z/my-project/repos/The-Balance && bun -e "console.log(process.env.DATABASE_URL)"` → prints the SQLite path, not the PostgreSQL URL.
- **Resolution**: This is a sandbox artifact. In CI (GitHub Actions), env vars are set explicitly via the workflow. In production, the deployment environment sets env vars. No code change needed in The-Balance.
- **Status**: Acknowledged, will not fix (not a The-Balance issue).

### Defect D-00-01-2: Docker unavailable in sandbox
- **Severity**: Low (does not affect CI)
- **Description**: The sandbox does not have Docker installed, so `docker compose up postgres` cannot run. This means the positive health-check path (DB up → 200) could not be verified with a live database in the sandbox.
- **Impact**: The positive path is verified ONLY via unit tests (mocked Prisma). The live dev server verification shows only the negative path (DB down → 503).
- **Workaround**: In CI, the GitHub Actions workflow uses a `pgvector/pgvector:pg16` service container, so the positive path will be verified there on the next push.
- **Status**: Acknowledged. Will be verified in CI on next push.

### No other defects detected.
- All 11 tests pass.
- Lint passes with 0 errors, 0 warnings.
- Typecheck passes in strict mode.
- Dev server starts and responds correctly.
- No secrets committed.
- No unauthorized external writes.

---

## STATUS

**PASS**

### Justification
1. ✅ **Feature runs in the actual project environment**: Dev server starts in ~2s, `/api/v1/meta` returns 200, `/api/health` returns 503 (correct — DB not running). UI shell renders.
2. ✅ **Acceptance assertions demonstrated, including negative case**: 3 health tests cover positive (200/ok), negative (503/degraded), and edge (ISO timestamp) cases. The negative test asserts the exact error message is propagated.
3. ✅ **No unauthorized external writes, no secrets committed, test data clearly labeled**: Verified via `git diff --cached` grep. `.env` is gitignored. PAT is in `.secrets/` (gitignored at sandbox level). LLM stub is labeled in UI footer + `/api/v1/meta`.
4. ✅ **Final report supplies NEXT_MISSION and reproducible commands**: See below.
5. ✅ **All failures/limitations honestly disclosed**: Defects D-00-01-1 and D-00-01-2 are documented. LIVE_VS_MOCK table explicitly classifies every component. The stub provider is not disguised as a real LLM.

### Founder directives compliance
| Directive | Compliance |
|---|---|
| Adopt Next.js + TS + PG + pgvector | ✅ All present in package.json + docker-compose |
| Prisma + Auth.js candidates, verify version compatibility | ✅ Prisma 6.19.3 + Auth.js 5.0.0-beta.25 verified working with Next.js 16.4.2. See ADR-0001. |
| LLM Provider Abstraction (no exclusive z-ai-web-dev-sdk) | ✅ `src/lib/llm/provider.ts` defines the interface. StubProvider is default. z-ai-web-dev-sdk is NOT installed. See ADR-0002. |
| No Python service in GROUP 00 | ✅ Zero Python files in the repo. |
| No MIT license auto-adoption | ✅ No LICENSE file present. README states "License: To be determined by the founder." |
| Shared repos READ-ONLY | ✅ No commits to swarm-engine or AgentCraft-Toolkit. |
| No production-readiness claims without tests | ✅ 11 tests passing. LIVE_VS_MOCK honestly classifies stub as SIMULATED. |
| Use ready-made libraries before new alternatives | ✅ NextAuth, Prisma, pino, Zod, Vitest — all established libraries. No custom auth, no custom ORM, no custom logger. |
| Don't add dependencies without proven need | ✅ Only 8 runtime deps (next, react, react-dom, @prisma/client, next-auth, @auth/prisma-adapter, pino, zod). No unused deps. |

---

## NEXT_MISSION

**00-02 — Tenant, Country and State Ontology**

Per the mission index: "Country & Tenant Data Model — migrations + unique country model".

This mission will:
1. Extend the Prisma schema with `Country` and `StateHierarchy` models.
2. Establish the relationship between `Tenant` (from 00-01) and `Country` (one-to-one or one-to-many depending on design).
3. Create the second migration.
4. Add tests for the country model (uniqueness, lifecycle).
5. Begin implementing RLS policies if the founder approves early activation (originally planned for 00-03, but 00-02's tenant model may benefit).

### Handoff fields (per README_START_HERE.md §5)
- **Repository URL**: `https://github.com/mayakilzy/The-Balance`
- **Branch**: `main`
- **Exact HEAD SHA**: `1091ddc50d9f083fb92abb819480c5fa7964a1e6`
- **Group**: 00
- **Passed missions**: 00-00 (conditional), 00-01
- **In-progress mission**: none
- **Next mission**: 00-02 Tenant, Country and State Ontology
- **Test commands**: `bun run ci` (lint + typecheck + test)
- **Failed checks**: none
- **Environment prerequisites**: Node.js 22+ / Bun 1.3+, Docker (for PostgreSQL), `cp .env.example .env` + generate AUTH_SECRET
- **Schema migrations**: `20261016000001_init` (applied via `prisma migrate deploy` in CI; `prisma db push` in dev)
- **Open defects**: D-00-01-1 (sandbox env shadowing — not a The-Balance bug), D-00-01-2 (Docker unavailable in sandbox — CI will verify)
- **Decisions needing confirmation**: (1) Should 00-02 begin RLS policy creation ahead of 00-03? (2) Should the next mission also add a `User` model or defer to 00-03?
- **SHA of mission ZIP**: `6415c45b8cf0ef9714a65c5cff11867ea8e4929651db07a20a4e27e623ac9186` (GROUP_00_MISSIONS.zip, verified)
- **Known mocks**: StubProvider (LLM) — deterministic, no real LLM calls. Auth.js providers list is empty (inert). No other mocks.

---

## Reproducible commands

```bash
# Clone
git clone https://github.com/mayakilzy/The-Balance.git
cd The-Balance

# Install
bun install  # or: npm install

# Start PostgreSQL (requires Docker)
docker compose up -d postgres

# Configure env
cp .env.example .env
# Edit .env: set AUTH_SECRET=$(openssl rand -base64 32)

# Generate Prisma client + apply migrations
bunx prisma generate
bunx prisma migrate deploy  # or: bunx prisma db push (dev)

# Run CI parity
bun run ci  # lint + typecheck + test

# Start dev server
bun run dev
# Open http://localhost:3000

# Verify endpoints
curl http://localhost:3000/api/health
curl http://localhost:3000/api/v1/meta
```

---

**End of 00-01 report.**
