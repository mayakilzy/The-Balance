# THE BALANCE — Operations Runbook

**Mission 00-10 deliverable:** Fresh install, operation, and recovery procedures.

This runbook documents how to install The Balance from a clean repository clone, operate it, and recover from failures. It is the single source of truth for deployment and recovery procedures.

---

## 1. Fresh Install

### Prerequisites

- **PostgreSQL 16** with **pgvector** extension installed
- **Bun 1.3.14+** (runtime)
- **Node.js 22+** (for Prisma CLI compatibility)
- Git access to `mayakilzy/The-Balance` repository

### 1.1 Clone the repository

```bash
git clone https://github.com/mayakilzy/The-Balance.git
cd The-Balance
bun install --frozen-lockfile
```

### 1.2 Provision PostgreSQL

Create a fresh PostgreSQL 16 database with pgvector:

```bash
# Using Docker (local dev):
docker run -d \
  --name balance-pg \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=<your-strong-password> \
  -e POSTGRES_DB=balance \
  -p 5432:5432 \
  pgvector/pgvector:pg16

# Or using a managed PostgreSQL 16 instance — ensure pgvector extension is available.
```

### 1.3 Configure environment

Copy `.env.example` to `.env` and fill in real values:

```bash
cp .env.example .env
```

**Required environment variables:**

| Variable | Purpose | Example |
|----------|---------|---------|
| `DATABASE_URL` | App runtime connection (balance_app role, RLS-enforced) | `postgresql://balance_app:***@host:5432/balance?schema=public` |
| `DIRECT_URL` | Migrations + seed (balance_admin role, BYPASSRLS) | `postgresql://balance_admin:***@host:5432/balance?schema=public` |
| `AUTH_DATABASE_URL` | Auth bootstrap (balance_auth role, read-only) | `postgresql://balance_auth:***@host:5432/balance?schema=public` |
| `AUTH_SECRET` | JWT signing secret (min 16 chars) | Generate with `openssl rand -base64 32` |
| `AUTH_TRUST_HOST` | Trust the Host header | `true` (behind proxy) / `false` |
| `TRUSTED_PROXY` | Honor x-forwarded-for for rate limiting | `true` (behind known proxy) / `false` (default) |
| `LLM_PROVIDER` | LLM backend | `stub` (default, simulated) / `zai` / `openai` / `anthropic` |
| `LOG_LEVEL` | Pino log level | `info` / `warn` / `error` |
| `SHOW_DEMO_CREDENTIALS` | Show test credentials on login page | `true` (dev only) / `false` (prod) |

### 1.4 Set up database roles

The Balance uses three PostgreSQL roles with distinct privilege levels (ADR-0005):

```bash
# Set passwords via env vars (DO NOT use dev defaults in production)
export PGPASSWORD_BALANCE_ADMIN="<strong-password>"
export PGPASSWORD_BALANCE_APP="<strong-password>"
export PGPASSWORD_BALANCE_AUTH="<strong-password>"
export PGPASSWORD_POSTGRES="<postgres-superuser-password>"

bash scripts/run-setup-roles.sh
```

This creates:
- `balance_admin` — BYPASSRLS, used for migrations + seed only
- `balance_app` — RLS-enforced, used by the application at runtime
- `balance_auth` — read-only, used by Auth.js bootstrap

### 1.5 Run migrations

```bash
bunx prisma migrate deploy
```

This applies all 16 migrations in order, creating:
- 6 PUBLIC tables (countries, state_hierarchy, institutions, role_references, sources, capabilities)
- 14 PRIVATE tables (tenants, users, memberships, audit_log, evidence, evidence_embeddings, strategies, strategy_versions, decisions, decision_events, events, tasks, task_events, capability_invocations)
- RLS policies on all PRIVATE tables
- Triggers for hierarchy integrity, immutability, and append-only enforcement

### 1.6 Seed ontology

```bash
bun run db:seed
```

This creates the Demolandia fictional fixture:
- 1 country (Demolandia, ISO3: DML)
- 2 tenants (DML-MOP-TENANT, DML-CB-TENANT)
- 4 users (admin, analyst, suspended, revoked — all @demolandia.test)
- 4 role references (admin, analyst, reviewer, observer)
- 3 state hierarchy nodes (nation + 2 provinces)
- 2 institutions
- 3 sources (World Bank, IMF, UN Statistics)
- Capabilities are NOT seeded here — they are registered by integration tests

### 1.7 Verify installation

```bash
bash scripts/fresh-install-verify.sh
```

This script verifies:
- Database started empty, all 16 migrations applied
- Seed data present with expected counts
- RLS enabled on all 14 private tables
- `balance_app` has no superuser / no bypassrls
- `audit_log` is append-only (no UPDATE/DELETE for balance_app)

### 1.8 Start the application

```bash
bun run dev    # Development (port 3000)
bun run build && bun run start   # Production
```

Verify health: `curl http://localhost:3000/api/health` → `{"status":"ok"}`

---

## 2. Operation

### 2.1 Health monitoring

- **Liveness + readiness:** `GET /api/health` — checks DB connectivity + LLM provider health
- **Metrics:** `GET /api/v1/_metrics` — requires `audit:read` permission (admin/reviewer/analyst roles)
  - Returns: `requestCount`, `errorCount`, `avgLatencyMs`, `failedTasks`, `rateLimitedRequests`, `errorRate`

### 2.2 Metrics boundaries (known limitation)

**Important:** Metrics counters are **in-process and local to the current Node.js process**. In the current single-instance deployment:

- **Middleware and API route handlers share the same process** → metrics are aggregated correctly.
- In a **multi-instance deployment** (e.g., multiple Next.js workers behind a load balancer), each process has its own counters. `/api/v1/_metrics` would only reflect traffic to that specific instance.

**Resolution for production:** Deploy an external metrics aggregator (Prometheus + Grafana) before scaling to multiple instances. This is deferred to post-GROUP-00.

### 2.3 Logging

Logs are structured JSON (pino) with:
- `requestId` for tracing (set by middleware via `X-Request-Id` header)
- `tenantId` for tenant correlation
- Sensitive data redaction at two layers:
  1. **HTTP responses:** `buildApiErrorResponse()` returns generic "Internal server error" for unexpected errors — no `detail` field
  2. **Server logs:** `sanitizeForLog()` strips secrets (passwords, tokens, API keys, connection strings) from `errMsg` + `errStack` before pino logging

### 2.4 Rate limiting

In-memory, per-IP rate limiting in middleware:
- `/api/v1/auth/signin`: 10 POST/minute per IP
- `/api/v1/auth/signout`: 10 POST/minute per IP
- `/api/v1/tasks`: 30 POST/minute per IP
- `/api/v1/capabilities`: 20 POST/minute per IP

**Trust policy:** When `TRUSTED_PROXY=false` (default), `x-forwarded-for` is NEVER trusted — all clients share a single "unknown" rate-limit bucket. Set `TRUSTED_PROXY=true` only when deployed behind a known reverse proxy that overwrites `x-forwarded-for`.

---

## 3. Recovery

### 3.1 Application restart (data persistence)

The application is stateless — all state lives in PostgreSQL. Restarting the Next.js process does NOT lose data.

**Verification:**
```bash
bash scripts/restart-verify.sh
```

This script:
1. Starts the server
2. Logs in + creates a task via API
3. Stops the server (SIGTERM)
4. Starts a NEW server instance
5. Verifies the task is still accessible

### 3.2 Task worker crash + reclaim

If a task worker crashes mid-execution, the lease will expire and the task is automatically reclaimed:

1. Worker claims a task with a lease (default: 60 seconds)
2. If the worker crashes, the lease expires
3. `reclaimStaleTasks()` finds tasks with `leaseExpiresAt < NOW()` and resets them to `pending`
4. A new worker can claim the task — `claimGeneration` increments (fencing token)
5. The stale worker's `claimGeneration` no longer matches → any attempt to complete/fail is rejected

**Verification:** See `tests/integration/recovery.integration.test.ts` → "Task Worker Crash + Reclaim"

### 3.3 Database backup

**Logical backup (recommended for GROUP-00):**
```bash
pg_dump -h <host> -p 5432 -U postgres -d balance \
  --format=custom \
  --no-owner \
  --file=balance-backup-$(date +%Y%m%d-%H%M%S).dump
```

**Important:** Do NOT use `--no-privileges` — RLS policies are classified as privileges in PostgreSQL, and using this flag would strip them from the backup, making the restored database insecure.

**What is included:**
- All table data (PUBLIC + PRIVATE)
- Schema definitions
- RLS policies (ENABLE + FORCE ROW LEVEL SECURITY)
- Triggers
- Indexes
- Column-level grants

**What is NOT included (cluster-level, must be re-created):**
- Database roles (balance_admin, balance_app, balance_auth)
- Role password — stored as env vars, not in the database

**Backup schedule recommendation:**
- Daily full backup (retained 30 days)
- Continuous WAL archiving for point-in-time recovery (production)

### 3.4 Database restore

**Restore from logical backup:**
```bash
# 1. Drop the existing database (if present)
psql -h <host> -U postgres -d postgres -c "DROP DATABASE IF EXISTS balance;"

# 2. Recreate empty database
psql -h <host> -U postgres -d postgres -c "CREATE DATABASE balance;"

# 3. Restore from backup
pg_restore -h <host> -U postgres -d balance \
  --no-owner \
  --clean \
  --if-exists \
  balance-backup-YYYYMMDD-HHMMSS.dump

# 4. Re-create roles (NOT in the backup — cluster-level)
export PGPASSWORD_BALANCE_ADMIN="..."
export PGPASSWORD_BALANCE_APP="..."
export PGPASSWORD_BALANCE_AUTH="..."
bash scripts/run-setup-roles.sh

# 5. Verify
bash scripts/fresh-install-verify.sh
```

**Verification drill:**
```bash
bash scripts/backup-restore-test.sh
```

This script performs the full round-trip: backup → drop → restore → verify data + RLS + privileges.

### 3.5 Recovery from total environment loss

If the entire environment is lost (server + database), recovery procedure:

1. **Provision new PostgreSQL 16 + pgvector instance**
2. **Clone the repository:**
   ```bash
   git clone https://github.com/mayakilzy/The-Balance.git
   cd The-Balance
   bun install --frozen-lockfile
   ```
3. **Configure `.env`** with new database credentials + `AUTH_SECRET`
4. **Set up roles:**
   ```bash
   export PGPASSWORD_BALANCE_ADMIN="..."
   export PGPASSWORD_BALANCE_APP="..."
   export PGPASSWORD_BALANCE_AUTH="..."
   bash scripts/run-setup-roles.sh
   ```
5. **Restore database from backup** (Section 3.4)
6. **Verify installation:**
   ```bash
   bash scripts/fresh-install-verify.sh
   ```
7. **Start the application:**
   ```bash
   bun run build && bun run start
   ```

**Estimated recovery time:** 15-30 minutes (assuming backup is available).

---

## 4. CI Verification

The `fresh-install-recovery.yml` GitHub Actions workflow runs on every push and verifies:

| Phase | Test | Script |
|-------|------|--------|
| 1 | Fresh install from empty DB | `scripts/fresh-install-verify.sh` |
| 2 | Recovery integration tests | `tests/integration/recovery.integration.test.ts` |
| 3 | Application restart + data persistence | `scripts/restart-verify.sh` |
| 4 | Database backup/restore drill | `scripts/backup-restore-test.sh` |
| 5 | Full test suite on restored DB | `bunx vitest run` |
| 6 | Production build | `bun run build` |

All phases must pass for the workflow to succeed.

---

## 5. Security Boundaries (current state)

| Boundary | Status | Notes |
|----------|--------|-------|
| Tenant isolation (RLS) | ✅ Enforced | All PRIVATE tables have `ENABLE + FORCE ROW LEVEL SECURITY` |
| RBAC/ABAC | ✅ Enforced | `requirePermissionWithCurrentRole` checks CURRENT DB role (not stale JWT) |
| Audit log append-only | ✅ Enforced | `REVOKE UPDATE, DELETE` from `balance_app` |
| API error sanitization | ✅ Enforced | `buildApiErrorResponse()` — no `detail` field for unexpected errors |
| Log sanitization | ✅ Enforced | `sanitizeForLog()` strips secrets before pino logging |
| Rate limiting | ✅ Enforced | In-memory, per-IP, with `TRUSTED_PROXY` gating |
| CSP + security headers | ✅ Enforced | Set by middleware on all routes |
| Password hashing | ✅ Enforced | bcrypt cost factor 12 |
| IP privacy | ✅ Enforced | `audit_log.ipHash` stores SHA-256 (salted), never raw IP |

### Deferred gaps (post-GROUP-00)

- **Distributed metrics:** Current counters are in-process; need Prometheus for multi-instance
- **External rate limit store:** Current store is in-memory; need Redis for multi-instance
- **WAL archiving:** Not configured; needed for point-in-time recovery in production
- **Secrets management:** Passwords are env vars; consider Vault/SOPS for production
