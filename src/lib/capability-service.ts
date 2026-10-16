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
  if (!session || !session.user) {
    throw new Error("Unauthenticated: no session");
  }
  const userId = session.user.id;
  const tenantId = session.user.tenantId;
  if (!userId || !tenantId) {
    throw new Error("Session missing required claims");
  }

  // Step 1: Verify capability + eligibility + taskId ownership (short transaction)
  const { capability, verifiedTaskId } = await withAuthenticatedTenant(session, async ({ tx }) => {
    const cap = await tx.capability.findUnique({
      where: { code: capabilityCode },
    });

    if (!cap) {
      throw new Error(`Capability '${capabilityCode}' not found`);
    }

    // Check eligibility (CURRENT DB role)
    await requirePermissionWithCurrentRole(session, cap.requiredPermission);

    // Verify taskId belongs to same tenant (if provided)
    let verifiedTaskId: string | null = null;
    if (taskId) {
      const task = await tx.task.findFirst({
        where: { id: taskId, tenantId },
      });
      if (!task) {
        throw new Error(
          `Task '${taskId}' not found in tenant scope — cannot link invocation to cross-tenant task`
        );
      }
      verifiedTaskId = task.id;
    }

    return { capability: cap, verifiedTaskId };
  });

  // Step 2: Record invocation start (short transaction, then close)
  const invocationId = await withAuthenticatedTenant(session, async ({ tx }) => {
    const invocation = await tx.capabilityInvocation.create({
      data: {
        tenantId,
        capabilityId: capability.id,
        taskId: verifiedTaskId,
        invokedBy: userId,
        input: input as Prisma.InputJsonValue,
        status: "running",
      },
    });
    return invocation.id;
  });

  // Step 3: Execute adapter OUTSIDE any database transaction
  // This prevents long-running adapters from holding PostgreSQL transactions open.
  try {
    // NO SILENT FALLBACK: if adapterEndpoint is specified but adapter not registered, FAIL.
    // Only use stub if the capability's readiness is explicitly "stub" or adapterEndpoint is null/empty.
    const adapterName = capability.adapterEndpoint;
    let adapter: ExpertAdapter | null = null;

    if (adapterName && adapterName.trim().length > 0) {
      adapter = getAdapter(adapterName);
      if (!adapter) {
        // Adapter specified but not registered — FAIL, don't fall back to stub
        throw new Error(
          `Adapter '${adapterName}' is not registered. ` +
            `Capability '${capabilityCode}' cannot be invoked — adapter missing. ` +
            `Use readiness='stub' with no adapterEndpoint for simulated execution.`
        );
      }
    } else {
      // No adapterEndpoint — use stub ONLY if readiness is "stub"
      if (capability.readiness === "stub") {
        adapter = getAdapter("stub");
      } else if (capability.readiness === "mock") {
        adapter = getAdapter("mock") ?? getAdapter("stub");
      } else {
        // live/untested with no adapter — FAIL
        throw new Error(
          `Capability '${capabilityCode}' has readiness='${capability.readiness}' ` +
            `but no adapterEndpoint specified. Cannot execute.`
        );
      }
    }

    if (!adapter) {
      throw new Error(`No adapter available for capability '${capabilityCode}'`);
    }

    // Execute the adapter (NO database transaction held during this call)
    const result = await adapter.execute(input);

    // Step 4: Record completion (new short transaction)
    await withAuthenticatedTenant(session, async ({ tx }) => {
      await tx.capabilityInvocation.update({
        where: { id: invocationId },
        data: {
          status: "completed",
          output: result.output as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
    });

    return {
      invocationId,
      status: "completed",
      output: result.output,
      provider: result.provider,
      simulated: result.simulated,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Step 4 (failure path): Record failure (new short transaction)
    await withAuthenticatedTenant(session, async ({ tx }) => {
      await tx.capabilityInvocation.update({
        where: { id: invocationId },
        data: {
          status: "failed",
          error: errorMsg,
          completedAt: new Date(),
        },
      });
    });

    return {
      invocationId,
      status: "failed",
      error: errorMsg,
      provider: "error",
      simulated: false,
    };
  }
}
