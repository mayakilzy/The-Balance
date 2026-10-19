// ============================================================
// src/app/api/v1/reform/_lib.ts — Shared API helpers for G03-02 routes
// ------------------------------------------------------------
// NOTE: do NOT export `dynamic` from this file — Next.js requires it
// to be defined inline in each route.ts file. We export a constant
// instead and each route does `export const dynamic = FORCE_DYNAMIC`.
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import {
  NotFoundError,
  ConflictError,
} from "@/lib/reform/contracts";
import { PermissionDeniedError } from "@/lib/permissions";

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
    return NextResponse.json({ error: "Forbidden", detail: err.message }, { status: 403 });
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: "Not Found", detail: err.message }, { status: 404 });
  }
  if (err instanceof ConflictError) {
    return NextResponse.json({ error: "Conflict", detail: err.message }, { status: 409 });
  }
  // Zod errors
  if (err && typeof err === "object" && "issues" in err) {
    return NextResponse.json(
      { error: "Validation Error", detail: (err as { issues: unknown[] }).issues },
      { status: 400 }
    );
  }
  const detail = err instanceof Error ? err.message : String(err);
  return NextResponse.json(
    { error: "Internal Server Error", detail },
    { status: 500 }
  );
}
