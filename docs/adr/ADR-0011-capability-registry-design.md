# ADR-0011 — Capability Registry Design

**Date:** 2026-10-16
**Status:** Accepted
**Mission:** 00-07

## Context

The Balance needs a unified registry of tools, experts, and operational sources that Balance Master can use to execute tasks. The founder directed:
- Registry + Adapters first, no new Swarm system
- Balance Master stays independent of providers/tools/experts
- Registered ≠ available or tested
- Distinguish Stub/Mock/Live clearly
- Don't make Swarm mandatory for every task

## Decision

### Two-table model

1. **`capabilities`** (PUBLIC) — global registry of tools/experts/adapters
   - `code` (unique), `displayName`, `description`, `type` (tool/expert/source/adapter)
   - `readiness`: stub | mock | live | untested
   - `inputSchema` / `outputSchema` (JSON Schema)
   - `requiredPermission`: which RBAC permission is needed to invoke
   - `domains`: array of domain tags (e.g., ["agriculture", "finance"])
   - `adapterEndpoint`: which adapter to use (null = stub)
   - RLS: PUBLIC read for all tenants; admin-only write

2. **`capability_invocations`** (PRIVATE, tenant-scoped) — execution log
   - Records each invocation: who, what, when, input, output, status
   - Links to `taskId` if invoked as part of a task
   - RLS: tenant-scoped (only own tenant's invocations visible)

### ExpertAdapter contract

```typescript
interface ExpertAdapter {
  readonly name: string;
  readonly readiness: "stub" | "mock" | "live";
  execute(input: Record<string, unknown>): Promise<{
    output: Record<string, unknown>;
    provider: string;
    simulated: boolean;
  }>;
}
```

- `StubAdapter`: deterministic, SIMULATED — always returns canned response
- Future adapters: `ZaiAdapter`, `OpenAIAdapter`, etc.
- Adapters are registered in-process via `registerAdapter()`
- `invokeCapability()` looks up the adapter by `adapterEndpoint` (defaults to "stub")

### Capability discovery

- `discoverCapabilities(session, filters)`: filter by type, domain, readiness
- PUBLIC read — any tenant can see all registered capabilities
- The capability itself doesn't guarantee availability — `readiness` tells the truth

### Eligibility check

- `checkEligibility(session, capabilityCode)`: checks `requiredPermission` against CURRENT DB role
- Uses `requirePermissionWithCurrentRole` (not stale JWT role)
- Observer might see a capability but cannot invoke it (permission denied)

### Swarm-engine reuse assessment

**READ-ONLY review of `mayakilzy/swarm-engine` (SHA: 220d739)**:

| swarm-engine component | Reuse decision | Rationale |
|---|---|---|
| `AgentMeta` schema | **Pattern reference only** | The Balance's `Capability` model is broader (permissions, readiness, schemas) |
| `WebMCPTool<IArgs, IResult>` interface | **Pattern reference** | The Balance's `ExpertAdapter` is simpler and TypeScript-native |
| `NegotiationResponse` + `ObjectionRule` | **Defer to GROUP 02** | Not needed in 00-07; A2A negotiation is a future engine concern |
| `SubAgentFactory` | **Not reused** | The Balance uses `Task` + `BalanceMaster` instead |
| `MockRAGProvider` | **Not reused** | The Balance has real pgvector (00-04) |
| `simulateResponse()` | **Not reused** | The Balance's `StubAdapter` is the honest simulation layer |
| React UI components (48 shadcn/ui) | **Not reused** | UI is mission 00-08, and The-Balance has its own UI |

**Conclusion**: swarm-engine is 100% mock/simulated. No code is reused. Only architectural patterns informed the design. The `AgentMeta` concept (typed agent metadata) inspired the `Capability` model, and the `WebMCPTool<IArgs, IResult>` generic interface inspired the `ExpertAdapter` contract.

### Honest classification

- `StubAdapter` is SIMULATED — returns deterministic canned responses
- `readiness: "stub"` on capabilities honestly discloses this
- No capability is presented as "live" or "tested" unless explicitly marked
- The API response includes `simulated: true` for stub invocations

## Verification (00-07)

1. Register capability → discoverable ✓
2. Discover by type/domain ✓
3. Admin eligible for evidence:read capability ✓
4. Analyst NOT eligible for strategy:approve capability ✓
5. Invoke capability → stub adapter returns simulated result ✓
6. Unauthorized invocation rejected (Permission denied) ✓
7. Cross-tenant: invocations are tenant-scoped ✓
8. Invocation audit trail recorded ✓
