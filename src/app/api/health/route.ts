// ============================================================
// /api/health — Liveness + readiness probe
// ------------------------------------------------------------
// Returns 200 if the process is alive AND can reach the database.
// Returns 503 if the database is unreachable.
//
// This is the ONLY endpoint that performs a DB ping in 00-01. Other
// endpoints will gain their own health semantics in later missions.
// ============================================================
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { childLogger } from "@/lib/observability";
import { getLLMProvider } from "@/lib/llm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const log = childLogger({ module: "health" });

export const dynamic = "force-dynamic";

interface HealthCheck {
  name: string;
  status: "ok" | "degraded" | "down";
  latencyMs?: number;
  detail?: string;
}

async function checkDatabase(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    // Lightweight ping — SELECT 1 is the cheapest possible query.
    await db.$queryRaw`SELECT 1`;
    return {
      name: "database",
      status: "ok",
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn({ err: detail, latencyMs: Date.now() - start }, "DB ping failed");
    return {
      name: "database",
      status: "down",
      latencyMs: Date.now() - start,
      detail,
    };
  }
}

async function checkLLMProvider(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const provider = getLLMProvider();
    const healthy = await provider.health();
    return {
      name: "llm",
      status: healthy ? "ok" : "degraded",
      latencyMs: Date.now() - start,
      detail: `provider=${provider.name}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      name: "llm",
      status: "down",
      latencyMs: Date.now() - start,
      detail,
    };
  }
}

export async function GET(request: Request) {
  const checks: HealthCheck[] = [];

  // Database is the critical dependency — if it's down, we're not ready.
  checks.push(await checkDatabase());

  // LLM provider is non-critical for 00-01 (stub is always ok).
  checks.push(await checkLLMProvider());

  const allOk = checks.every((c) => c.status === "ok");
  const overallStatus = allOk ? "ok" : "degraded";

  // Audit the health check (lightweight — no tenant context in 00-01).
  await writeAudit({
    action: "health.check",
    route: "/api/health",
    method: "GET",
    details: { overall: overallStatus, checks: checks.map(({ name, status }) => ({ name, status })) },
    status: overallStatus === "ok" ? "ok" : "error",
  });

  const body = {
    status: overallStatus,
    version: env.APP_VERSION,
    env: env.NODE_ENV,
    time: new Date().toISOString(),
    checks,
  };

  // 200 if all ok, 503 if any down (so load balancers route away).
  const statusCode = allOk ? 200 : 503;
  return NextResponse.json(body, { status: statusCode });
}
