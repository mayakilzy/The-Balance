// ============================================================
// tests/unit/health.test.ts — Smoke test for /api/health
// ------------------------------------------------------------
// Tests the route handler directly (no HTTP server needed).
// Covers:
//   1. Positive case: DB reachable → 200, status="ok"
//   2. Negative case: DB unreachable → 503, status="degraded"
//   3. Audit log is written on each call
// ============================================================
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { GET } from "@/app/api/health/route";

// Mock the database so tests don't need a real Postgres.
const mockQueryRaw = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

// Capture audit writes without hitting the DB.
const mockAuditWrite = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  writeAudit: (...args: unknown[]) => mockAuditWrite(...args),
}));

// Mock env so tests don't depend on a .env file.
vi.mock("@/lib/env", () => ({
  env: {
    APP_NAME: "The Balance",
    APP_VERSION: "0.0.1-test",
    NODE_ENV: "test",
    AUTH_SECRET: "test-secret-min-16-chars",
    LLM_PROVIDER: "stub",
    LOG_LEVEL: "warn",
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("returns 200 with status=ok when DB is reachable", async () => {
    // Arrange: DB ping succeeds
    mockQueryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);

    // Act
    const request = new Request("http://localhost/api/health");
    const response = await GET(request);
    const body = await response.json();

    // Assert: response
    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.0.1-test");
    expect(body.env).toBe("test");
    expect(body.checks).toHaveLength(2);
    expect(body.checks[0].name).toBe("database");
    expect(body.checks[0].status).toBe("ok");
    expect(body.checks[1].name).toBe("llm");
    expect(body.checks[1].status).toBe("ok");

    // Assert: audit was written
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    const auditCall = mockAuditWrite.mock.calls[0]?.[0];
    expect(auditCall.action).toBe("health.check");
    expect(auditCall.status).toBe("ok");
  });

  it("returns 503 with status=degraded when DB is unreachable", async () => {
    // Arrange: DB ping throws
    mockQueryRaw.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    // Act
    const request = new Request("http://localhost/api/health");
    const response = await GET(request);
    const body = await response.json();

    // Assert: response
    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks[0].name).toBe("database");
    expect(body.checks[0].status).toBe("down");
    expect(body.checks[0].detail).toContain("ECONNREFUSED");

    // Assert: audit recorded the error
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    const auditCall = mockAuditWrite.mock.calls[0]?.[0];
    expect(auditCall.status).toBe("error");
  });

  it("includes timestamp in ISO format", async () => {
    mockQueryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    const request = new Request("http://localhost/api/health");
    const response = await GET(request);
    const body = await response.json();

    // Should parse as valid ISO date
    const parsed = new Date(body.time);
    expect(parsed.toString()).not.toBe("Invalid Date");
    expect(parsed.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
