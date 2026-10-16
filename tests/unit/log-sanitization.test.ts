// ============================================================
// log-sanitization.test.ts — Secrets never reach pino logs
// ------------------------------------------------------------
// Closes the final 00-09 review point: buildApiErrorResponse()
// must sanitize errMsg + errStack BEFORE logging to pino, so that
// PostgreSQL connection strings with passwords, Bearer tokens,
// API keys, etc. never persist to disk/stdout via the logger.
//
// Approach: mock @/lib/observability so childLogger() returns a
// mock whose .error() is a vi.fn capturing the logged payload.
// Then assert the captured payload does NOT contain raw secrets.
// ============================================================
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock setup ---
// vi.hoisted ensures the mock fn exists before the vi.mock factory runs.
const { mockError } = vi.hoisted(() => ({
  mockError: vi.fn(),
}));

vi.mock("@/lib/observability", () => ({
  childLogger: vi.fn(() => ({
    error: mockError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => ({
      error: mockError,
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    })),
  })),
}));

// Import AFTER mock is hoisted
import { buildApiErrorResponse, sanitizeForLog } from "@/lib/error-sanitizer";

// ============================================================
// sanitizeForLog — pure function tests
// ============================================================
describe("sanitizeForLog — strips secrets from free-text", () => {
  it("strips PostgreSQL connection string with password", () => {
    const input = "Connection failed: postgresql://app:s3cretPass@10.0.0.5:5432/balance";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("s3cretPass");
    expect(result).toContain("***@");
    // Host preserved for diagnosis
    expect(result).toContain("10.0.0.5:5432");
  });

  it("strips MySQL connection string with password", () => {
    const input = "mysql://root:dbpass123@db.internal:3306/prod";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("dbpass123");
    expect(result).toContain("***@");
  });

  it("strips MongoDB connection string with password", () => {
    const input = "mongodb://admin:m0ngopass@cluster.example.net/db";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("m0ngopass");
    expect(result).toContain("***@");
  });

  it("strips HTTPS URL with credentials", () => {
    const input = "Request to https://user:secret@api.example.com/v1 failed";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("secret");
    expect(result).toContain("***@api.example.com");
  });

  it("strips Bearer tokens", () => {
    const input = "Auth header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result).toContain("Bearer [REDACTED]");
  });

  it("strips JWT tokens even without Bearer prefix", () => {
    const input = "Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(result).toContain("[JWT_REDACTED]");
  });

  it("strips Basic auth header", () => {
    const input = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(result).toContain("Basic [REDACTED]");
  });

  it("strips password= query param assignments", () => {
    const input = "POST /login?username=admin&password=supersecret123 HTTP/1.1";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("supersecret123");
    expect(result).toContain("password=[REDACTED]");
  });

  it("strips api_key= assignments", () => {
    const input = "api_key=FAKE_TEST_KEY_VALUE_NOT_REAL_12345&user=123";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("FAKE_TEST_KEY_VALUE_NOT_REAL_12345");
    expect(result).toContain("api_key=[REDACTED]");
  });

  it("strips x-api-key header", () => {
    const input = "x-api-key: FAKE_XKEY_67890";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("FAKE_XKEY_67890");
    expect(result).toContain("x-api-key: [REDACTED]");
  });

  it("strips access_token= assignments", () => {
    const input = "access_token=FAKE_OAUTH_TOKEN_VALUE_abc123def456&refresh=xxx";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("FAKE_OAUTH_TOKEN_VALUE_abc123def456");
    expect(result).toContain("access_token=[REDACTED]");
  });

  it("strips Authorization header (catch-all)", () => {
    const input = "authorization: custom-scheme-token-abc123";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("custom-scheme-token-abc123");
    expect(result).toContain("[REDACTED]");
  });

  it("preserves file paths for diagnosis", () => {
    const input = "Error at /home/z/repo/src/lib/db.ts:15:12 — connection issue";
    const result = sanitizeForLog(input);
    expect(result).toContain("/home/z/repo/src/lib/db.ts:15:12");
  });

  it("preserves SQL fragments for diagnosis", () => {
    const input = "Query failed: UPDATE tasks SET status = $1 WHERE id = $2";
    const result = sanitizeForLog(input);
    expect(result).toContain("UPDATE tasks SET status");
    expect(result).toContain("WHERE id");
  });

  it("preserves Prisma error codes for diagnosis", () => {
    const input = "PrismaClientKnownRequestError: P2024 — connection pool timeout";
    const result = sanitizeForLog(input);
    expect(result).toContain("P2024");
  });

  it("handles empty string gracefully", () => {
    expect(sanitizeForLog("")).toBe("");
  });

  it("handles string with no secrets (no-op)", () => {
    const input = "Task not found in tenant scope";
    expect(sanitizeForLog(input)).toBe(input);
  });

  it("handles multiple secrets in the same string", () => {
    const input = "DB: postgresql://app:pw1@host1/db AND api_key=FAKE_KEY_abc123 AND Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("pw1");
    expect(result).not.toContain("FAKE_KEY_abc123");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(result).toContain("***@host1");
    expect(result).toContain("api_key=[REDACTED]");
    expect(result).toContain("Bearer [REDACTED]");
  });
});

// ============================================================
// buildApiErrorResponse — secrets never reach pino logger
// ------------------------------------------------------------
// These are the CRITICAL tests: they verify that the mock logger
// receives SANITIZED values, not the raw exception text. If a
// PostgreSQL URL with a password or a Bearer token appears in
// the error, it must NOT appear in the pino log payload.
// ============================================================
describe("buildApiErrorResponse — pino log payload is sanitized", () => {
  beforeEach(() => {
    mockError.mockClear();
  });

  it("does NOT log raw PostgreSQL connection string password", () => {
    const err = new Error(
      "Connection terminated: postgresql://balance_app:s3cretP@ss@10.0.0.5:5432/balance?schema=public"
    );
    buildApiErrorResponse(err, "/api/v1/tasks", "POST", "req-001");

    expect(mockError).toHaveBeenCalledTimes(1);
    const loggedPayload = mockError.mock.calls[0]![0] as Record<string, unknown>;
    const serialized = JSON.stringify(loggedPayload);

    // The raw password must NOT appear anywhere in the logged payload
    expect(serialized).not.toContain("s3cretP");
    // The sanitized version should be present
    expect(loggedPayload.errMsg).toContain("***@");
    // Host preserved for diagnosis
    expect(loggedPayload.errMsg).toContain("10.0.0.5:5432");
  });

  it("does NOT log raw Bearer token", () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const err = new Error(`Auth failed: Bearer ${token} rejected by upstream`);
    buildApiErrorResponse(err, "/api/v1/auth/signin", "POST", "req-002");

    expect(mockError).toHaveBeenCalledTimes(1);
    const loggedPayload = mockError.mock.calls[0]![0] as Record<string, unknown>;
    const serialized = JSON.stringify(loggedPayload);

    expect(serialized).not.toContain(token);
    expect(loggedPayload.errMsg).toContain("Bearer [REDACTED]");
  });

  it("does NOT log Bearer token from stack trace", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123def456";
    const err = new Error("auth failure");
    err.stack = `Error: auth failure\n    at /app/src/auth.ts:15:5\n    Bearer ${token} in headers\n    at /app/node_modules/next/dist/index.js:200:10`;
    buildApiErrorResponse(err, "/api/v1/auth/signin", "POST");

    expect(mockError).toHaveBeenCalledTimes(1);
    const loggedPayload = mockError.mock.calls[0]![0] as Record<string, unknown>;
    const serialized = JSON.stringify(loggedPayload);

    expect(serialized).not.toContain(token);
    expect(loggedPayload.errStack).toContain("Bearer [REDACTED]");
    // File paths preserved in stack for diagnosis
    expect(loggedPayload.errStack).toContain("/app/src/auth.ts:15:5");
  });

  it("preserves requestId, route, method, errName, prismaCode without leaking secrets", () => {
    const err = Object.assign(
      new Error("Pool timeout: postgresql://app:dbpw@db.host:5432/prod"),
      { code: "P2024" }
    );
    buildApiErrorResponse(err, "/api/v1/tasks", "POST", "req-abc-999");

    expect(mockError).toHaveBeenCalledTimes(1);
    const loggedPayload = mockError.mock.calls[0]![0] as Record<string, unknown>;

    // Diagnostic fields preserved
    expect(loggedPayload.requestId).toBe("req-abc-999");
    expect(loggedPayload.route).toBe("/api/v1/tasks");
    expect(loggedPayload.method).toBe("POST");
    expect(loggedPayload.errName).toBe("Error");
    expect(loggedPayload.prismaCode).toBe("P2024");

    // Secret stripped
    expect(JSON.stringify(loggedPayload)).not.toContain("dbpw");
    expect(loggedPayload.errMsg).toContain("***@db.host:5432");
  });

  it("does NOT log API key from error message", () => {
    const err = new Error("Upstream rejected: api_key=FAKE_TEST_KEY_NOT_REAL_abc123");
    buildApiErrorResponse(err, "/api/v1/capabilities/test/invoke", "POST", "req-003");

    expect(mockError).toHaveBeenCalledTimes(1);
    const loggedPayload = mockError.mock.calls[0]![0] as Record<string, unknown>;
    const serialized = JSON.stringify(loggedPayload);

    expect(serialized).not.toContain("FAKE_TEST_KEY_NOT_REAL_abc123");
    expect(loggedPayload.errMsg).toContain("api_key=[REDACTED]");
  });

  it("does NOT log password from query string in stack trace", () => {
    const err = new Error("Request failed");
    err.stack = `Error: Request failed\n    at /app/src/api.ts:30:5\n    URL: /auth?password=hunter2&user=admin\n    at /app/node_modules/...`;
    buildApiErrorResponse(err, "/api/v1/auth/signin", "POST");

    expect(mockError).toHaveBeenCalledTimes(1);
    const loggedPayload = mockError.mock.calls[0]![0] as Record<string, unknown>;
    const serialized = JSON.stringify(loggedPayload);

    expect(serialized).not.toContain("hunter2");
    expect(loggedPayload.errStack).toContain("password=[REDACTED]");
  });

  it("handles multiple secrets in one error (defense in depth)", () => {
    const err = new Error(
      "DB postgresql://app:pw1@host1/db AND token=abc123 AND Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"
    );
    buildApiErrorResponse(err, "/api/v1/tasks", "POST", "req-multi");

    expect(mockError).toHaveBeenCalledTimes(1);
    const loggedPayload = mockError.mock.calls[0]![0] as Record<string, unknown>;
    const serialized = JSON.stringify(loggedPayload);

    expect(serialized).not.toContain("pw1");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(loggedPayload.errMsg).toContain("***@host1");
    expect(loggedPayload.errMsg).toContain("token=[REDACTED]");
    expect(loggedPayload.errMsg).toContain("Bearer [REDACTED]");
  });

  it("does NOT log secrets from string throws (non-Error)", () => {
    // A raw string thrown — String(err) is used
    const thrown = "Connection: postgresql://app:rawpw@host/db";
    buildApiErrorResponse(thrown, "/api/v1/tasks", "POST", "req-str");

    expect(mockError).toHaveBeenCalledTimes(1);
    const loggedPayload = mockError.mock.calls[0]![0] as Record<string, unknown>;
    const serialized = JSON.stringify(loggedPayload);

    expect(serialized).not.toContain("rawpw");
    expect(loggedPayload.errMsg).toContain("***@host");
  });
});
