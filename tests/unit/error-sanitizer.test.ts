// ============================================================
// error-sanitizer.test.ts — Negative disclosure tests
// ------------------------------------------------------------
// Closes 00-09 Gap 1: proves that the structured API error handler
// NEVER lets raw exception text (SQL fragments, connection strings,
// file paths, env var names, stack traces) reach the HTTP response
// body for unexpected errors.
//
// Operational errors (known safe patterns) are still surfaced with
// a mapped HTTP status — this is intentional, those messages are
// curated to be user-safe.
// ============================================================
import { describe, it, expect } from "vitest";
import {
  sanitizeError,
  isOperationalError,
  getSafeErrorResponse,
  buildApiErrorResponse,
} from "@/lib/error-sanitizer";

// ============================================================
// EXISTING UNIT TESTS (sanitizer + operational detection)
// ============================================================

describe("Error Sanitizer — pattern stripping", () => {
  it("removes file paths from error messages", () => {
    const err = new Error("Cannot read file /home/user/project/src/lib/db.ts");
    const result = sanitizeError(err);
    expect(result.detail).not.toContain("/home/user/project/src/lib/db.ts");
    expect(result.detail).toContain("[file]");
  });

  it("removes SQL fragments", () => {
    const err = new Error("SELECT * FROM users WHERE id = 1 failed");
    const result = sanitizeError(err);
    expect(result.detail).not.toContain("SELECT * FROM users");
    expect(result.detail).toContain("[SQL]");
  });

  it("removes connection strings", () => {
    const err = new Error("Failed to connect to postgresql://admin:pass@host:5432/db");
    const result = sanitizeError(err);
    expect(result.detail).not.toContain("postgresql://admin:pass@host");
    expect(result.detail).toContain("[db-url]");
  });

  it("removes env var names", () => {
    const err = new Error("process.env.DATABASE_URL is not set");
    const result = sanitizeError(err);
    expect(result.detail).not.toContain("process.env.DATABASE_URL");
    expect(result.detail).toContain("[env]");
  });

  it("truncates long error messages", () => {
    const longMsg = "x".repeat(500);
    const err = new Error(longMsg);
    const result = sanitizeError(err);
    expect(result.detail!.length).toBeLessThanOrEqual(300);
  });

  it("returns generic error for unknown errors", () => {
    const result = getSafeErrorResponse(new Error("Unexpected internal crash"));
    expect(result.error).toBe("Request failed");
  });

  it("returns operational errors directly", () => {
    const result = getSafeErrorResponse(new Error("Task not found in tenant scope"));
    expect(result.error).toBe("Task not found in tenant scope");
  });

  it("identifies operational errors correctly", () => {
    expect(isOperationalError(new Error("Permission denied: evidence:write"))).toBe(true);
    expect(isOperationalError(new Error("Not authenticated"))).toBe(true);
    expect(isOperationalError(new Error("Evidence completeness violation"))).toBe(true);
    expect(isOperationalError(new Error("Internal server crash"))).toBe(false);
  });
});

// ============================================================
// NEW: buildApiErrorResponse — strict non-disclosure for unexpected errors
// ============================================================

describe("buildApiErrorResponse — operational errors (safe disclosure)", () => {
  it("returns the operational message with mapped status for 'not found'", () => {
    const err = new Error("Task not found in tenant scope");
    const { status, body } = buildApiErrorResponse(err, "/api/v1/tasks/abc", "GET", "req-123");
    expect(status).toBe(404);
    expect(body.error).toBe("Task not found in tenant scope");
    expect(body.requestId).toBe("req-123");
    expect(body).not.toHaveProperty("detail");
  });

  it("returns 403 for permission denied", () => {
    const err = new Error("Permission denied: task:write");
    const { status, body } = buildApiErrorResponse(err, "/api/v1/tasks", "POST");
    expect(status).toBe(403);
    expect(body.error).toContain("Permission denied");
  });

  it("returns 401 for unauthenticated", () => {
    const err = new Error("Not authenticated");
    const { status, body } = buildApiErrorResponse(err, "/api/v1/evidence", "GET");
    expect(status).toBe(401);
    expect(body.error).toBe("Not authenticated");
  });

  it("returns 409 for fencing mismatch / lease expired", () => {
    const fencingErr = new Error("Claim lost, fencing mismatch, or lease expired: operation 'startTask' failed.");
    const { status, body } = buildApiErrorResponse(fencingErr, "/api/v1/tasks/x", "POST");
    expect(status).toBe(409);
    expect(body.error).toContain("Claim lost");
  });

  it("returns 503 for adapter not registered", () => {
    const err = new Error("Adapter 'foo' is not registered. Capability 'bar' cannot be invoked.");
    const { status } = buildApiErrorResponse(err, "/api/v1/capabilities/bar/invoke", "POST");
    expect(status).toBe(503);
  });

  it("returns 400 for generic invalid input", () => {
    const err = new Error("Invalid input: missing required field");
    const { status, body } = buildApiErrorResponse(err, "/api/v1/tasks", "POST");
    expect(status).toBe(400);
    expect(body.error).toContain("Invalid input");
  });
});

// ============================================================
// CRITICAL NEGATIVE TESTS — no internal details in HTTP body
// ============================================================

describe("buildApiErrorResponse — unexpected errors NEVER leak internals", () => {
  // Helper: stringify the body and check for forbidden substrings.
  function assertNoLeak(body: Record<string, unknown>, forbidden: string[], label: string) {
    const serialized = JSON.stringify(body);
    for (const needle of forbidden) {
      expect(serialized, `${label}: body must not contain "${needle}"`).not.toContain(needle);
    }
  }

  it("does NOT leak PostgreSQL connection strings", () => {
    const err = new Error(
      "Connection terminated: postgresql://balance_app:s3cretP@ss@10.0.0.5:5432/balance?schema=public"
    );
    const { status, body } = buildApiErrorResponse(err, "/api/v1/tasks", "POST");
    expect(status).toBe(500);
    expect(body.error).toBe("Internal server error");
    assertNoLeak(body, ["postgresql://", "s3cretP", "balance_app", "10.0.0.5"], "connection string");
  });

  it("does NOT leak raw SQL fragments", () => {
    const err = new Error(
      "Query failed: UPDATE users SET passwordHash = $1 WHERE id = $2 — relation does not exist"
    );
    const { status, body } = buildApiErrorResponse(err, "/api/v1/auth/signin", "POST");
    expect(status).toBe(500);
    expect(body.error).toBe("Internal server error");
    assertNoLeak(body, ["UPDATE users SET", "passwordHash", "WHERE id"], "SQL fragment");
  });

  it("does NOT leak file system paths", () => {
    const err = new Error(
      "ENOENT: no such file or directory, open '/var/www/the-balance/.env.production'"
    );
    const { status, body } = buildApiErrorResponse(err, "/api/v1/evidence", "GET");
    expect(status).toBe(500);
    expect(body.error).toBe("Internal server error");
    assertNoLeak(body, ["/var/www/the-balance", ".env.production", "ENOENT"], "file path");
  });

  it("does NOT leak environment variable names", () => {
    const err = new Error("AUTH_SECRET is undefined — check process.env.AUTH_SECRET at startup");
    const { status, body } = buildApiErrorResponse(err, "/api/v1/auth/signin", "POST");
    expect(status).toBe(500);
    expect(body.error).toBe("Internal server error");
    assertNoLeak(body, ["AUTH_SECRET", "process.env"], "env var name");
  });

  it("does NOT leak stack traces", () => {
    const err = new Error("boom");
    err.stack =
      "Error: boom\n" +
      "    at Object.<anonymous> (/home/z/my-project/repos/The-Balance/src/lib/db.ts:15:12)\n" +
      "    at Module._compile (node:internal/modules/cjs/loader:1159:14)";
    const { status, body } = buildApiErrorResponse(err, "/api/v1/tasks", "POST");
    expect(status).toBe(500);
    expect(body.error).toBe("Internal server error");
    assertNoLeak(body, ["at Object.<anonymous>", "node:internal/modules", "cjs/loader"], "stack trace");
  });

  it("does NOT leak Prisma internal error codes/messages", () => {
    // P2024 = "Timed out fetching a connection from the connection pool"
    const err = Object.assign(new Error("Timed out fetching connection from pool. Current pool size: 10"), {
      code: "P2024",
      meta: { database_name: "balance_prod" },
    });
    const { status, body } = buildApiErrorResponse(err, "/api/v1/tasks", "POST");
    expect(status).toBe(500);
    expect(body.error).toBe("Internal server error");
    assertNoLeak(body, ["P2024", "connection pool", "balance_prod"], "prisma internal");
  });

  it("does NOT include a 'detail' field at all for unexpected errors", () => {
    const err = new Error("Some weird internal failure with detail: postgresql://user:pw@host/db");
    const { body } = buildApiErrorResponse(err, "/api/v1/tasks", "POST");
    expect(body).not.toHaveProperty("detail");
    expect(body).not.toHaveProperty("stack");
    expect(body).not.toHaveProperty("message");
    expect(Object.keys(body).sort()).toEqual(["error"]);
  });

  it("preserves requestId when provided (for client-side tracing)", () => {
    const err = new Error("internal crash");
    const { body } = buildApiErrorResponse(err, "/api/v1/tasks", "POST", "req-abc-123");
    expect(body.requestId).toBe("req-abc-123");
    expect(body.error).toBe("Internal server error");
  });

  it("handles non-Error throwables without leaking stringified internals", () => {
    // A Prisma-like object thrown raw
    const thrown = { code: "P2002", message: "Unique constraint failed on (tenantId)", foo: "postgresql://x" };
    const { status, body } = buildApiErrorResponse(thrown, "/api/v1/tasks", "POST");
    expect(status).toBe(500);
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("P2002");
    expect(JSON.stringify(body)).not.toContain("postgresql://x");
  });

  it("handles string throws (not Error instances)", () => {
    const { status, body } = buildApiErrorResponse("just a string", "/api/v1/tasks", "POST");
    expect(status).toBe(500);
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("just a string");
  });
});
