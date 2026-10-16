// ============================================================
// /app/page.tsx — UI shell for mission 00-01
// ------------------------------------------------------------
// Displays platform identity + live health status fetched from
// /api/health. No interactive features beyond the health check —
// those arrive in 00-08.
//
// This page is server-rendered; the health check is fetched client-side
// to avoid blocking SSR on the DB ping.
// ============================================================
"use client";

import { useEffect, useState } from "react";

interface HealthCheck {
  name: string;
  status: "ok" | "degraded" | "down";
  latencyMs?: number;
  detail?: string;
}

interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  env: string;
  time: string;
  checks: HealthCheck[];
}

interface MetaResponse {
  name: string;
  version: string;
  env: string;
  group: string;
  mission: string;
  llm: {
    provider: string;
    defaultModel: string;
    defaultEmbeddingModel: string;
  };
  features: Record<string, boolean>;
}

const STATUS_COLORS: Record<HealthCheck["status"], string> = {
  ok: "text-emerald-600",
  degraded: "text-amber-600",
  down: "text-rose-600",
};

const STATUS_BG: Record<HealthCheck["status"], string> = {
  ok: "bg-emerald-50 border-emerald-200",
  degraded: "bg-amber-50 border-amber-200",
  down: "bg-rose-50 border-rose-200",
};

export default function HomePage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  async function refresh(signal?: AbortSignal) {
    setHealthError(null);
    try {
      const [hRes, mRes] = await Promise.all([
        fetch("/api/health", { cache: "no-store", signal }),
        fetch("/api/v1/meta", { cache: "no-store", signal }),
      ]);
      if (!hRes.ok) {
        setHealthError(`Health endpoint returned ${hRes.status}`);
      }
      const h = (await hRes.json()) as HealthResponse;
      const m = (await mRes.json()) as MetaResponse;
      setHealth(h);
      setMeta(m);
      setLastUpdated(new Date());
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setHealthError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    // Periodic health refresh. The initial fetch fires via the interval's
    // first tick (delay=0) so we don't trigger a synchronous setState in
    // the effect body (which React 19's lint rule disallows).
    const controller = new AbortController();
    const fetchHealth = () => void refresh(controller.signal);
    const id = setInterval(fetchHealth, 10_000);
    // Fire immediately (async, not synchronous in effect body).
    fetchHealth();
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, []);

  return (
    <main className="flex-1 container mx-auto px-4 py-8 max-w-3xl">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          The Balance
        </h1>
        <p className="mt-2 text-muted-foreground">
          Global State Intelligence &amp; State-Building Platform
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          GROUP 00 Foundation — Mission 00-01 Runnable Platform Skeleton
        </p>
      </header>

      {/* Health section */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-semibold">Health</h2>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="text-xs text-muted-foreground">
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={() => void refresh()}
              className="text-xs px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
        </div>

        {healthError && (
          <div className="mb-3 p-3 rounded border border-rose-200 bg-rose-50 text-rose-800 text-sm">
            <strong>Health check failed:</strong> {healthError}
          </div>
        )}

        {health ? (
          <div
            className={`p-4 rounded border ${
              health.status === "ok"
                ? "bg-emerald-50 border-emerald-200"
                : "bg-amber-50 border-amber-200"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">
                Overall: {health.status.toUpperCase()}
              </span>
              <span className="text-sm text-muted-foreground">
                v{health.version} · {health.env}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {health.checks.map((c) => (
                <div
                  key={c.name}
                  className={`p-2 rounded border text-sm ${STATUS_BG[c.status]}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono">{c.name}</span>
                    <span className={`font-medium ${STATUS_COLORS[c.status]}`}>
                      {c.status}
                    </span>
                  </div>
                  {c.latencyMs !== undefined && (
                    <div className="text-xs text-muted-foreground mt-1">
                      {c.latencyMs}ms{c.detail ? ` · ${c.detail}` : ""}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          !healthError && <div className="text-sm text-muted-foreground">Loading…</div>
        )}
      </section>

      {/* Meta section */}
      {meta && (
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">Build Metadata</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            <div className="p-3 rounded border border-gray-200">
              <dt className="text-muted-foreground">Group / Mission</dt>
              <dd className="font-mono mt-1">
                {meta.group} / {meta.mission}
              </dd>
            </div>
            <div className="p-3 rounded border border-gray-200">
              <dt className="text-muted-foreground">LLM Provider</dt>
              <dd className="font-mono mt-1">
                {meta.llm.provider}
                <span className="text-muted-foreground">
                  {" "}
                  ({meta.llm.defaultModel})
                </span>
              </dd>
            </div>
          </dl>
          <div className="mt-3 p-3 rounded border border-gray-200 text-sm">
            <p className="text-muted-foreground mb-2">Feature flags (all OFF in 00-01):</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(meta.features).map(([k, v]) => (
                <span
                  key={k}
                  className="px-2 py-1 rounded text-xs font-mono bg-gray-100 text-gray-600"
                >
                  {k}: {v ? "on" : "off"}
                </span>
              ))}
            </div>
          </div>
        </section>
      )}

      <footer className="mt-auto pt-8 text-xs text-muted-foreground border-t border-gray-200">
        <p>
          The Balance — Foundation skeleton. Not for production use.
          All LLM outputs in this build are SIMULATED (stub provider).
        </p>
      </footer>
    </main>
  );
}
