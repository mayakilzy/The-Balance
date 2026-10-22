# ADR-0012 — Security Hardening Design

**Date:** 2026-10-16
**Status:** Accepted
**Mission:** 00-09

## Context

After proving the platform works end-to-end (00-08), mission 00-09 hardens the security posture and adds observability without introducing complex monitoring infrastructure.

## Decisions

### 1. Security Headers + CSP (middleware.ts)

All responses include:
- `Content-Security-Policy`: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-XSS-Protection: 1; mode=block`
- `Permissions-Policy: geolocation=(), microphone=(), camera=()`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`

**Note**: `'unsafe-inline'` and `'unsafe-eval'` are needed for Next.js dev mode. Production should use nonces (deferred to production deployment).

### 2. Rate Limiting (in-memory, per-IP)

- `/api/v1/auth/signin`: 10 requests/minute
- `/api/v1/auth/signout`: 10 requests/minute
- `/api/v1/tasks` (POST): 30 requests/minute
- `/api/v1/capabilities` (POST): 20 requests/minute

**Limitation**: In-memory store is per-process. Multi-instance production needs Redis. Documented as deferred.

### 3. API Error Sanitization (error-sanitizer.ts)

- Operational errors (not found, permission denied, validation) → shown directly
- Unexpected errors → generic "Request failed" with sanitized detail
- Strips: file paths, SQL fragments, connection strings, env var names, stack traces
- Truncates to 300 chars

### 4. Structured Logging with Redaction

- `redactSensitive()`: removes password, token, secret, apiKey, authorization, cookie, session from log payloads
- `createRequestLogger()`: child logger with requestId + tenantId correlation
- `logSecurityEvent()` + `logDeniedAccess()`: dedicated security event logging

### 5. Basic Metrics (in-process)

- Request count, error count, total latency, failed tasks, rate-limited requests
- `GET /api/v1/_metrics`: requires `audit:read` permission
- **Limitation**: In-process only; multi-instance needs Prometheus/StatsD. Documented as deferred.

### 6. Demo Credentials Safety

- `SHOW_DEMO_CREDENTIALS` env var (default: "false")
- Only shows test credentials on login page when explicitly set to "true"
- NOT tied to NODE_ENV (a dev environment could be publicly accessible)

### 7. Browser Journey Enhancement

- Playwright test now verifies that the task detail panel shows the exact goal text of the created task

## What is proven

- Security headers are applied to all routes
- Rate limiting prevents abuse of auth + task creation + capability invocation
- API errors don't leak internal details (file paths, SQL, env vars)
- Sensitive data is redacted from logs
- Audit log stores ipHash (not raw IP)
- Audit log is append-only (REVOKE UPDATE/DELETE)
- RBAC negative tests: observer cannot write tasks, analyst cannot delete evidence

## What is deferred to production

- CSP nonces (instead of unsafe-inline)
- Redis-based rate limiting (multi-instance)
- Prometheus/Grafana metrics (instead of in-process)
- OpenTelemetry distributed tracing
- WAF (Web Application Firewall)
- DDoS protection (Cloudflare or similar)
- Secret rotation pipeline
- Penetration testing
- Security audit (external)

## Verification

- Error sanitizer tests: 8 unit tests
- Sensitive data redaction tests: 4 unit tests
- Security integration tests: 4 tests (RBAC negative, audit log integrity)
- Total new tests: 16
