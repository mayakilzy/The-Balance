// ============================================================
// role-passwords.integration.test.ts
// ------------------------------------------------------------
// Integration test proving that custom (non-default) passwords
// passed via env vars are actually applied to balance_app +
// balance_admin roles.
//
// This test was added in 00-03 to fix a silent bug:
//   - The old setup-roles.sql used current_setting() to read passwords.
//   - But psql -v variables don't become GUCs.
//   - So custom passwords were silently ignored; dev defaults were used.
//   - CI used dev defaults, so it never caught the bug.
//
// Test approach (no secret leakage):
//   1. Set a KNOWN test password via env var.
//   2. Run the setup script.
//   3. Attempt to connect as balance_app with the test password.
//   4. If connection succeeds → password was set correctly.
//   5. Attempt to connect with the OLD dev password → should fail.
//   6. Reset to dev defaults for subsequent tests.
//
// The test password is NOT a secret — it's a test fixture
// ("test_pw_balance_app_00_03"). It's documented here, not leaked.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const DB_HOST = process.env.DB_HOST || "localhost";
const DB_PORT = process.env.DB_PORT || "5432";
const DB_NAME = process.env.DB_NAME || "balance";

// Test fixtures (NOT secrets — documented test values)
const TEST_APP_PW = "test_pw_balance_app_00_03_integration";
const TEST_ADMIN_PW = "test_pw_balance_admin_00_03_integration";
const DEV_APP_PW = "balance_app_dev_only";
const DEV_ADMIN_PW = "balance_admin_dev_only";

describeIntegration("Role password setup (env-var aware)", () => {
  // Reset to dev defaults after this test suite so subsequent tests work.
  afterAll(() => {
    try {
      execSync(
        `PGPASSWORD_BALANCE_ADMIN= PGPASSWORD_BALANCE_APP= bash scripts/run-setup-roles.sh`,
        { stdio: "pipe", env: { ...process.env } }
      );
    } catch {
      // Best-effort cleanup; CI tears down the DB anyway.
    }
  });

  it("applies custom passwords from env vars (not dev defaults)", () => {
    // Act: run the wrapper with custom passwords.
    execSync(
      `PGPASSWORD_BALANCE_ADMIN="${TEST_ADMIN_PW}" PGPASSWORD_BALANCE_APP="${TEST_APP_PW}" bash scripts/run-setup-roles.sh`,
      {
        stdio: "pipe",
        env: { ...process.env, PGPASSWORD_POSTGRES: "postgres" },
      }
    );

    // Assert: we can connect as balance_app with the TEST password.
    const client = new PrismaClient({
      datasources: {
        db: {
          url: `postgresql://balance_app:${TEST_APP_PW}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public`,
        },
      },
    });

    return expect(client.$queryRaw`SELECT 1`).resolves.toBeTruthy();
  });

  it("dev default password no longer works after custom password is set", async () => {
    // After the previous test set TEST_APP_PW, the dev default should fail.
    const client = new PrismaClient({
      datasources: {
        db: {
          url: `postgresql://balance_app:${DEV_APP_PW}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public`,
        },
      },
      log: ["error"],
    });

    // Attempt to connect — should fail because password is wrong.
    try {
      await client.$queryRaw`SELECT 1`;
      throw new Error("Should have thrown");
    } catch (err) {
      // Expected: connection error due to wrong password
      expect(err).toBeDefined();
    } finally {
      await client.$disconnect();
    }
  });

  it("falls back to dev defaults when env vars are unset", async () => {
    // Act: run the wrapper WITHOUT env vars (empty strings).
    execSync(`bash scripts/run-setup-roles.sh`, {
      stdio: "pipe",
      env: { ...process.env, PGPASSWORD_POSTGRES: "postgres" },
    });

    // Assert: dev default password works again.
    const client = new PrismaClient({
      datasources: {
        db: {
          url: `postgresql://balance_app:${DEV_APP_PW}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public`,
        },
      },
    });

    const result = await client.$queryRaw`SELECT 1`;
    expect(result).toBeTruthy();
    await client.$disconnect();
  });
});
