// ============================================================
// error-sanitizer.ts — Sanitize API error responses
// ------------------------------------------------------------
// Prevents leaking internal details (stack traces, SQL errors,
// file paths, env vars) in API responses sent to clients.
// ============================================================

export interface SanitizedError {
  error: string;
  detail?: string;
  requestId?: string;
}

/**
 * Sanitize an error for client-facing API responses.
 * Removes: stack traces, file paths, env var names, SQL query text.
 * Keeps: generic error messages safe for users.
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
 */
export function isOperationalError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // Known safe error patterns
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
  return false;
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
