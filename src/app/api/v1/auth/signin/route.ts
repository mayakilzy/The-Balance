// ============================================================
// /api/v1/auth/signin — Sign in with email + password
// ============================================================
import { NextResponse } from "next/server";
import { signIn } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (typeof email !== "string" || typeof password !== "string") {
      return NextResponse.json(
        { error: "Email and password required" },
        { status: 400 }
      );
    }

    await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    await writeAudit({
      action: "auth.signin",
      route: "/api/v1/auth/signin",
      method: "POST",
      details: { email: email.toLowerCase() },
      status: "ok",
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await writeAudit({
      action: "auth.signin",
      route: "/api/v1/auth/signin",
      method: "POST",
      status: "error",
      errorCode: "SIGNIN_FAILED",
      details: { error: detail.slice(0, 200) },
    });
    return NextResponse.json(
      { error: "Invalid credentials" },
      { status: 401 }
    );
  }
}
