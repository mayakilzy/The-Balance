// ============================================================
// db.ts — Prisma client singleton
// ------------------------------------------------------------
// One PrismaClient per Node.js process. In dev, Next.js hot-reloads
// modules; we cache the client on globalThis to avoid connection leaks.
// ============================================================
import { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";

const globalForPrisma = globalThis as unknown as {
  __prismaClient?: PrismaClient;
};

export const db =
  globalForPrisma.__prismaClient ??
  new PrismaClient({
    log:
      env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (env.NODE_ENV !== "production") {
  globalForPrisma.__prismaClient = db;
}
