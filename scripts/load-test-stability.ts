// scripts/load-test-stability.ts — D05 Final Closure: extended stability test
import autocannon from "autocannon";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BASE_URL = "http://localhost:3001";

interface Sample {
  t: number;        // epoch ms
  bunxRssKb: number | null;     // bunx parent
  nodeRssKb: number | null;     // node next dev
  serverRssKb: number | null;   // next-server (v16.4.2) — the actual server
  pgBackends: number | null;    // PG active backends
}

const memSamples: Sample[] = [];
let nextPid: number | null = null;
try {
  nextPid = parseInt(readFileSync("/home/z/my-project/scripts/next-server.pid", "utf8").trim(), 10);
} catch {}

function findNextServerPids(): { bunx: number | null; node: number | null; server: number | null } {
  try {
    // ps lists all related processes
    const out = execSync(`ps -eo pid,rss,cmd 2>/dev/null | grep -E "next dev|next-server" | grep -v grep`).toString();
    const lines = out.trim().split("\n");
    let bunx: number | null = null;
    let node: number | null = null;
    let server: number | null = null;
    for (const line of lines) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1]!, 10);
      const cmd = m[3]!;
      if (cmd.includes("bunx next dev")) bunx = pid;
      else if (cmd.includes("next-server")) server = pid;
      else if (cmd.includes("node") && cmd.includes("next dev")) node = pid;
    }
    return { bunx, node, server };
  } catch {
    return { bunx: null, node: null, server: null };
  }
}

function rssOf(pid: number | null): number | null {
  if (!pid) return null;
  try {
    const out = execSync(`ps -o rss= -p ${pid} 2>/dev/null || true`).toString().trim();
    const v = parseInt(out, 10);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function sample() {
  const t = Date.now();
  const pids = findNextServerPids();
  const bunxRssKb = rssOf(pids.bunx);
  const nodeRssKb = rssOf(pids.node);
  const serverRssKb = rssOf(pids.server);
  let pgBackends: number | null = null;
  try {
    const out = execSync(
      `PGPASSWORD=postgres /home/z/my-project/opt/pg16/bin/psql -h localhost -p 5433 -U postgres -d balance -t -A -c "SELECT count(*) FROM pg_stat_activity WHERE datname='balance';" 2>/dev/null || echo "0"`
    ).toString().trim();
    const v = parseInt(out, 10);
    if (Number.isFinite(v)) pgBackends = v;
  } catch {}
  memSamples.push({ t, bunxRssKb, nodeRssKb, serverRssKb, pgBackends });
}

async function main() {
  console.log("=".repeat(70));
  console.log("PHASE 3 — Stability: 10 connections × 10 minutes against /api/v1/meta");
  console.log("=".repeat(70));
  console.log(`Next.js PID (for memory): ${nextPid ?? "n/a"}`);
  console.log("");

  // Sample every 30s for 10 minutes
  const sampleInterval = setInterval(sample, 30000);
  sample(); // initial sample

  // Run sustained load
  const r = await autocannon({
    url: `${BASE_URL}/api/v1/meta`,
    method: "GET",
    connections: 10,
    duration: 600, // 10 minutes
    workers: 2,
    timeout: 30,
  });

  clearInterval(sampleInterval);
  sample(); // final sample

  console.log("");
  console.log("=== Stability test result (10 minutes sustained) ===");
  console.log(`Total requests: ${r.requests.total} sent, ${r["2xx"] ?? 0} 2xx, ${r["4xx"] ?? 0} 4xx, ${r["5xx"] ?? 0} 5xx, ${r.errors ?? 0} errors`);
  console.log(`Avg rps: ${Math.round(r.requests.average)}`);
  console.log(`Latency (ms): p50=${(r.latency.p50 ?? 0).toFixed(1)}, p95=${(r.latency.p97_5 ?? 0).toFixed(1)}, p99=${(r.latency.p99 ?? 0).toFixed(1)}`);
  console.log(`Latency min/max: ${r.latency.min ?? "n/a"} / ${r.latency.max ?? "n/a"} ms`);

  console.log("");
  console.log("=== Memory samples (all Next.js PIDs + PG backends, every 30s) ===");
  if (memSamples.length === 0) {
    console.log("(no samples — ps/psql unavailable)");
  } else {
    console.log("t_offset_s | bunx_mb | node_mb | server_mb | pg_backends");
    const t0 = memSamples[0]!.t;
    let minServer = Infinity, maxServer = -Infinity, minPg = Infinity, maxPg = -Infinity;
    for (const s of memSamples) {
      const off = Math.round((s.t - t0) / 1000);
      const bunx = s.bunxRssKb ? (s.bunxRssKb / 1024).toFixed(1) : "n/a";
      const node = s.nodeRssKb ? (s.nodeRssKb / 1024).toFixed(1) : "n/a";
      const srv = s.serverRssKb ? (s.serverRssKb / 1024).toFixed(1) : "n/a";
      const pg = s.pgBackends ?? "n/a";
      console.log(`${String(off).padStart(10)} | ${String(bunx).padStart(7)} | ${String(node).padStart(7)} | ${String(srv).padStart(9)} | ${String(pg).padStart(11)}`);
      if (s.serverRssKb) { minServer = Math.min(minServer, s.serverRssKb); maxServer = Math.max(maxServer, s.serverRssKb); }
      if (s.pgBackends != null) { minPg = Math.min(minPg, s.pgBackends); maxPg = Math.max(maxPg, s.pgBackends); }
    }
    console.log("");
    if (Number.isFinite(minServer)) {
      console.log(`next-server RSS range: ${(minServer / 1024).toFixed(1)} MB → ${(maxServer / 1024).toFixed(1)} MB (growth: ${((maxServer - minServer) / 1024).toFixed(1)} MB)`);
    }
    if (Number.isFinite(minPg)) {
      console.log(`PG backends range: ${minPg} → ${maxPg}`);
    }
  }

  // Save results
  writeFileSync(
    "/home/z/my-project/scripts/load-test-stability-results.json",
    JSON.stringify({
      duration_s: 600,
      connections: 10,
      rps_avg: Math.round(r.requests.average),
      rps_total: r.requests.total,
      p50: r.latency.p50,
      p95: r.latency.p97_5,
      p99: r.latency.p99,
      min: r.latency.min,
      max: r.latency.max,
      errors: r.errors,
      non2xx: r.non2xx,
      mem_samples: memSamples,
    }, null, 2)
  );
  console.log("\nResults saved: /home/z/my-project/scripts/load-test-stability-results.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
