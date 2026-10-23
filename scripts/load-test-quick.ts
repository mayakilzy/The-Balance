// scripts/load-test-quick.ts — D05 Final Closure load test (Phases 1+2 only)
import autocannon from "autocannon";

const BASE_URL = "http://localhost:3001";
const COOKIE = process.env.AUTH_COOKIE ?? "";

const summary: any[] = [];

async function run(label: string, url: string, n: number, dur: number, cookie?: string) {
  console.log(`[${label}] ${n} conn × ${dur}s — ${url}`);
  const r = await autocannon({
    url, method: "GET", connections: n, duration: dur, workers: 2,
    headers: cookie ? { Cookie: cookie } : undefined, timeout: 30,
  });
  // autocannon result keys: p50, p75, p90, p97_5 (~p95), p99, p99_9
  console.log(`  rps=${Math.round(r.requests.average)} p50=${(r.latency.p50 ?? 0).toFixed(1)}ms p95=${(r.latency.p97_5 ?? 0).toFixed(1)}ms p99=${(r.latency.p99 ?? 0).toFixed(1)}ms errors=${r.errors ?? 0} non2xx=${r.non2xx ?? 0}`);
  summary.push({
    label, n, dur,
    rps: Math.round(r.requests.average),
    p50: r.latency.p50 ?? 0,
    p95: r.latency.p97_5 ?? 0,
    p99: r.latency.p99 ?? 0,
    errors: r.errors ?? 0,
    non2xx: r.non2xx ?? 0,
  });
}

async function main() {
  await run("P1-meta-N=10", `${BASE_URL}/api/v1/meta`, 10, 15);
  await run("P1-meta-N=50", `${BASE_URL}/api/v1/meta`, 50, 15);
  await run("P1-meta-N=100", `${BASE_URL}/api/v1/meta`, 100, 15);
  await run("P1-meta-N=200", `${BASE_URL}/api/v1/meta`, 200, 15);
  if (COOKIE) {
    await run("P2-auth-N=10", `${BASE_URL}/api/v1/continuity/decisions`, 10, 15, COOKIE);
    await run("P2-auth-N=50", `${BASE_URL}/api/v1/continuity/decisions`, 50, 15, COOKIE);
    await run("P2-auth-N=100", `${BASE_URL}/api/v1/continuity/decisions`, 100, 15, COOKIE);
  }
  console.log("\n=== SUMMARY ===");
  console.log("label            |  N |  rps | p50  | p95  | p99  | errors | non2xx");
  console.log("-".repeat(75));
  for (const r of summary) {
    console.log(
      r.label.padEnd(16) + " | " +
      String(r.n).padStart(3) + " | " +
      String(r.rps).padStart(4) + " | " +
      r.p50.toFixed(1).padStart(5) + " | " +
      r.p95.toFixed(1).padStart(5) + " | " +
      r.p99.toFixed(1).padStart(5) + " | " +
      String(r.errors).padStart(6) + " | " +
      String(r.non2xx).padStart(6)
    );
  }
  // Save to JSON
  const fs = await import("node:fs");
  fs.writeFileSync(
    "/home/z/my-project/scripts/load-test-quick-results.json",
    JSON.stringify({ summary }, null, 2)
  );
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
