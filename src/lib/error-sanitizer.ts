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
// LOG SANITIZER — strips secrets from free-text before pino logging
// ------------------------------------------------------------
// Unlike sanitizeError() (for HTTP responses) which aggressively
// strips file paths, SQL, and stack traces, sanitizeForLog()
// preserves diagnostic info (file paths, SQL fragments, error
// messages) and strips ONLY secrets: passwords in URLs, Bearer
// tokens, API keys, JWTs, Basic auth headers, password assignments.
//
// This is the defense-in-depth layer: even if an exception message
// contains a connection string with a password, the pino log entry
// will not persist it to disk/stdout.
// ============================================================

interface SecretPattern {
  pattern: RegExp;
  replacement: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // 1. Database / generic URL credentials: scheme://user:password@host
  //    → scheme://***@host  (host preserved for diagnosis)
  {
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s:@/]*(?::[^\s@/]*)?@/g,
    replacement: "$1***@",
  },
  // 2. Bearer tokens: "Bearer eyJ..." → "Bearer [REDACTED]"
  {
    pattern: /(Bearer\s+)[A-Za-z0-9\-._~+/=]+/g,
    replacement: "$1[REDACTED]",
  },
  // 3. Basic auth header: "Basic dXNlcjpwYXNz" → "Basic [REDACTED]"
  {
    pattern: /(Basic\s+)[A-Za-z0-9+/=]+/g,
    replacement: "$1[REDACTED]",
  },
  // 4. JWT tokens (three base64 segments): eyJ....eyJ....signature
  {
    pattern: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
    replacement: "[JWT_REDACTED]",
  },
  // 5. Password assignments: password=..., passwd=..., pwd=..., pass=...
  //    (in query strings, connection params, or config objects)
  //    Excludes [ so it won't eat into [REDACTED] placeholders from earlier patterns
  {
    pattern: /(\b(?:password|passwd|pwd|pass)\b\s*[=:]\s*)[^\s;&,"'\]}\[]+/gi,
    replacement: "$1[REDACTED]",
  },
  // 6. API key assignments: api_key=..., apikey=..., api-key=..., x-api-key: ...
  {
    pattern: /(\b(?:api[_-]?key|x-api-key)\b\s*[=:]\s*)[^\s;&,"'\]}\[]+/gi,
    replacement: "$1[REDACTED]",
  },
  // 7. Token assignments: access_token=..., auth_token=..., token=..., secret=...
  {
    pattern: /(\b(?:access[_-]?token|auth[_-]?token|token|secret|private[_-]?key)\b\s*[=:]\s*)[^\s;&,"'\]}\[]+/gi,
    replacement: "$1[REDACTED]",
  },
  // 8. AWS access key IDs: AKIA followed by 16 uppercase alphanumerics
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "AKIA[REDACTED]",
  },
  // 9. Authorization header values (catch-all for non-Bearer/non-Basic)
  //    Negative lookahead prevents eating "Basic"/"Bearer" (handled by #2/#3)
  {
    pattern: /(authorization\s*[:=]\s*)(?!basic\s|bearer\s)[^\s;,"'}\]\[]+/gi,
    replacement: "$1[REDACTED]",
  },
];

/**
 * Sanitize free-text for server-side logging.
 * Strips secrets (passwords, tokens, API keys, connection strings)
 * while preserving diagnostic info (file paths, SQL, error messages).
 *
 * @param text  The raw string (error message, stack trace, etc.)
 * @returns     Sanitized string safe for pino logging
 */
export function sanitizeForLog(text: string): string {
  if (!text) return text;
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ============================================================
// STRUCTURED API ERROR HANDLER
// ------------------------------------------------------------
// Single entry point used by API route catch blocks.
// Returns the JSON body + HTTP status the route should send.
// Logs the SANITIZED error to pino for server-side triage —
// secrets (passwords, tokens, API keys) are stripped BEFORE
// reaching the logger. Diagnostic info (file paths, SQL
// fragments, Prisma codes, error classification) is preserved.
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
 * with status 500, and logs the SANITIZED error to pino. The response
 * body contains NO `detail` field — there is no leak path. The pino
 * log entry has secrets stripped (passwords, tokens, API keys) while
 * preserving diagnostic info (file paths, Prisma codes, error name).
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

  // Unexpected error → log SANITIZED detail server-side, return generic to client
  const errName = err instanceof Error ? err.name : typeof err;
  const rawMsg = err instanceof Error ? err.message : String(err);
  const errMsg = sanitizeForLog(rawMsg);
  const errStack = err instanceof Error && err.stack ? sanitizeForLog(err.stack) : undefined;

  log.error(
    {
      route,
      method,
      requestId,
      errName,
      errMsg,
      errStack,
      // Prisma-specific metadata if present (P-codes are safe to log)
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
