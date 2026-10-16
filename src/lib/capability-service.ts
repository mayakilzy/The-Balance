// ============================================================
// capability-service.ts — Capability Registry + ExpertAdapter
// ------------------------------------------------------------
// Handles:
//   - Registering capabilities (admin)
//   - Discovering capabilities by domain/type/permission
//   - Checking user eligibility to invoke
//   - Executing capabilities via ExpertAdapter contract
//   - Recording invocations (tenant-scoped audit trail)
//
// The ExpertAdapter is a contract — not a specific implementation.
// StubAdapter returns deterministic responses (SIMULATED).
// Future adapters: ZaiAdapter, OpenAIAdapter, etc.
// ============================================================
import { db } from "@/lib/db";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

// ============================================================
// EXPERT ADAPTER CONTRACT
// ============================================================

export interface ExpertAdapter {
  readonly name: string;
  readonly readiness: "stub" | "mock" | "live";

  execute(input: Record<string, unknown>): Promise<{
    output: Record<string, unknown>;
    provider: string;
    simulated: boolean;
  }>;
}

// ============================================================
// STUB ADAPTER (deterministic, SIMULATED)
// ============================================================

export class StubAdapter implements ExpertAdapter {
  readonly name = "stub-adapter";
  readonly readiness = "stub" as const;

  async execute(input: Record<string, unknown>): Promise<{
    output: Record<string, unknown>;
    provider: string;
    simulated: boolean;
  }> {
    return {
      output: {
        result: "[STUB ADAPTER — simulated response]",
        inputReceived: Object.keys(input),
        timestamp: new Date().toISOString(),
      },
      provider: this.name,
      simulated: true,
    };
  }
}

// Adapter registry (in-process; future: DB-backed)
const adapters: Record<string, ExpertAdapter> = {
  stub: new StubAdapter(),
};

export function registerAdapter(name: string, adapter: ExpertAdapter): void {
  adapters[name] = adapter;
}

export function getAdapter(name: string): ExpertAdapter | null {
  return adapters[name] ?? null;
}

// ============================================================
// REGISTER CAPABILITY (admin-only via balance_admin / seed)
// ============================================================

export interface RegisterCapabilityInput {
  code: string;
  displayName: string;
  description: string;
  type: "tool" | "expert" | "source" | "adapter";
  readiness?: "stub" | "mock" | "live" | "untested";
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredPermission: string;
  domains?: string[];
  adapterEndpoint?: string;
  metadata?: Record<string, unknown>;
}

export async function registerCapability(
  input: RegisterCapabilityInput
): Promise<{ capabilityId: string }> {
  // This uses balance_admin (DIRECT_URL) because capabilities are PUBLIC
  // and balance_app cannot INSERT into PUBLIC tables (RLS blocks writes).
  const adminDb = new (await import("@prisma/client")).PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL! } },
  });

  try {
    const capability = await adminDb.capability.upsert({
      where: { code: input.code },
      update: {
        displayName: input.displayName,
        description: input.description,
        type: input.type,
        readiness: input.readiness ?? "stub",
        inputSchema: (input.inputSchema ?? {}) as Prisma.InputJsonValue,
        outputSchema: (input.outputSchema ?? {}) as Prisma.InputJsonValue,
        requiredPermission: input.requiredPermission,
        domains: (input.domains ?? []) as Prisma.InputJsonValue,
        adapterEndpoint: input.adapterEndpoint,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
      create: {
        code: input.code,
        displayName: input.displayName,
        description: input.description,
        type: input.type,
        readiness: input.readiness ?? "stub",
        inputSchema: (input.inputSchema ?? {}) as Prisma.InputJsonValue,
        outputSchema: (input.outputSchema ?? {}) as Prisma.InputJsonValue,
        requiredPermission: input.requiredPermission,
        domains: (input.domains ?? []) as Prisma.InputJsonValue,
        adapterEndpoint: input.adapterEndpoint,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });

    return { capabilityId: capability.id };
  } finally {
    await adminDb.$disconnect();
  }
}

// ============================================================
// DISCOVER CAPABILITIES (tenant-scoped read)
// ============================================================

export async function discoverCapabilities(
  session: Session,
  filters?: {
    type?: string;
    domain?: string;
    readiness?: string;
  }
): Promise<Array<{
  id: string;
  code: string;
  displayName: string;
  description: string;
  type: string;
  readiness: string;
  requiredPermission: string;
  domains: string[];
}>> {
  return withAuthenticatedTenant(session, async ({ tx }) => {
    // capabilities are PUBLIC — any tenant can read
    const capabilities = await tx.capability.findMany({
      where: {
        ...(filters?.type ? { type: filters.type } : {}),
        ...(filters?.readiness ? { readiness: filters.readiness } : {}),
      },
      select: {
        id: true,
        code: true,
        displayName: true,
        description: true,
        type: true,
        readiness: true,
        requiredPermission: true,
        domains: true,
      },
      orderBy: { code: "asc" },
    });

    // Filter by domain if requested (domains is JSONB array)
    let result = capabilities;
    if (filters?.domain) {
      result = capabilities.filter((c) => {
        const domains = c.domains as unknown as string[];
        return Array.isArray(domains) && domains.includes(filters.domain!);
      });
    }

    return result.map((c) => ({
      ...c,
      domains: c.domains as unknown as string[],
    }));
  });
}

// ============================================================
// CHECK ELIGIBILITY (user can invoke this capability?)
// ============================================================

export async function checkEligibility(
  session: Session,
  capabilityCode: string
): Promise<{ eligible: boolean; reason?: string }> {
  if (!session || !session.user) {
    return { eligible: false, reason: "Not authenticated" };
  }

  // Find the capability (PUBLIC read — use tx from any tenant context)
  return withAuthenticatedTenant(session, async ({ tx }) => {
    const capability = await tx.capability.findUnique({
      where: { code: capabilityCode },
    });

    if (!capability) {
      return { eligible: false, reason: "Capability not found" };
    }

    // Check required permission using CURRENT DB role (not stale JWT)
    try {
      await requirePermissionWithCurrentRole(session, capability.requiredPermission);
      return { eligible: true };
    } catch {
      return {
        eligible: false,
        reason: `Missing permission: ${capability.requiredPermission}`,
      };
    }
  });
}

// ============================================================
// INVOKE CAPABILITY (execute via adapter + record invocation)
// ============================================================

export async function invokeCapability(
  session: Session,
  capabilityCode: string,
  input: Record<string, unknown>,
  taskId?: string
): Promise<{
  invocationId: string;
  status: "completed" | "failed";
  output?: Record<string, unknown>;
  error?: string;
  provider: string;
  simulated: boolean;
}> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // Find the capability
    const capability = await tx.capability.findUnique({
      where: { code: capabilityCode },
    });

    if (!capability) {
      throw new Error(`Capability '${capabilityCode}' not found`);
    }

    // Check eligibility (CURRENT DB role)
    await requirePermissionWithCurrentRole(session, capability.requiredPermission);

    // Record invocation start
    const invocation = await tx.capabilityInvocation.create({
      data: {
        tenantId,
        capabilityId: capability.id,
        taskId: taskId ?? null,
        invokedBy: userId,
        input: input as Prisma.InputJsonValue,
        status: "pending",
      },
    });

    try {
      // Get adapter (default to stub if no adapterEndpoint)
      const adapterName = capability.adapterEndpoint ?? "stub";
      const adapter = getAdapter(adapterName) ?? getAdapter("stub")!;

      // Execute
      const result = await adapter.execute(input);

      // Record completion
      await tx.capabilityInvocation.update({
        where: { id: invocation.id },
        data: {
          status: "completed",
          output: result.output as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });

      return {
        invocationId: invocation.id,
        status: "completed",
        output: result.output,
        provider: result.provider,
        simulated: result.simulated,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      await tx.capabilityInvocation.update({
        where: { id: invocation.id },
        data: {
          status: "failed",
          error: errorMsg,
          completedAt: new Date(),
        },
      });

      return {
        invocationId: invocation.id,
        status: "failed",
        error: errorMsg,
        provider: "error",
        simulated: false,
      };
    }
  });
}
