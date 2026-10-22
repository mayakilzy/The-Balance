// ============================================================
// metrics.test.ts — Unit tests for in-process metrics counters
// ------------------------------------------------------------
// Verifies that counters actually move when the wiring functions
// are called — closing 00-09 Gap 3.
// ============================================================
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordRequest,
  recordApiError,
  recordFailedTask,
  recordRateLimitedRequest,
  getMetrics,
  __resetMetricsForTesting,
} from "@/lib/metrics";

describe("Metrics counters", () => {
  beforeEach(() => {
    __resetMetricsForTesting();
  });

  it("recordRequest increments requestCount + accumulates latency", () => {
    recordRequest(10, false);
    recordRequest(25, false);
    const m = getMetrics();
    expect(m.requestCount).toBe(2);
    expect(m.totalLatencyMs).toBe(35);
    expect(m.avgLatencyMs).toBe(18); // round(35/2)
    expect(m.errorCount).toBe(0);
    expect(m.errorRate).toBe(0);
  });

  it("recordRequest with isError increments both requestCount and errorCount", () => {
    recordRequest(5, false);
    recordRequest(8, true); // a 429 from middleware
    recordRequest(3, false);
    const m = getMetrics();
    expect(m.requestCount).toBe(3);
    expect(m.errorCount).toBe(1);
    expect(m.errorRate).toBeCloseTo(33.333, 1);
  });

  it("recordApiError increments errorCount WITHOUT re-counting the request", () => {
    // Simulate a real wiring: middleware counts the request, then route
    // catch block calls recordApiError to mark it as a 5xx.
    recordRequest(15, false);
    recordApiError();
    const m = getMetrics();
    expect(m.requestCount).toBe(1); // counted once by middleware
    expect(m.errorCount).toBe(1); // marked as error by route
    expect(m.errorRate).toBe(100);
  });

  it("recordFailedTask increments failedTasks (single source of truth)", () => {
    expect(getMetrics().failedTasks).toBe(0);
    recordFailedTask();
    recordFailedTask();
    expect(getMetrics().failedTasks).toBe(2);
  });

  it("recordRateLimitedRequest increments rateLimitedRequests", () => {
    expect(getMetrics().rateLimitedRequests).toBe(0);
    recordRateLimitedRequest();
    recordRateLimitedRequest();
    recordRateLimitedRequest();
    expect(getMetrics().rateLimitedRequests).toBe(3);
  });

  it("getMetrics returns a snapshot, not a live reference", () => {
    recordRequest(5, false);
    const snap = getMetrics();
    recordRequest(5, false);
    expect(snap.requestCount).toBe(1); // unchanged
    expect(getMetrics().requestCount).toBe(2); // fresh read
  });

  it("avgLatencyMs rounds correctly and handles zero-request case", () => {
    expect(getMetrics().avgLatencyMs).toBe(0);
    recordRequest(7, false);
    recordRequest(8, false);
    // (7+8)/2 = 7.5 → rounds to 8
    expect(getMetrics().avgLatencyMs).toBe(8);
  });

  it("__resetMetricsForTesting zeroes everything", () => {
    recordRequest(10, true);
    recordFailedTask();
    recordRateLimitedRequest();
    __resetMetricsForTesting();
    const m = getMetrics();
    expect(m.requestCount).toBe(0);
    expect(m.errorCount).toBe(0);
    expect(m.failedTasks).toBe(0);
    expect(m.rateLimitedRequests).toBe(0);
    expect(m.totalLatencyMs).toBe(0);
  });

  it("real-world wiring simulation: traffic + failure + rate-limit", () => {
    // 1. Three successful requests pass through middleware
    recordRequest(10, false);
    recordRequest(15, false);
    recordRequest(20, false);

    // 2. A route throws — middleware already counted the request,
    //    route catch block marks it as error
    recordApiError();

    // 3. A task transitions to failed
    recordFailedTask();

    // 4. Rate limit triggered for one request
    recordRequest(2, true);
    recordRateLimitedRequest();

    const m = getMetrics();
    expect(m.requestCount).toBe(4); // 3 successful + 1 rate-limited
    expect(m.errorCount).toBe(2); // 1 route error + 1 rate-limit (marked as error in middleware)
    expect(m.failedTasks).toBe(1);
    expect(m.rateLimitedRequests).toBe(1);
    expect(m.totalLatencyMs).toBe(47); // 10+15+20+2
  });
});
