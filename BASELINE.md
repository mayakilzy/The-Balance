# BASELINE.md — Repository Baseline

**Mission:** 00-00 Repository Baseline and Architecture Recon
**Date:** 2026-10-16
**Auditor:** GLM (super-z)
**Status:** PASS (conditional, per founder's review of G00 audit)

## Repository facts at audit time

| Field | Value |
|---|---|
| Repository | `mayakilzy/The-Balance` |
| Visibility | Public |
| Default branch | `main` |
| State before 00-01 | **Empty** (0 KB, 0 commits, 0 files) |
| Language | None (no code) |
| License | None declared |

## Starting point for 00-01

Because the repository was empty, the BASE_SHA for mission 00-01 is the **initial commit** that introduces the platform skeleton. There is no prior history to preserve.

## Architectural decisions (locked in by founder)

1. **Stack:** Next.js 16 + TypeScript 5 + PostgreSQL 16 (pgvector) + Prisma 6 + Auth.js v5 + Zod 4 + pino + Vitest.
2. **LLM Provider Abstraction:** No exclusive binding to `z-ai-web-dev-sdk`. Stub provider is default; real providers added in 00-06.
3. **Tenant isolation:** PostgreSQL RLS is the enforcement layer. Prisma must not bypass it. Helper: `src/lib/security/tenant-context.ts`.
4. **License:** Not set — founder will decide explicitly. No LICENSE file in this mission.
5. **No Python service in GROUP 00:** per founder directive. AgentCraft-Toolkit remains a candidate for selective reuse in later groups, but not in 00-01.
6. **Audited repositories (`swarm-engine`, `AgentCraft-Toolkit`):** READ-ONLY. No commits, no branches, no PRs from The-Balance to either.
7. **Audit report:** `G00_REUSE_AND_DEPENDENCY_AUDIT.md` (in repo-info, not in The-Balance per founder's "local only" choice for that artifact).

## What was rejected (over-engineering avoided)

Per founder's principle "Small in Code, Large in Capability":

- **Rejected:** Microservices split (single monorepo instead).
- **Rejected:** Dedicated graph DB (PostgreSQL + JSONB + pgvector sufficient for GROUP 00).
- **Rejected:** Redis/BullMQ for task queue (PostgreSQL `SELECT FOR UPDATE SKIP LOCKED` sufficient — comes in 00-06).
- **Rejected:** Copying `swarm-engine` wholesale (it's 100% mock — see G00 audit).
- **Rejected:** Importing `AgentCraft-Toolkit` Python modules in GROUP 00 (cross-language complexity unjustified at this stage).

## Next mission

**00-02 Tenant, Country and State Ontology** — data model for tenants + countries + the state hierarchy. Builds on the `Tenant` model introduced in 00-01.

## SHA references

- **BASE_SHA (00-01):** (empty repository — first commit below)
- **FINAL_SHA (00-01):** (recorded in `00-01_REPORT.md` after commit)
