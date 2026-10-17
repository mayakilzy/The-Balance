# GROUP 00 — Known Limitations

**Mission 00-11 deliverable.** Honest inventory of limitations, deferred capabilities, and non-blocking gaps. None of these are blocking for GROUP 01 entry.

---

## 1. LLM Provider — Stub Only (SIMULATED)

**Status:** By design (ADR-0002). Not a defect.

The platform ships with `StubProvider` as the default LLM. It returns deterministic, clearly-labeled SIMULATED responses. The `LLMProvider` interface (`src/lib/llm/provider.ts`) is ready for real providers (zai, openai, anthropic) but no production adapter is implemented.

**Evidence of honesty:**
- API responses include `simulated: true` field
- UI shows "SIMULATED" notice on home page and task detail
- `meta` endpoint reports `llm.provider: "stub"`
- Health endpoint reports LLM provider status

**What GROUP 01 must do:** Implement at least one real `ExpertAdapter` backed by a real LLM provider before claiming live intelligence capabilities.

---

## 2. Metrics — In-Process, Single-Instance Only

**Status:** Known limitation, documented in RUNBOOK §2.2.

Metrics counters (`src/lib/metrics.ts`) live in Node.js process memory. In the current single-instance deployment, middleware and API route handlers share the same process, so `/api/v1/_metrics` is reliable.

**Limitations:**
- Counters reset to zero on every process restart
- Multi-instance deployments (PM2 cluster, multiple containers) would see per-instance counters, NOT aggregated
- No persistence — historical metrics are lost on restart

**What GROUP 01+ must do:** Deploy Prometheus + Grafana before scaling to multiple instances. The `recordRequest`, `recordApiError`, `recordFailedTask`, `recordRateLimitedRequest` functions are the single wiring points.

---

## 3. Rate Limiting — In-Memory, Single-Instance

**Status:** Known limitation.

Rate limit store (`src/middleware.ts`) is an in-memory `Map`. Same single-instance constraint as metrics.

**Limitations:**
- Limits reset on restart
- Multi-instance: each instance has independent limits

**What GROUP 01+ must do:** Use Redis (or equivalent) for distributed rate limiting before multi-instance.

---

## 4. No WAL Archiving / Point-in-Time Recovery

**Status:** Deferred to production hardening.

The backup/restore drill (`scripts/backup-restore-test.sh`) proves logical backup (`pg_dump`) + restore works. But point-in-time recovery (PITR) requires WAL archiving, which is not configured.

**What production must do:** Configure `archive_mode = on` + `archive_command` to ship WAL segments to durable storage. Consider pgBackRest or cloud-managed PITR.

---

## 5. No Mission Reports for 00-02 through 00-10

**Status:** Documentation gap, non-blocking.

Only `docs/mission-reports/G00/00-01_REPORT.md` exists on disk. Missions 00-02 through 00-10 delivered their evidence via commits, CI runs, and the worklog — but did not produce standalone mission report files.

**Impact:** None functional. The Acceptance Matrix consolidates all evidence. The worklog at `/home/z/my-project/worklog.md` contains the full chronological record.

---

## 6. `.env.example` Was Missing `AUTH_DATABASE_URL`

**Status:** Fixed in 00-11.

The `.env.example` file did not declare `AUTH_DATABASE_URL` despite it being required for the `balance_auth` role (used by Auth.js bootstrap). Both CI workflows defined it, but a user following `.env.example` alone would miss it.

**Fix:** 00-11 commit adds `AUTH_DATABASE_URL` to `.env.example` with documentation.

---

## 7. balance_admin Has SUPERUSER in CI Only

**Status:** By design, documented in CI workflow.

Migration 0002 includes `ALTER ROLE` statements that require `CREATEROLE` or `SUPERUSER`. In CI, `balance_admin` is granted `SUPERUSER` to allow `CREATE EXTENSION` + `ALTER ROLE`. In production, `balance_admin` is `NOSUPERUSER` and extensions/role-alterations are pre-provisioned.

**Impact:** CI environment differs from production in this specific privilege. The `fresh-install-verify.sh` script checks `balance_app` (not `balance_admin`) for superuser status, which is the security-relevant check.

---

## 8. No External Secrets Management

**Status:** Deferred to production hardening.

Database role passwords are passed via environment variables. `AUTH_SECRET` is also an env var. No Vault, SOPS, or cloud KMS integration.

**What production must do:** Use a secrets manager (HashiCorp Vault, AWS Secrets Manager, SOPS+age) for all credentials.

---

## 9. No Distributed Tracing

**Status:** Deferred.

Request IDs are generated in middleware and passed via `X-Request-Id` header + pino log context. But there is no OpenTelemetry / Jaeger / Zipkin integration for distributed tracing across services.

**What GROUP 01+ must do:** Add OpenTelemetry instrumentation if the platform expands to multiple services.

---

## 10. Single-Region, Single-AZ Deployment

**Status:** Out of scope for GROUP 00.

The RUNBOOK describes single-instance deployment. No multi-AZ failover, no read replicas, no geographic distribution.

**What production must do:** Design for the target country's availability requirements. PostgreSQL streaming replication + a hot standby is the minimum for government-grade availability.

---

## 11. No Automated Backup Schedule

**Status:** RUNBOOK documents the procedure; no cron/scheduler configured.

`scripts/backup-restore-test.sh` proves the backup/restore mechanism works. But no cron job, systemd timer, or Kubernetes CronJob is configured to run backups on a schedule.

**What production must do:** Schedule daily `pg_dump` (or use pgBackRest for incremental backups). Retain 30 days minimum. Test restores quarterly.

---

## 12. Arabic UI — Not All Strings Localized

**Status:** UI is RTL and Arabic-first, but some technical terms remain in English.

The UI layout is RTL (`dir="rtl"`, `lang="ar"`). Core user-facing labels are in Arabic. Technical terms (e.g., "SIMULATED", "Stub", API status codes) remain in English for clarity.

**What GROUP 01+ must do:** Full i18n framework (next-intl or similar) if multi-language support is required beyond Arabic + English technical terms.

---

## 13. No Rate Limit on GET Requests

**Status:** By design, acceptable for GROUP 00.

Rate limiting in middleware only applies to `POST`, `PUT`, `DELETE`. `GET` requests are unlimited. This is acceptable because GETs are read-only and the platform is single-instance.

**What production must do:** Add GET rate limiting (especially on expensive endpoints like `/api/v1/evidence/search`) if abuse becomes a concern.

---

## 14. CSP Allows `unsafe-inline` and `unsafe-eval` for Scripts

**Status:** Pragmatic compromise for Next.js.

The Content-Security-Policy in middleware includes `script-src 'self' 'unsafe-inline' 'unsafe-eval'` because Next.js App Router requires these for hydration and React Server Components.

**What production must do:** Tighten CSP with nonces (Next.js supports `nonce` in CSP) before production. This is a hardening step, not a functional gap.

---

## Summary Table

| # | Limitation | Blocking G01? | Severity |
|---|-----------|---------------|----------|
| 1 | LLM is Stub only | No (by design) | Info |
| 2 | Metrics in-process | No | Medium (pre-scale) |
| 3 | Rate limit in-memory | No | Medium (pre-scale) |
| 4 | No WAL archiving | No | Medium (prod) |
| 5 | Missing mission reports | No | Low (docs) |
| 6 | `.env.example` gap | Fixed in 00-11 | Resolved |
| 7 | balance_admin SUPERUSER in CI | No (by design) | Info |
| 8 | No secrets management | No | Medium (prod) |
| 9 | No distributed tracing | No | Low |
| 10 | Single-region | No | Medium (prod) |
| 11 | No backup schedule | No | Medium (prod) |
| 12 | Partial i18n | No | Low |
| 13 | No GET rate limiting | No | Low |
| 14 | CSP allows unsafe-inline | No | Low (prod hardening) |

**Verdict:** None of these limitations block GROUP 01 entry. They are documented for production hardening and scaling phases.
