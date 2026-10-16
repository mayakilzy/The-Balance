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
// BASIC METRICS (in-process, simple)
// ============================================================

interface Metrics {
  requestCount: number;
  errorCount: number;
  totalLatencyMs: number;
  failedTasks: number;
  rateLimitedRequests: number;
}

const metrics: Metrics = {
  requestCount: 0,
  errorCount: 0,
  totalLatencyMs: 0,
  failedTasks: 0,
  rateLimitedRequests: 0,
};

export function recordRequest(latencyMs: number, isError: boolean): void {
  metrics.requestCount++;
  metrics.totalLatencyMs += latencyMs;
  if (isError) metrics.errorCount++;
}

export function recordFailedTask(): void {
  metrics.failedTasks++;
}

export function recordRateLimitedRequest(): void {
  metrics.rateLimitedRequests++;
}

export function getMetrics() {
  return {
    ...metrics,
    avgLatencyMs: metrics.requestCount > 0 ? Math.round(metrics.totalLatencyMs / metrics.requestCount) : 0,
    errorRate: metrics.requestCount > 0 ? (metrics.errorCount / metrics.requestCount) * 100 : 0,
  };
}

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
