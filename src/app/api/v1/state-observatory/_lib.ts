// ============================================================
// src/app/api/v1/state-observatory/_lib.ts — Shared API helpers for G02 routes
// ------------------------------------------------------------
// Mirrors the state-builder/_lib.ts pattern:
//   - authenticateAndAuthorize(): session + permission check (401 / 403)
//   - mapServiceError(): maps service-layer errors to safe HTTP responses
//     (PermissionDeniedError → 403, NotFoundError → 404, ConflictError → 409,
//      Zod issues → 400, everything else → generic 500 with server-side log)
//
// SECURITY: 500 responses return a GENERIC error message to the client
// (no internal details, no SQL fragments, no DB error messages).
// Detailed diagnostic info is logged server-side via pino.
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requirePermissionWithCurrentRole, PermissionDeniedError } from "@/lib/permissions";
import { NotFoundError, ConflictError } from "@/lib/state-observatory/contracts";
import { childLogger } from "@/lib/observability";

const log = childLogger({ module: "state-observatory-api" });

export const FORCE_DYNAMIC = "force-dynamic";

export async function authenticateAndAuthorize(permission: string) {
  const session = await auth();
  if (!session) {
    return {
      session: null,
      errorResponse: NextResponse.json(
        { error: "Unauthenticated" },
        { status: 401 }
      ),
    };
  }
  try {
    await requirePermissionWithCurrentRole(session, permission);
  } catch {
    return {
      session: null,
      errorResponse: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { session, errorResponse: null };
}

export function mapServiceError(err: unknown): NextResponse {
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { error: "Forbidden", detail: err.message },
      { status: 403 }
    );
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json(
      { error: "Not Found", detail: err.message },
      { status: 404 }
    );
  }
  if (err instanceof ConflictError) {
    return NextResponse.json(
      { error: "Conflict", detail: err.message },
      { status: 409 }
    );
  }
  // Zod errors: expose issues (safe — these are validation messages)
  if (err && typeof err === "object" && "issues" in err) {
    return NextResponse.json(
      { error: "Validation Error", detail: (err as { issues: unknown[] }).issues },
      { status: 400 }
    );
  }
  if (err instanceof Error && err.name.endsWith("ValidationError")) {
    return NextResponse.json(
      { error: "Validation Error", detail: err.message },
      { status: 400 }
    );
  }
  // Plain Error with a service-layer message (e.g. "Review notes are required")
  // → 400 Bad Request (client sent bad input, not a server fault)
  if (err instanceof Error && err.message) {
    const msg = err.message;
    const isClientError =
      /required|cannot|invalid|must be|expected|not found|already/i.test(msg);
    if (isClientError) {
      return NextResponse.json(
        { error: "Bad Request", detail: msg },
        { status: 400 }
      );
    }
  }
  // Anything else → generic 500 (no internal leak)
  const detail = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  log.error(
    { err: detail, stack, errorName: err instanceof Error ? err.name : typeof err },
    "STATE_OBSERVATORY_API_INTERNAL_ERROR — returning generic 500 to client"
  );
  return NextResponse.json(
    { error: "Internal Server Error" },
    { status: 500 }
  );
}
