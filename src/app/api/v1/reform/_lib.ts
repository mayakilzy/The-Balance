// ============================================================
// src/app/api/v1/reform/_lib.ts — Shared API helpers for G03-02 routes
// ------------------------------------------------------------
// Centralizes authentication + permission + error mapping so each
// route handler is concise and consistent.
//
// SECURITY: 500 responses return a GENERIC error message to the client
// (no internal details, no SQL fragments, no DB error messages).
// Detailed diagnostic info is logged server-side via the application
// logger (pino) so operators can investigate without exposing
// internals to clients.
//
// 400/401/403/404/409 responses retain their specific semantics:
//   - 400: validation errors (Zod issues are safe to expose)
//   - 401: unauthenticated
//   - 403: permission denied (with the permission name — safe to expose)
//   - 404: not found (without leaking whether it exists in another tenant)
//   - 409: lifecycle conflict (with the current vs expected state)
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import {
  NotFoundError,
  ConflictError,
} from "@/lib/reform/contracts";
import { PermissionDeniedError } from "@/lib/permissions";
import { childLogger } from "@/lib/observability";

const log = childLogger({ module: "reform-api" });

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
  // 403: permission denied — safe to expose the permission name
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { error: "Forbidden", detail: err.message },
      { status: 403 }
    );
  }
  // 404: not found — message describes what was not found; safe to expose
  if (err instanceof NotFoundError) {
    return NextResponse.json(
      { error: "Not Found", detail: err.message },
      { status: 404 }
    );
  }
  // 409: lifecycle conflict — message describes the state; safe to expose
  if (err instanceof ConflictError) {
    return NextResponse.json(
      { error: "Conflict", detail: err.message },
      { status: 409 }
    );
  }
  // 400: Zod validation errors — safe to expose (input shape only)
  if (err && typeof err === "object" && "issues" in err) {
    return NextResponse.json(
      { error: "Validation Error", detail: (err as { issues: unknown[] }).issues },
      { status: 400 }
    );
  }
  // 500: ANY other error (DB errors, RLS violations, unexpected runtime errors).
  // SECURITY: do NOT return err.message to the client. Log it server-side only.
  const detail = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  log.error(
    {
      err: detail,
      stack,
      errorName: err instanceof Error ? err.name : typeof err,
    },
    "REFORM_API_INTERNAL_ERROR — returning generic 500 to client"
  );
  return NextResponse.json(
    { error: "Internal Server Error" },
    { status: 500 }
  );
}
