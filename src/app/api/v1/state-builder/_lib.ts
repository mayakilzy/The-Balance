// ============================================================
// src/app/api/v1/state-builder/_lib.ts — Shared API helpers for G01 routes
// ------------------------------------------------------------
// Mirrors the reform/_lib.ts pattern: authentication + permission
// check + safe error mapping. Reuses the same error classes from
// the reform contracts where they overlap (NotFoundError, ConflictError)
// and falls back to generic 500 for unexpected errors.
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requirePermissionWithCurrentRole, PermissionDeniedError } from "@/lib/permissions";
import { NotFoundError, ConflictError } from "@/lib/reform/contracts";
import { childLogger } from "@/lib/observability";

const log = childLogger({ module: "state-builder-api" });

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
  const detail = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  log.error(
    { err: detail, stack, errorName: err instanceof Error ? err.name : typeof err },
    "STATE_BUILDER_API_INTERNAL_ERROR — returning generic 500 to client"
  );
  return NextResponse.json(
    { error: "Internal Server Error" },
    { status: 500 }
  );
}
