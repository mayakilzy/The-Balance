// ============================================================
// src/app/api/v1/intelligence/_lib.ts — Shared API helpers
// ============================================================
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requirePermissionWithCurrentRole, PermissionDeniedError } from "@/lib/permissions";
import { childLogger } from "@/lib/observability";

const log = childLogger({ module: "intelligence-api" });

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
  const detail = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  log.error(
    { err: detail, stack, errorName: err instanceof Error ? err.name : typeof err },
    "INTELLIGENCE_API_INTERNAL_ERROR — returning generic 500 to client"
  );
  return NextResponse.json(
    { error: "Internal Server Error" },
    { status: 500 }
  );
}
