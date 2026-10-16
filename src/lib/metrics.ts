// ============================================================
// metrics.ts — In-process operational metrics counters
// ------------------------------------------------------------
// Deliberately has NO dependency on pino or any Node.js built-in
// so it is safe to import from Next.js middleware (edge runtime).
//
// Counters are local to the current process. In a multi-instance
// deployment they are NOT aggregated — see ADR-0012 (deferred).
// For GROUP 00 single-instance verification they are sufficient.
//
// Wiring (00-09 closure):
//   - recordRequest          → middleware (every request)
//   - recordRateLimitedRequest → middleware (on 429)
//   - recordApiError         → route catch blocks (5xx only)
//   - recordFailedTask       → task-service.failTask (single point)
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

/**
 * Record a request that passed through middleware.
 * Called once per request from middleware.
 *
 * @param latencyMs  Wall-clock latency observed by middleware (best-effort)
 * @param isError    True if middleware itself returned an error response
 *                   (e.g. 429 rate-limit). Route-level errors are recorded
 *                   separately via recordApiError to avoid double-counting
 *                   the request itself.
 */
export function recordRequest(latencyMs: number, isError: boolean): void {
  metrics.requestCount++;
  metrics.totalLatencyMs += Math.max(0, Math.round(latencyMs));
  if (isError) metrics.errorCount++;
}

/**
 * Record a route-level error (5xx).
 * Called from API route catch blocks. Does NOT increment requestCount
 * because middleware already counted the request.
 */
export function recordApiError(): void {
  metrics.errorCount++;
}

/**
 * Record a task that transitioned to status=failed.
 * Called once per failure from task-service.failTask (single source).
 */
export function recordFailedTask(): void {
  metrics.failedTasks++;
}

/**
 * Record a request that was rejected by rate limiting (HTTP 429).
 * Called from middleware when it returns a 429 response.
 */
export function recordRateLimitedRequest(): void {
  metrics.rateLimitedRequests++;
}

/**
 * Read the current metrics snapshot.
 * Used by /api/v1/_metrics for operational monitoring.
 */
export function getMetrics() {
  return {
    requestCount: metrics.requestCount,
    errorCount: metrics.errorCount,
    totalLatencyMs: metrics.totalLatencyMs,
    failedTasks: metrics.failedTasks,
    rateLimitedRequests: metrics.rateLimitedRequests,
    avgLatencyMs:
      metrics.requestCount > 0
        ? Math.round(metrics.totalLatencyMs / metrics.requestCount)
        : 0,
    errorRate:
      metrics.requestCount > 0
        ? (metrics.errorCount / metrics.requestCount) * 100
        : 0,
  };
}

/**
 * Reset all counters to zero. TEST-ONLY — exposed for vitest setup
 * so tests can verify counter deltas in isolation. Never call from
 * application code.
 */
export function __resetMetricsForTesting(): void {
  metrics.requestCount = 0;
  metrics.errorCount = 0;
  metrics.totalLatencyMs = 0;
  metrics.failedTasks = 0;
  metrics.rateLimitedRequests = 0;
}
