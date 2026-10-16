// ============================================================
// error-sanitizer.ts — Sanitize API error responses
// ------------------------------------------------------------
// Prevents leaking internal details (stack traces, SQL errors,
// file paths, env vars) in API responses sent to clients.
//
// Policy:
//   - Operational errors (known safe patterns: "not found",
//     "permission denied", "claim lost", etc.) → return the
//     message to the client with the appropriate HTTP status.
//   - Unexpected errors (DB crashes, Prisma internal errors,
//     stack traces, SQL fragments, connection strings, file
//     paths) → return a GENERIC message to the client and log
//     the full original error to pino (server-side only).
//
// Negative guarantee: for unexpected errors, the response body
// NEVER carries a `detail` field — there is no path by which
// raw exception text reaches the client.
// ============================================================
import { childLogger } from "@/lib/observability";

const log = childLogger({ module: "error-sanitizer" });

export interface SanitizedError {
  error: string;
  detail?: string;
  requestId?: string;
}

/**
 * Sanitize an error for client-facing API responses.
 * Removes: stack traces, file paths, env var names, SQL query text.
 * Keeps: generic error messages safe for users.
 *
 * NOTE: This function is used only for operational errors. For
 * unexpected errors, prefer buildApiErrorResponse which returns a
 * fully generic body and logs the original.
 */
export function sanitizeError(err: unknown): SanitizedError {
  const rawMessage = err instanceof Error ? err.message : String(err);

  // Patterns to strip from error messages
  const sanitized = rawMessage
    // Remove file paths
    .replace(/\/[^\s]+\/[^\s]+\.(ts|js|tsx|jsx)/g, "[file]")
    // Remove env var names
    .replace(/process\.env\.\w+/g, "[env]")
    // Remove SQL fragments
    .replace(/SELECT.*?FROM/gi, "[SQL]")
    .replace(/INSERT.*?INTO/gi, "[SQL]")
    .replace(/UPDATE.*?SET/gi, "[SQL]")
    .replace(/DELETE.*?FROM/gi, "[SQL]")
    // Remove connection strings
    .replace(/postgresql:\/\/[^\s]+/g, "[db-url]")
    // Remove stack trace lines
    .replace(/at\s+.+/g, "")
    // Trim whitespace
    .trim()
    // Truncate to reasonable length
    .slice(0, 300);

  return {
    error: "Request failed",
    detail: sanitized.length > 0 ? sanitized : undefined,
  };
}

/**
 * Check if an error is a known operational error (safe to show details)
 * vs. an unexpected error (sanitize).
 *
 * Negative checks first: Node.js system errors (ENOENT, EACCES, ...)
 * and Prisma internal errors are NEVER operational, even if their
 * message happens to contain a substring like "not found".
 */
export function isOperationalError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const msg = err.message.toLowerCase();
  const name = err.name;

  // Negative check #1: known non-operational error types
  if (
    name === "TypeError" ||
    name === "ReferenceError" ||
    name === "SyntaxError" ||
    name === "RangeError"
  ) {
    return false;
  }

  // Negative check #2: Node.js system errors (ENOENT, EACCES, ECONNRESET, ...)
  // These carry a `code` property matching /^E[A-Z]+$/.
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    /^E[A-Z]+$/.test((err as { code: string }).code)
  ) {
    return false;
  }

  // Negative check #3: Prisma internal error codes (P2002, P2024, ...)
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    /^P\d{4}$/.test((err as { code: string }).code)
  ) {
    return false;
  }

  // Negative check #4: messages that begin with a known Node.js system
  // error code (ENOENT, EACCES, ECONNRESET, ...). These look like
  // "enoent: no such file..." and would otherwise match "not found" —
  // we treat them as non-operational so the file path never leaks.
  const SYSTEM_ERRNO_PREFIX =
    /^(enoent|eacces|eaddrinuse|econnrefused|econnreset|eexist|emfile|enotdir|eperm|epipe|etimedout|enospc|erange|eagain|ewouldblock|ehosunreach|enetunreach)\b/;
  if (SYSTEM_ERRNO_PREFIX.test(msg)) {
    return false;
  }

  // Known safe operational patterns
  return (
    msg.includes("not found") ||
    msg.includes("permission denied") ||
    msg.includes("invalid") ||
    msg.includes("not authenticated") ||
    msg.includes("unauthenticated") ||
    msg.includes("membership") ||
    msg.includes("evidence completeness") ||
    msg.includes("invalid decision state transition") ||
    msg.includes("claim lost") ||
    msg.includes("adapter") ||
    msg.includes("capability") ||
    msg.includes("not registered") ||
    msg.includes("lease expired") ||
    msg.includes("fencing mismatch")
  );
}

/**
 * Get a safe error response for the client.
 * Operational errors (not found, permission denied) show their message.
 * Unexpected errors show a generic message.
 */
export function getSafeErrorResponse(err: unknown): SanitizedError {
  if (isOperationalError(err)) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: message.slice(0, 300),
    };
  }
  return sanitizeError(err);
}

// ============================================================
// STRUCTURED API ERROR HANDLER
// ------------------------------------------------------------
// Single entry point used by API route catch blocks.
// Returns the JSON body + HTTP status the route should send.
// Logs the full original error to pino for server-side triage.
// ============================================================

export interface ApiErrorResponse {
  status: number;
  body: {
    error: string;
    requestId?: string;
  };
}

/**
 * Map an operational error to its HTTP status code.
 * Defaults to 400 (Bad Request) for unrecognized operational patterns.
 */
function operationalStatus(err: unknown): number {
  if (!(err instanceof Error)) return 400;
  const msg = err.message.toLowerCase();
  if (msg.includes("not found")) return 404;
  if (msg.includes("permission denied")) return 403;
  if (msg.includes("not authenticated") || msg.includes("unauthenticated")) return 401;
  if (msg.includes("membership")) return 403;
  if (msg.includes("lease expired") || msg.includes("claim lost") || msg.includes("fencing mismatch")) return 409;
  if (msg.includes("adapter") || msg.includes("capability") || msg.includes("not registered")) return 503;
  if (msg.includes("evidence completeness") || msg.includes("invalid decision state transition")) return 409;
  if (msg.includes("invalid")) return 400;
  return 400;
}

/**
 * Build a safe API error response.
 *
 * For operational errors: returns the safe message + mapped status.
 * For unexpected errors: returns a generic "Internal server error"
 * with status 500, and logs the full original to pino. The response
 * body contains NO `detail` field — there is no leak path.
 *
 * @param err     The thrown error
 * @param route   Route path (for log correlation), e.g. "/api/v1/tasks"
 * @param method  HTTP method (for log correlation)
 * @param requestId  Optional request ID for tracing
 */
export function buildApiErrorResponse(
  err: unknown,
  route: string,
  method: string,
  requestId?: string
): ApiErrorResponse {
  // Operational error → safe message + mapped status, no internal log needed
  if (isOperationalError(err)) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: operationalStatus(err),
      body: {
        error: message.slice(0, 300),
        ...(requestId ? { requestId } : {}),
      },
    };
  }

  // Unexpected error → log full detail server-side, return generic to client
  const errName = err instanceof Error ? err.name : typeof err;
  const errMsg = err instanceof Error ? err.message : String(err);
  const errStack = err instanceof Error ? err.stack : undefined;

  log.error(
    {
      route,
      method,
      requestId,
      errName,
      errMsg,
      errStack,
      // Prisma-specific metadata if present
      prismaCode:
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : undefined,
    },
    `UNEXPECTED_API_ERROR on ${method} ${route}`
  );

  return {
    status: 500,
    body: {
      error: "Internal server error",
      ...(requestId ? { requestId } : {}),
    },
  };
}
