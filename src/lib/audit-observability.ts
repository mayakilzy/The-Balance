// ============================================================
// observability.ts — Enhanced structured logging with request/trace IDs
// ------------------------------------------------------------
// Extends the pino logger with:
//   - Request ID correlation
//   - Tenant context
//   - Sensitive data redaction
//   - Basic metrics collection
// ============================================================
import { childLogger } from "@/lib/observability";

// ============================================================
// REQUEST-SCOPED LOGGER
// ============================================================

export function createRequestLogger(requestId: string, tenantId?: string | null) {
  return childLogger({
    requestId,
    tenantId: tenantId ?? undefined,
  });
}

// ============================================================
// SENSITIVE DATA REDACTION
// ============================================================

const SENSITIVE_KEYS = [
  "password",
  "passwordhash",
  "token",
  "apitoken",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "session",
];

export function redactSensitive(data: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.some((s) => key.toLowerCase().includes(s))) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      redacted[key] = redactSensitive(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

// ============================================================
// BASIC METRICS (re-exported from metrics.ts)
// ------------------------------------------------------------
// The counter state lives in metrics.ts which has NO pino / Node.js
// dependency, so it is safe to import from Next.js middleware (edge
// runtime). This module re-exports the same functions for backwards
// compatibility with existing callers and tests.
// ============================================================
export {
  recordRequest,
  recordApiError,
  recordFailedTask,
  recordRateLimitedRequest,
  getMetrics,
  __resetMetricsForTesting,
} from "@/lib/metrics";

// ============================================================
// SECURITY AUDIT HELPERS
// ============================================================

const securityLog = childLogger({ module: "security" });

export function logSecurityEvent(
  event: string,
  details: Record<string, unknown>
): void {
  securityLog.warn(
    {
      event,
      ...redactSensitive(details),
    },
    `SECURITY_EVENT: ${event}`
  );
}

export function logDeniedAccess(
  route: string,
  method: string,
  reason: string,
  requestId?: string
): void {
  securityLog.warn(
    {
      event: "access_denied",
      route,
      method,
      reason,
      requestId,
    },
    `ACCESS_DENIED: ${reason} on ${method} ${route}`
  );
}
