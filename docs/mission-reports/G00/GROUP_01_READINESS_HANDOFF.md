# GROUP 01 — Readiness Handoff

**Mission 00-11 deliverable.** Transfer document from GROUP 00 (Foundation) to GROUP 01 (State Builder).

**Date:** 2026-10-17
**GROUP 00 status:** COMPLETE — all 11 missions passed
**GROUP 01 readiness:** PASS

---

## 1. Purpose

This document tells GROUP 01 exactly what it inherits, what it can build on, what it must build, and what it must not touch. It is the single entry point for GROUP 01 development.

---

## 2. What GROUP 01 Inherits

### 2.1 Platform Foundation (Do Not Rebuild)

| Component | Location | Status |
|-----------|----------|--------|
| Next.js 16 + TypeScript 5 app | `src/app/` | Production-ready |
| PostgreSQL 16 + pgvector | `docker-compose.yml` | Configured |
| Prisma 6 schema (22 models) | `prisma/schema.prisma` | 16 migrations applied |
| Auth.js v5 (CredentialsProvider) | `src/lib/auth.ts` | Production-ready |
| RBAC/ABAC (4 roles) | `src/lib/permissions.ts` | Enforced |
| RLS (14 PRIVATE tables) | Migrations 0002–0016 | ENABLE + FORCE |
| Audit log (append-only) | `src/lib/audit.ts` | DB-enforced |
| Structured logging (pino) | `src/lib/observability.ts` | With request IDs + redaction |
| Security middleware | `src/middleware.ts` | CSP, headers, rate limiting |
| Error sanitization | `src/lib/error-sanitizer.ts` | HTTP + log layers |
| Metrics counters | `src/lib/metrics.ts` | Wired to middleware + routes |
| CI pipeline | `.github/workflows/ci.yml` | 19 steps, green |
| Recovery pipeline | `.github/workflows/fresh-install-recovery.yml` | 7 phases, green |

### 2.2 Domain Contracts (Use Directly)

#### Evidence Fabric (`src/lib/evidence-service.ts`)
```
createEvidence(session, { sourceCode, ..., content, completeness })
searchEvidence(session, { query, limit })  // pgvector cosine similarity
verifyEvidence(session, evidenceId)
```
- Evidence is tenant-scoped (PRIVATE table, RLS-enforced)
- Sources are PUBLIC (shared across tenants)
- Embeddings are 384-dim (pgvector)
- **G01 use:** Store government data (economic indicators, policy documents, public records) as evidence

#### Strategy Contracts (`src/lib/strategy-service.ts`)
```
createStrategy(session, { title, description })
createStrategyVersion(session, strategyId, { content, rationale })
approveStrategyVersion(session, versionId)  // freezes the version
createDecision(session, versionId, { evidenceIds, ... })  // snapshots evidence
```
- Strategy versions are immutable once approved (trigger-protected)
- Decisions snapshot evidence at decision time (point-in-time integrity)
- **G01 use:** Model reform strategies, policy decisions, and their evidence basis

#### Durable Task Runtime (`src/lib/task-service.ts`)
```
createTask(session, { type, goal, input, idempotencyKey, priority })
claimTask(session, workerId, leaseDurationMs)  // SELECT FOR UPDATE SKIP LOCKED
startTask(session, taskId, workerId, claimGeneration)
updateProgress(session, taskId, progress, workerId, claimGeneration)
completeTask(session, taskId, output, workerId, claimGeneration)
failTask(session, taskId, error, workerId, claimGeneration)
reclaimStaleTasks(session)  // auto-reclaim expired leases
```
- Fencing token (`claimGeneration`) prevents stale workers from corrupting state
- Idempotency via UNIQUE partial index on `(tenantId, idempotencyKey)`
- Lease-based reclaim (default 60s)
- **G01 use:** Run long-running intelligence computations (policy analysis, scenario modeling)

#### Capability Registry (`src/lib/capability-service.ts`)
```
registerCapability({ code, displayName, type, readiness, requiredPermission, adapterEndpoint })
discoverCapabilities(session, filters)
checkEligibility(session, capabilityCode)
invokeCapability(session, code, input, taskId?)
```
- ExpertAdapter contract: `execute(input) → { output, provider, simulated }`
- No silent fallback (missing adapter FAILS, not stub)
- Readiness classification: stub | mock | live | untested
- **G01 use:** Register real tools (budget models, demographic analyzers, policy simulators)

#### LLM Provider Abstraction (`src/lib/llm/provider.ts`)
```
interface LLMProvider {
  name: string;
  defaultModel: string;
  complete(messages: Message[]): Promise<CompletionResult>;
  stream(messages: Message[]): AsyncIterable<StreamChunk>;
  embed(text: string | string[]): Promise<EmbeddingResult>;
  health(): Promise<HealthStatus>;
}
```
- `StubProvider` returns deterministic SIMULATED responses
- `getLLMProvider()` factory selects based on `LLM_PROVIDER` env var
- **G01 use:** Implement `ZaiProvider`, `OpenAIProvider`, or `AnthropicProvider` by implementing this interface

### 2.3 Operational Tooling

| Tool | Location | Purpose |
|------|----------|---------|
| `fresh-install-verify.sh` | `scripts/` | Prove fresh install from empty DB |
| `verify-restored-db.sh` | `scripts/` | Non-destructive verification of restored DB |
| `backup-restore-test.sh` | `scripts/` | Backup → drop → restore drill + negative test |
| `restart-verify.sh` | `scripts/` | App restart + data persistence test |
| `run-setup-roles.sh` | `scripts/` | Create 3 DB roles with env-var passwords |
| `RUNBOOK.md` | `docs/` | Install + operate + recover procedures |

### 2.4 Test Infrastructure

- **Vitest** for unit + integration tests (18 files, 237 tests)
- **Playwright** for browser E2E (4 tests with screenshots)
- **Integration tests require PostgreSQL** — set `RUN_INTEGRATION_TESTS=1`
- **Test users:** admin, analyst, suspended, revoked (all @demolandia.test)
- **Test country:** Demolandia (ISO3: DML) — clearly fictional

---

## 3. What GROUP 01 Must Build

### 3.1 Real LLM Adapter (Priority: High)

Implement at least one real `LLMProvider`:
- File: `src/lib/llm/zai-provider.ts` (or `openai-provider.ts`, `anthropic-provider.ts`)
- Register in factory: `src/lib/llm/index.ts`
- Test with real API key in staging (never in CI)
- Update `StubAdapter` usage in `balance-master.ts` to use the real provider when available

### 3.2 Real ExpertAdapters (Priority: High)

Implement `ExpertAdapter` implementations for government-specific tools:
- Budget analysis adapter
- Demographic analyzer adapter
- Policy simulator adapter
- Each must declare `readiness: "live"` only when truly live
- Register via `registerCapability()` in seed or admin UI

### 3.3 State Builder Engine (Priority: High — Core G01 Deliverable)

The core intelligence layer. This is what GROUP 01 is fundamentally about:
- Evidence-driven state analysis
- Strategy recommendation engine
- Decision support system
- Implementation tracking

**Build on top of:** Evidence Fabric + Strategy Contracts + Durable Task Runtime

### 3.4 Government-Facing UI (Priority: Medium)

The 6 foundation pages (home, login, tasks, evidence, capabilities, strategies) are admin-oriented. G01 must build:
- Country dashboard (evidence-backed state overview)
- Strategy builder workflow
- Decision tracking UI
- Evidence upload + verification UI

### 3.5 Production Hardening (Priority: As needed for deployment)

See `GROUP_00_KNOWN_LIMITATIONS.md` for the full list. Key items:
- Distributed metrics (Prometheus) before multi-instance
- Redis rate limiting before multi-instance
- WAL archiving before production
- Secrets management (Vault/SOPS) before production

---

## 4. What GROUP 01 Must NOT Do

1. **Do NOT rebuild authentication** — Auth.js v5 is production-ready
2. **Do NOT modify RLS policies** without a new ADR — they are tested and enforced
3. **Do NOT change the task runtime fencing model** — it is proven correct
4. **Do NOT remove the `simulated: true` flag** from stub responses — it is the honesty mechanism
5. **Do NOT bypass `withAuthenticatedTenant`** for DB access — it enforces RLS
6. **Do NOT log raw error messages** — use `buildApiErrorResponse()` + `sanitizeForLog()`
7. **Do NOT trust `x-forwarded-for`** without `TRUSTED_PROXY=true`
8. **Do NOT use `fresh-install-verify.sh` on a restored DB** — use `verify-restored-db.sh`
9. **Do NOT use `pg_dump --no-privileges`** — it strips RLS policies
10. **Do NOT introduce swarm-engine code** — 0% reuse per ADR-0011

---

## 5. Architectural Decisions GROUP 01 Should Respect

### ADRs That Remain Binding
- **ADR-0001** (Stack): Next.js 16 + TS 5 + PG 16 + pgvector + Prisma 6 + Auth.js v5 + Zod 4 + pino + Vitest
- **ADR-0002** (LLM Abstraction): No exclusive provider binding; StubProvider default
- **ADR-0003** (RLS): PostgreSQL RLS for tenant isolation, not Prisma-level
- **ADR-0004** (Country/Tenant): PUBLIC vs PRIVATE scope separation
- **ADR-0005** (3 DB Roles): balance_admin, balance_app, balance_auth
- **ADR-0006** (Hierarchy): Cycle detection, same-country parent
- **ADR-0007** (Auth): CredentialsProvider + bcrypt + JWT
- **ADR-0008** (RBAC/ABAC): Default-deny, current-role authorization
- **ADR-0009** (Evidence): Sources (PUBLIC) + evidence (PRIVATE) + embeddings (pgvector)
- **ADR-0010** (Strategy): Immutable approved versions, evidence snapshots at decisions
- **ADR-0011** (Capabilities): ExpertAdapter contract, no silent fallback
- **ADR-0012** (Security): Defense in depth, fail-closed, no secret leakage

### New ADRs GROUP 01 Should Create
- ADR for State Builder architecture
- ADR for real LLM provider selection
- ADR for each new ExpertAdapter
- ADR for production deployment topology

---

## 6. First Steps for GROUP 01

1. **Read the Acceptance Matrix** — `docs/mission-reports/G00/GROUP_00_ACCEPTANCE_MATRIX.md`
2. **Read the Known Limitations** — `docs/mission-reports/G00/GROUP_00_KNOWN_LIMITATIONS.md`
3. **Read the RUNBOOK** — `docs/RUNBOOK.md`
4. **Run the platform locally:**
   ```bash
   git clone https://github.com/mayakilzy/The-Balance.git
   cd The-Balance
   bun install
   docker compose up -d postgres
   bash scripts/run-setup-roles.sh
   bunx prisma migrate deploy
   bun run db:seed
   bun run dev
   ```
5. **Run the test suite:**
   ```bash
   RUN_INTEGRATION_TESTS=1 bun run test
   ```
6. **Verify fresh install:**
   ```bash
   bash scripts/fresh-install-verify.sh
   ```
7. **Define the first G01 mission** — likely a real LLM adapter or a State Builder prototype

---

## 7. Transfer of Responsibility

| Aspect | GROUP 00 (Foundation) | GROUP 01 (State Builder) |
|--------|----------------------|--------------------------|
| Authentication | ✅ Complete | Use as-is |
| Database schema | ✅ Complete | Extend with new migrations (do NOT modify existing) |
| RLS policies | ✅ Complete | Extend for new tables (do NOT weaken existing) |
| Evidence Fabric | ✅ Complete | Build intelligence on top |
| Strategy Contracts | ✅ Complete | Build State Builder on top |
| Task Runtime | ✅ Complete | Use for async intelligence work |
| LLM Provider | Stub only | Implement real providers |
| ExpertAdapters | Stub only | Implement real adapters |
| UI | Foundation pages | Build government workflows |
| CI | ✅ Complete | Extend with G01 tests |
| Recovery | ✅ Complete | Maintain as-is |

---

## 8. Sign-off

**GROUP 00 Foundation:** COMPLETE
**GROUP 01 Readiness:** PASS

The foundation is solid. The contracts are clear. The operational tooling is proven. GROUP 01 can begin building the State Builder — the actual intelligence layer that will serve governments.

---

*Handoff date: 2026-10-17*
*Final GROUP 00 SHA: `deccc96`*
*GROUP 01 starting point: this document + the repository at the SHA above*
