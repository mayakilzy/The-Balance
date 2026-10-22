# ADR-0001 — Stack Selection for GROUP 00

**Date:** 2026-10-16
**Status:** Accepted (founder-approved in principle)
**Mission:** 00-01

## Context

The Balance is an evidence-based state intelligence platform. GROUP 00 is the foundation: contracts, secure API, evidence fabric, country model, versioned task runtime. The stack must:

1. Support type-safe end-to-end development (DB → API → UI).
2. Handle multi-tenant isolation at the database level.
3. Accommodate vector similarity search (for RAG in 00-04).
4. Be maintainable by a small team without operational overhead.
5. Not lock the project into a single LLM vendor.

The founder's directives:
- Next.js + TypeScript + PostgreSQL + pgvector approved in principle.
- Prisma and Auth.js are candidates pending version/tenant-isolation verification.
- Single modular platform, not microservices.
- Use suitable ready-made libraries before developing new alternatives.

## Decision

Adopt the following stack for GROUP 00:

| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js 16 (App Router) | Industry standard, type-safe, founder-approved |
| Language | TypeScript 5 (strict) | End-to-end typing, catches contract drift early |
| Database | PostgreSQL 16 + pgvector | Founder-approved; supports RLS + JSONB + vector search in one engine |
| ORM | Prisma 6 | Type-safe schema, migrations, broad community support |
| Auth | Auth.js v5 (NextAuth) | v5 has first-class Next.js 16 support; v4 is maintenance-only |
| Validation | Zod 4 | Type inference from schemas; works in both client and server |
| Logging | pino | Fast, structured, low overhead |
| Testing | Vitest | Native ESM, fast, Jest-compatible API |
| LLM | Provider Abstraction (see ADR-0002) | No vendor lock-in |

## Alternatives considered

### Database
- **SQLite:** rejected — no RLS, no concurrent writers, no pgvector.
- **MySQL:** rejected — RLS support is weaker than PostgreSQL; pgvector equivalent is less mature.
- **Dedicated vector DB (Pinecone, Weaviate):** rejected for GROUP 00 — adds operational complexity. pgvector covers 00-04 needs. Revisit if scale demands.

### ORM
- **Drizzle:** considered — lighter than Prisma, but smaller ecosystem and less mature migration tooling. Revisit if Prisma's RLS interaction proves problematic.
- **Raw SQL:** rejected — loses type safety, increases boilerplate.

### Auth
- **NextAuth v4:** rejected — maintenance mode, less clean Next.js 16 integration.
- **Lucia:** considered — but project archived in 2024. Auth.js v5 is the maintained path.
- **Custom auth:** rejected — founder directive: "use suitable ready-made libraries before developing new alternatives."

### LLM
- **z-ai-web-dev-sdk as sole provider:** rejected per founder directive. See ADR-0002.

## Consequences

- **Positive:** Type safety from DB to UI. Single database engine for relational + vector data. Mature auth. Vendor independence on LLM.
- **Negative:** Prisma's interaction with PostgreSQL RLS requires care (see ADR-0003). Auth.js v5 is beta — pin to a specific version (`5.0.0-beta.25`) and monitor.
- **Mitigation:** RLS interaction is documented in ADR-0003 with a test plan for 00-03.

## Verification

- Prisma 6 + PostgreSQL 16 + pgvector: verified compatible via `pgvector/pgvector:pg16` Docker image.
- Auth.js v5 + Next.js 16: verified via `next-auth@5.0.0-beta.25` + `next@16.1.1`.
- Vitest + Next.js 16: verified working in this mission's test suite.
