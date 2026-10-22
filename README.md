# The Balance

**Global State Intelligence & State-Building Platform**

> **Status:** GROUP 00 Foundation — Mission 00-01 Runnable Platform Skeleton.
> Not for production use. All LLM outputs in this build are SIMULATED (stub provider).

## What this is

The Balance is an evidence-based state intelligence platform intended for legitimate governments. It helps governments understand the actual state of the country, design interconnected reform strategies, accompany implementation, measure results, and protect the state's strategic memory across changes of government.

This repository contains the application implementation. Planning documents live in [`mayakilzy/repo-info/The-Balance-Doc`](https://github.com/mayakilzy/repo-info/tree/main/The-Balance-Doc).

## Stack (GROUP 00)

| Layer | Technology | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router) | TypeScript 5 end-to-end |
| Database | PostgreSQL 16 + pgvector | See `docker-compose.yml` |
| ORM | Prisma 6 | Schema in `prisma/schema.prisma` |
| Auth | Auth.js v5 (NextAuth) | Skeleton only in 00-01; providers in 00-03 |
| Validation | Zod 4 | Env validation in `src/lib/env.ts` |
| Logging | pino | Structured, NDJSON in prod |
| Testing | Vitest | Unit + integration |
| LLM | Provider Abstraction | Stub by default; swap via `LLM_PROVIDER` env var |

See `docs/adr/` for the rationale behind each choice.

## Quick start (development)

### Prerequisites

- Node.js 22+ (or Bun 1.3+)
- Docker (for PostgreSQL)

### 1. Install dependencies

```bash
npm install
# or: bun install
```

### 2. Start PostgreSQL

```bash
docker compose up -d postgres
```

Verify it's running:

```bash
docker compose ps
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env — generate AUTH_SECRET with: openssl rand -base64 32
```

### 4. Generate Prisma client + push schema

```bash
npx prisma generate
npx prisma db push
```

### 5. Run the dev server

```bash
npm run dev
# or: bun run dev
```

Open <http://localhost:3000> — the UI shell shows live health status.

### 6. Verify health endpoint

```bash
curl http://localhost:3000/api/health
```

Expected response (HTTP 200):

```json
{
  "status": "ok",
  "version": "0.0.1",
  "env": "development",
  "time": "2026-10-16T...",
  "checks": [
    { "name": "database", "status": "ok", "latencyMs": 3 },
    { "name": "llm", "status": "ok", "latencyMs": 0, "detail": "provider=stub" }
  ]
}
```

If the database is unreachable, the endpoint returns HTTP 503 with `status: "degraded"`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server on port 3000 |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | ESLint (Next.js core-web-vitals) |
| `npm run typecheck` | TypeScript strict type check |
| `npm run test` | Run Vitest unit tests |
| `npm run test:watch` | Watch mode |
| `npm run db:generate` | Generate Prisma client |
| `npm run db:push` | Push schema to DB (dev only) |
| `npm run db:migrate` | Create + apply migration |
| `npm run ci` | Lint + typecheck + test (CI parity) |

## Project layout

```
.
├── prisma/
│   └── schema.prisma           # Tenant + AuditLog models
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── api/
│   │   │   ├── health/         # GET /api/health — liveness + readiness
│   │   │   ├── v1/_meta/       # GET /api/v1/_meta — version info
│   │   │   └── auth/[...nextauth]/  # Auth.js v5 mount
│   │   ├── layout.tsx
│   │   ├── page.tsx            # UI shell with live health
│   │   └── globals.css
│   └── lib/
│       ├── env.ts              # Zod-validated env access
│       ├── db.ts               # Prisma client singleton
│       ├── audit.ts            # Append-only audit log writer
│       ├── observability.ts    # pino logger
│       ├── auth.ts             # Auth.js v5 config
│       ├── security/
│       │   └── tenant-context.ts   # RLS context helpers
│       └── llm/
│           ├── provider.ts     # LLMProvider interface
│           ├── stub-provider.ts # Deterministic stub (default)
│           └── index.ts        # Factory + singleton
├── tests/
│   └── unit/
│       ├── health.test.ts
│       ├── llm-provider.test.ts
│       └── meta.test.ts
├── docs/
│   ├── adr/                    # Architecture Decision Records
│   │   ├── ADR-0001-stack-selection.md
│   │   ├── ADR-0002-llm-provider-abstraction.md
│   │   └── ADR-0003-tenant-isolation.md
│   └── mission-reports/G00/
│       └── 00-01_REPORT.md     # This mission's report
├── .github/workflows/ci.yml    # GitHub Actions: lint + typecheck + test
├── docker-compose.yml          # PostgreSQL 16 + pgvector
├── .env.example                # Template — safe to commit
└── .gitignore
```

## License

**To be determined by the founder.** No license file is present until the founder explicitly chooses one.

## Security

- Never commit `.env` — it's gitignored.
- The `AUTH_SECRET` in `.env.example` is a placeholder; generate a real one.
- Audit logs are append-only; RLS policies (mission 00-03) will enforce this at the DB level.
- See `docs/adr/ADR-0003-tenant-isolation.md` for the tenant isolation design.
