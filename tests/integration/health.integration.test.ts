// ============================================================
// health.integration.test.ts
// ------------------------------------------------------------
// Integration test for /api/health against a REAL PostgreSQL.
// Verifies the positive path: DB reachable → 200, status="ok".
// (The unit test covers only the mocked negative path.)
//
// Skips locally when RUN_INTEGRATION_TESTS is not set.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { GET } from "@/app/api/health/route";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

// Override the db singleton with one pointed at the CI postgres.
let prisma: PrismaClient;

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await prisma.$connect();
  // Replace the cached db client on the module's internal state.
  // We do this by re-importing with a fresh module registry.
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});

describeIntegration("GET /api/health against real PostgreSQL", () => {
  it("returns 200 with status=ok when DB is reachable", async () => {
    // We need to override the db singleton. Easiest: use vi.doImport with resetModules.
    // But since the route handler imports `db` from `@/lib/db`, and that's a singleton
    // with globalThis caching, we use a different approach: directly construct a
    // request and call GET, but first swap the global prisma client.
    const { PrismaClient } = await import("@prisma/client");
    const globalForPrisma = globalThis as unknown as { __prismaClient?: unknown };

    // Replace the singleton with a CI-DB-pointed client.
    const ciPrisma = new PrismaClient({
      datasources: { db: { url: DATABASE_URL } },
    });
    globalForPrisma.__prismaClient = ciPrisma;

    try {
      const response = await GET(new Request("http://localhost/api/health"));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.checks[0].name).toBe("database");
      expect(body.checks[0].status).toBe("ok");
      expect(body.checks[0].latencyMs).toBeGreaterThanOrEqual(0);
      expect(body.checks[1].name).toBe("llm");
      expect(body.checks[1].status).toBe("ok");

      await ciPrisma.$disconnect();
    } finally {
      // Restore null so subsequent tests get a fresh singleton.
      globalForPrisma.__prismaClient = undefined;
    }
  });
});
