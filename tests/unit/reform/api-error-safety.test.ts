// ============================================================
// tests/unit/reform/api-error-safety.test.ts
// ------------------------------------------------------------
// R3 regression test: confirms that mapServiceError NEVER leaks
// internal exception messages (SQL fragments, DB error details,
// stack traces, etc.) in HTTP 500 responses.
//
// 400/403/404/409 responses retain their specific semantics.
// ============================================================
import { describe, it, expect, vi } from "vitest";

// Mock the logger so we can verify it's called without actually logging
vi.mock("@/lib/observability", () => ({
  childLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock auth so we don't need a real session
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

// Mock requirePermissionWithCurrentRole so we don't need a DB
vi.mock("@/lib/permissions", () => ({
  requirePermissionWithCurrentRole: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {
    readonly permission: string;
    constructor(permission: string) {
      super(`Permission denied: ${permission}`);
      this.name = "PermissionDeniedError";
      this.permission = permission;
    }
  },
}));

import { mapServiceError } from "@/app/api/v1/reform/_lib";
import { NotFoundError, ConflictError } from "@/lib/reform/contracts";
import { PermissionDeniedError } from "@/lib/permissions";

// ============================================================
// Sensitive error payloads that MUST NOT be leaked
// ============================================================
const SENSITIVE_ERROR_PAYLOADS = [
  // PostgreSQL RLS violation
  new Error('new row violates row-level security policy for table "reform_proposals"'),
  // PostgreSQL connection error
  new Error("ConnectorError: connection refused: localhost:5432"),
  // Prisma error with SQL fragment
  new Error('Invalid `prisma.reformProposal.create()` invocation: relation "reform_proposals" does not exist'),
  // Generic internal error with stack-like info
  new Error("TypeError: Cannot read properties of undefined (reading 'id') at /home/z/The-Balance/src/lib/reform/reform-proposal-service.ts:42:17"),
  // DB constraint violation
  new Error('duplicate key value violates unique constraint "reform_approvals_pkey"'),
  // Non-Error thrown (defense-in-depth)
  "some random string error",
  // Object error
  { code: "INTERNAL", details: "secret internal state" },
];

describe("R3 — mapServiceError never leaks internal details in 500 responses", () => {
  for (const [idx, err] of SENSITIVE_ERROR_PAYLOADS.entries()) {
    it(`test ${idx + 1}: ${err instanceof Error ? err.message.slice(0, 50) : typeof err} → 500 with generic message only`, async () => {
      const response = mapServiceError(err);
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Internal Server Error");
      // CRITICAL: the response body MUST NOT contain any of these keys
      // that would leak internal details
      expect(body).not.toHaveProperty("detail");
      expect(body).not.toHaveProperty("stack");
      expect(body).not.toHaveProperty("details");
      expect(body).not.toHaveProperty("message");
      expect(body).not.toHaveProperty("err");

      // CRITICAL: the response body MUST NOT contain sensitive substrings
      const bodyStr = JSON.stringify(body);
      const forbiddenSubstrings = [
        "row-level security",
        "ConnectorError",
        "prisma.",
        "reform_proposals",
        "duplicate key",
        "TypeError",
        "Cannot read properties",
        "at /home/z",
        ".ts:",
        "connection refused",
        "secret internal",
      ];
      for (const forbidden of forbiddenSubstrings) {
        expect(bodyStr).not.toContain(forbidden);
      }
    });
  }

  it("non-Error values (string, object) are also safely mapped to generic 500", async () => {
    const response = mapServiceError("random string error");
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Internal Server Error");
    expect(body).not.toHaveProperty("detail");
  });
});

// ============================================================
// Verify 400/403/404/409 retain their specific semantics
// ============================================================
describe("R3 — specific error classes retain their HTTP semantics", () => {
  it("PermissionDeniedError → 403 with detail (permission name is safe to expose)", async () => {
    const response = mapServiceError(new PermissionDeniedError("reform:proposal:approve"));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
    expect(body.detail).toContain("reform:proposal:approve");
  });

  it("NotFoundError → 404 with detail (safe: describes what was not found)", async () => {
    const response = mapServiceError(new NotFoundError("Proposal p1 not found in tenant t1"));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Not Found");
    expect(body.detail).toContain("not found");
  });

  it("ConflictError → 409 with detail (safe: describes lifecycle conflict)", async () => {
    const response = mapServiceError(new ConflictError("Proposal is in status draft, cannot approve"));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("Conflict");
    expect(body.detail).toContain("cannot approve");
  });

  it("Zod error → 400 with issues (safe: input shape only)", async () => {
    const zodLikeError = {
      issues: [{ path: ["title"], message: "title must be at least 5 characters" }],
    };
    const response = mapServiceError(zodLikeError);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation Error");
    expect(body.detail).toEqual(zodLikeError.issues);
  });
});

// ============================================================
// Verify 500 response is JSON-parseable (defensive)
// ============================================================
describe("R3 — 500 response is always JSON-parseable", () => {
  it("returns a valid JSON body with only `error` key", async () => {
    const response = mapServiceError(new Error("internal"));
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toBe("Internal Server Error");
  });
});
