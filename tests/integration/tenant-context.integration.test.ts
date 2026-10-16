// ============================================================
// tenant-context.integration.test.ts
// ------------------------------------------------------------
// Integration test that exercises the tenant-context helpers
// against a REAL PostgreSQL instance (not a mock).
//
// Runs in CI against the `pgvector/pgvector:pg16` service container.
// Skips locally when DATABASE_URL is unreachable OR when
// RUN_INTEGRATION_TESTS is not set, so `bun run test` still works
// in the sandbox without a database.
//
// Covers:
//   1. setTenantContext sets app.tenant_id within a transaction
//   2. getTenantContext reads back the value
//   3. clearTenantContext clears the value
//   4. The setting is LOCAL to the transaction (does not leak)
//   5. set_config bind-parameter syntax works (no SQL injection)
//   6. Real DB round-trip: prisma can SELECT 1
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  setTenantContext,
  getTenantContext,
  clearTenantContext,
} from "@/lib/security/tenant-context";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";

// Skip the entire suite when integration conditions aren't met.
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

let prisma: PrismaClient;

async function canConnect(): Promise<boolean> {
  try {
    const p = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    await p.$queryRaw`SELECT 1`;
    await p.$disconnect();
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  // Verify connectivity — fail fast with a clear message if DB is down.
  const connected = await canConnect();
  if (!connected) {
    throw new Error(
      "RUN_INTEGRATION_TESTS=1 but DATABASE_URL is unreachable. " +
        "Ensure the Postgres service is running and DATABASE_URL is set correctly."
    );
  }
});

afterAll(async () => {
  if (prisma) {
    await prisma.$disconnect();
  }
});

describeIntegration("tenant-context against real PostgreSQL", () => {
  it("prisma can connect and SELECT 1", async () => {
    const rows = await prisma.$queryRaw<{ "?column?": number }[]>`SELECT 1`;
    expect(rows[0]?.["?column?"]).toBe(1);
  });

  it("setTenantContext sets app.tenant_id within a transaction", async () => {
    const tenantId = "tenant_test_001";
    const result = await prisma.$transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      return await getTenantContext(tx);
    });
    expect(result).toBe(tenantId);
  });

  it("clearTenantContext resets the value to empty", async () => {
    const result = await prisma.$transaction(async (tx) => {
      await setTenantContext(tx, "tenant_temp");
      await clearTenantContext(tx);
      return await getTenantContext(tx);
    });
    expect(result).toBeNull();
  });

  it("tenant_id does NOT leak outside the transaction", async () => {
    // Set inside a transaction...
    await prisma.$transaction(async (tx) => {
      await setTenantContext(tx, "tenant_should_not_leak");
      const inside = await getTenantContext(tx);
      expect(inside).toBe("tenant_should_not_leak");
    });
    // ...then check a fresh transaction sees no tenant.
    const outside = await prisma.$transaction(async (tx) => {
      return await getTenantContext(tx);
    });
    expect(outside).toBeNull();
  });

  it("set_config with bind parameter prevents SQL injection", async () => {
    // A malicious tenantId that contains SQL — must be treated as a literal.
    const malicious = "tenant'; DROP TABLE tenants; --";
    const result = await prisma.$transaction(async (tx) => {
      await setTenantContext(tx, malicious);
      return await getTenantContext(tx);
    });
    // The malicious string should be stored verbatim — not executed as SQL.
    expect(result).toBe(malicious);
    // And the tenants table must still exist (proving no DROP happened).
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE tablename = 'tenants'
    `;
    expect(tables.length).toBe(1);
    expect(tables[0]?.tablename).toBe("tenants");
  });

  it("setTenantContext rejects empty string", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await setTenantContext(tx, "");
      })
    ).rejects.toThrow(/non-empty string/);
  });

  it("setTenantContext rejects values > 256 chars", async () => {
    const longId = "x".repeat(257);
    await expect(
      prisma.$transaction(async (tx) => {
        await setTenantContext(tx, longId);
      })
    ).rejects.toThrow(/exceeds 256 chars/);
  });
});
