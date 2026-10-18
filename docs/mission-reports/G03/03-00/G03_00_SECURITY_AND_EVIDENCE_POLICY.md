# G03-00 — Security & Evidence Policy

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Security + evidence policy specification (DESIGN ONLY — no code)
> **Date:** 2026-10-18
> **Author:** GLM (implementation agent)
> **Status:** PROPOSED — awaiting owner + reviewer approval
> **Companion to:** `G03_00_ARCHITECTURE_PROPOSAL.md` §3, §8

---

## 1. Overview

This document specifies the **security model** and **evidence policy** for GROUP 03. It extends the inherited G00/G01/G02 security posture (per ADR-0003, ADR-0005, ADR-0008, ADR-0012) to the new reform entities, with explicit attention to:

1. **Multi-tenancy isolation** — RLS enforcement on all 7 new tables
2. **RBAC/ABAC permission model** — 9 new permissions + per-role matrix
3. **Audit trail sovereignty** — atomic, append-only, denied-attempt logging
4. **Evidence handling** — snapshot vs live link, completeness checks, provenance
5. **LLM boundaries** — advisory only, simulated flag, no causal claims
6. **F6 enforcement** — triple-layer verification pattern
7. **Causal attribution prohibition** — descriptive-only invariants enforced at DB level
8. **Publication fail-closed** — no public/research exposure without explicit approval workflow (G02-L25)

### 1.1 Inherited Security Posture

GROUP 03 inherits the full G00 security stack (per ADR-0012):

| Layer | Component | G03 usage |
|-------|-----------|-----------|
| HTTP | CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, HSTS | Inherited (no changes to middleware.ts) |
| Rate limiting | In-memory per-IP (G00) | Extended to G03 routes (§5.3 of INTEGRATION_CONTRACTS.md) |
| Error sanitization | `error-sanitizer.ts` | Inherited — strips paths, SQL, env vars, stacks |
| Logging | `pino` + `redactSensitive()` | Inherited — G03 loggers use `childLogger({ module: "reform" })` |
| Metrics | In-process Prometheus | Extended with `reform_*` metrics |
| Audit log | `audit_log` table (append-only, RLS) | Inherited + extended with G03 actions |
| IP hashing | SHA-256 + AUTH_SECRET salt | Inherited — all G03 audit entries use hashed IPs |
| RBAC | `permissions.ts` static catalog + `requirePermissionWithCurrentRole` | Extended with 9 new permissions |
| RLS | `balance_app` (tenant-scoped), `balance_admin` (BYPASSRLS), `balance_auth` (read-only) | Extended to 7 new tables |
| Demo credentials | `SHOW_DEMO_CREDENTIALS` env var | Inherited — no G03 changes |

---

## 2. Multi-Tenancy Isolation

### 2.1 RLS Policy Pattern

All 7 new G03 tables follow the exact RLS pattern established in G00 (mission 00-02) and reused in G01 (mission 01-00) and G02 (mission 02-00):

```sql
-- Per-table (example: reform_proposals)
ALTER TABLE reform_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE reform_proposals FORCE ROW LEVEL SECURITY;

-- balance_app: tenant-scoped access (RLS-enforced)
CREATE POLICY reform_proposals_tenant_isolation ON reform_proposals
  FOR ALL
  TO balance_app
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- balance_admin: full access (for migrations + seed only — BYPASSRLS)
CREATE POLICY reform_proposals_admin_all ON reform_proposals
  FOR ALL
  TO balance_admin
  USING (true)
  WITH CHECK (true);

-- Grant DML to balance_app
GRANT SELECT, INSERT, UPDATE, DELETE ON reform_proposals TO balance_app;
```

### 2.2 The Seven Tables + Their Variants

| Table | RLS pattern | DML grants | Special restrictions |
|-------|-----------|-----------|---------------------|
| `reform_proposals` | Standard (tenant-scoped) | SELECT, INSERT, UPDATE, DELETE | None (full CRUD) |
| `reform_alternatives` | Standard | SELECT, INSERT, UPDATE, DELETE | None |
| `reform_approvals` | Standard | SELECT, INSERT only | UPDATE + DELETE REVOKED (immutable post-approval) |
| `reform_actions` | Standard | SELECT, INSERT, UPDATE, DELETE | None |
| `reform_action_updates` | Standard | SELECT, INSERT only | UPDATE + DELETE REVOKED (append-only) |
| `reform_verifications` | Standard | SELECT, INSERT, UPDATE | DELETE REVOKED (one per action; upserted) |
| `reform_feedback_loops` | Standard | SELECT, INSERT only | UPDATE + DELETE REVOKED (immutable) |

### 2.3 Cross-Tenant Prevention (Service Layer + DB Triggers)

Cross-tenant access is prevented at **two layers**:

#### Layer 1: RLS (Database)

RLS ensures that `balance_app` queries only return rows where `"tenantId" = current_setting('app.tenant_id', true)`. A query from Tenant B for Tenant A's data returns zero rows.

#### Layer 2: Cross-Tenant Triggers (Database)

For relationships between G03 entities (e.g., `ReformAlternative.proposalId` → `ReformProposal.id`), a trigger ensures the `tenantId` matches:

```sql
CREATE OR REPLACE FUNCTION enforce_reform_alternative_same_tenant()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM 1 FROM reform_proposals
  WHERE id = NEW."proposalId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cross-tenant violation: ReformAlternative.tenantId must match ReformProposal.tenantId';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

This trigger fires BEFORE INSERT and BEFORE UPDATE on `reform_alternatives`. Similar triggers exist for `reform_approvals`, `reform_actions`, `reform_action_updates`, `reform_verifications`, and `reform_feedback_loops`.

#### Layer 3: Service Layer Validation

G03 services also validate cross-tenant references explicitly (defense in depth):

```typescript
// In reform-alternative-service.ts
export async function addReformAlternative(session, input) {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // Validate proposalId belongs to this tenant
    const proposal = await tx.reformProposal.findFirst({
      where: { id: input.proposalId, tenantId },
    });
    if (!proposal) {
      throw new NotFoundError(
        "Reform proposal not found in tenant scope — cross-tenant reference blocked"
      );
    }
    // ... rest of service
  });
}
```

### 2.4 Cross-Group FK Isolation

G03 references G01 and G02 entities via nullable FKs:

| G03 field | G01/G02 reference | Cross-tenant protection |
|-----------|-------------------|------------------------|
| `ReformProposal.originatingAlertId` | Alert (G02) | RLS on `alerts` + service check |
| `ReformProposal.originatingVarianceRecordId` | VarianceRecord (G02) | RLS on `variance_records` + service check |
| `ReformProposal.strategyVersionId` | StrategyVersion (G01) | RLS on `strategy_versions` + service check |
| `ReformProposal.objectiveId` | Objective (G01) | RLS on `objectives` + service check |
| `ReformAction.programId` | Program (G01) | RLS on `programs` + service check |
| `ReformAction.projectId` | Project (G01) | RLS on `projects` + service check |
| `ReformFeedbackLoop.beforeObservationId` | Observation (G02) | RLS on `observations` |
| `ReformFeedbackLoop.afterObservationId` | Observation (G02) | RLS on `observations` |
| `ReformFeedbackLoop.newVarianceRecordId` | VarianceRecord (G02) | RLS on `variance_records` |

**Critical**: All FK references use `ON DELETE SET NULL` (not CASCADE) to prevent G01/G02 cleanup from destroying G03 history. This mirrors G02's pattern of referencing G01 StrategyVersion (read-only FK with `SET NULL` on delete).

### 2.5 Tenant Context Enforcement

Every G03 service uses `withAuthenticatedTenant(session, fn)` from `src/lib/security/tenant-context.ts`. This:

1. Verifies the session is authenticated + active
2. Verifies the CURRENT membership (not stale JWT role)
3. Sets `app.user_id` + `app.tenant_id` in PostgreSQL
4. Returns `{ tx, userId, tenantId, roleCode }` for the callback

**No G03 service** is allowed to use the global `db` client directly (which would bypass tenant context). This is enforced by code review + integration tests.

---

## 3. RBAC/ABAC Permission Model

### 3.1 Nine New Permissions

G03 adds 9 permissions to the existing catalog in `src/lib/permissions.ts`:

| Permission | Purpose | Roles |
|-----------|---------|-------|
| `reform:proposal:read` | Read reform proposals | admin, analyst, reviewer, observer |
| `reform:proposal:write` | Draft/edit reform proposals | admin, analyst |
| `reform:proposal:approve` | Approve/reject reform proposals | admin, reviewer |
| `reform:alternative:read` | Read alternatives | admin, analyst, reviewer |
| `reform:alternative:write` | Draft/edit alternatives | admin, analyst |
| `reform:action:read` | Read reform actions | admin, analyst, reviewer, observer |
| `reform:action:write` | Create/update reform actions + progress updates | admin, analyst |
| `reform:action:verify` | Verify execution (F6 pattern) | admin, reviewer |
| `reform:verification:read` | Read verification records | admin, analyst, reviewer |

### 3.2 Permission Matrix (Complete)

| Permission | admin | reviewer | analyst | observer |
|-----------|:-----:|:--------:|:-------:|:--------:|
| `reform:proposal:read` | ✓ | ✓ | ✓ | ✓ |
| `reform:proposal:write` | ✓ | — | ✓ | — |
| `reform:proposal:approve` | ✓ | ✓ | — | — |
| `reform:alternative:read` | ✓ | ✓ | ✓ | — |
| `reform:alternative:write` | ✓ | — | ✓ | — |
| `reform:action:read` | ✓ | ✓ | ✓ | ✓ |
| `reform:action:write` | ✓ | — | ✓ | — |
| `reform:action:verify` | ✓ | ✓ | — | — |
| `reform:verification:read` | ✓ | ✓ | ✓ | — |

### 3.3 Design Rationale

The permission matrix follows the **separation of duties** principle from G01/G02:

1. **Drafting vs approval separation**: Analysts draft (`proposal:write`, `alternative:write`); reviewers approve (`proposal:approve`). No single role can both draft and approve the same proposal.

2. **Implementation vs verification separation**: Analysts implement (`action:write`); reviewers verify (`action:verify`). No single role can both implement and verify the same action.

3. **Observer exclusion from sensitive data**: Observers can see proposals + actions (high-level visibility) but NOT alternatives (detailed cost/risk analysis) or verifications (sensitive dispute records). This mirrors G01's `gap`/`program` exclusion for observers.

4. **Admin has all permissions**: Admin is the only role with full control, but every action is still audited. Admin is not a "super user" who bypasses audit — admin is a "trusted user" with broader scope.

### 3.4 Permission Check Implementation

Every privileged operation calls `requirePermissionWithCurrentRole(session, permission)`:

```typescript
// This function:
// 1. Verifies the session is authenticated + active
// 2. Fetches the CURRENT membership from DB (not stale JWT role)
// 3. Checks the permission against the CURRENT role
// 4. Throws PermissionDeniedError if not authorized
```

**Critical**: The CURRENT DB role is used, not the JWT role. This catches role changes mid-session (e.g., admin → observer) — the user's privileges are re-evaluated on every privileged operation.

### 3.5 Negative Test Coverage

G03 integration tests include negative tests (mirrors G00's RBAC negative tests):

```typescript
describe("G03 RBAC negative tests", () => {
  it("analyst cannot approve a proposal", async () => {
    await expect(
      approveReformProposalWithAuditSafe(analystSession, ...)
    ).rejects.toThrow(PermissionDeniedError);
  });

  it("observer cannot read alternatives", async () => {
    await expect(
      listReformAlternatives(observerSession, proposalId)
    ).rejects.toThrow(PermissionDeniedError);
  });

  it("analyst cannot verify an action", async () => {
    await expect(
      verifyReformAction(analystSession, ...)
    ).rejects.toThrow(PermissionDeniedError);
  });
});
```

---

## 4. Audit Trail Policy

### 4.1 Three-Layer Audit Pattern

Every G03 state transition writes to three layers (mirrors G01's `approveStrategyVersionWithAuditSafe` per ADR-0010 §13 Correction B):

| Layer | Table | Purpose | Atomicity |
|-------|-------|---------|-----------|
| 1. Authorization | (in-memory check) | `requirePermissionWithCurrentRole` enforces RBAC | Throws `PermissionDeniedError` on failure |
| 2. Domain Event | `events` (G00) | Generic domain timeline | Atomic with primary operation (same transaction) |
| 3. Audit Log | `audit_log` (G00) | Sovereign audit trail, compliance-grade | Atomic via `writeAuditTx` (same transaction) |

### 4.2 Audit Log Entry Structure

Every G03 audit entry follows the G00 `AuditEntry` structure:

```typescript
interface AuditEntry {
  tenantId?: string | null;
  actor?: string;            // userId or "system"
  action: string;            // e.g., "reform.proposal_approved"
  route?: string | null;     // HTTP route (when applicable)
  method?: string | null;    // HTTP method (when applicable)
  ip?: string | null;        // raw IP (hashed before storage)
  details?: Record<string, unknown>;  // structured payload (secrets stripped)
  status?: "ok" | "error" | "denied";
  errorCode?: string | null;
}
```

**Critical**:
- `ip` is hashed via `hashIp(ip)` (SHA-256 + AUTH_SECRET salt, truncated to 16 chars) BEFORE storage
- `details` is JSONB; callers MUST strip secrets before passing (defense in depth via `redactSensitive()` in the logger)
- `actor` defaults to `"system"` if not set (for non-user operations, e.g., cron jobs)

### 4.3 Audit Actions Catalog

| Action verb | Triggered by | Default status |
|-------------|--------------|----------------|
| `reform.proposal_created` | `createReformProposal()` | `ok` |
| `reform.proposal_submitted` | `submitForReview()` | `ok` |
| `reform.proposal_approved` | `approveReformProposal()` | `ok` / `denied` (on permission failure) |
| `reform.proposal_rejected` | `rejectReformProposal()` | `ok` |
| `reform.proposal_returned_to_draft` | `returnForRevision()` | `ok` |
| `reform.proposal_superseded` | `supersedeReformProposal()` (auto on new approval) | `ok` |
| `reform.alternative_added` | `addReformAlternative()` | `ok` |
| `reform.alternative_selected` | `selectAlternative()` | `ok` |
| `reform.alternative_withdrawn` | `withdrawAlternative()` | `ok` |
| `reform.action_created` | `createReformAction()` | `ok` |
| `reform.action_started` | `startReformAction()` | `ok` |
| `reform.action_blocked` | `blockReformAction()` | `ok` |
| `reform.action_unblocked` | `unblockReformAction()` | `ok` |
| `reform.action_completed` | `completeReformAction()` | `ok` |
| `reform.action_cancelled` | `cancelReformAction()` | `ok` |
| `reform.action_update_added` | `addReformActionUpdate()` | `ok` |
| `reform.verification_created` | `createReformVerification()` | `ok` |
| `reform.action_verified` | `verifyReformAction(status="verified")` | `ok` / `denied` |
| `reform.action_disputed` | `verifyReformAction(status="disputed")` | `ok` |
| `reform.feedback_created` | `createReformFeedbackLoop()` | `ok` |

### 4.4 Denied-Attempt Auditing

Denied permission attempts are audited via the `*WithAuditSafe` wrapper pattern (mirrors G01's `approveStrategyVersionWithAuditSafe`):

```typescript
try {
  return await approveReformProposal(session, ...);
} catch (err) {
  if (err instanceof PermissionDeniedError) {
    // Denied attempt — primary transaction was rolled back.
    // Write a best-effort denied audit entry (outside the failed transaction).
    try {
      try {
        await withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
          await writeAuditTx(tx, {
            tenantId, actor: userId,
            action: "reform.proposal_approved",
            status: "denied",
            errorCode: "PERMISSION_DENIED",
            details: { proposalId, alternativeId, permission: err.permission },
          });
        });
      } catch {
        // Fall back to global writeAudit (best-effort)
        await writeAudit({
          tenantId: session.user?.tenantId,
          actor: session.user?.id,
          action: "reform.proposal_approved",
          status: "denied",
          errorCode: "PERMISSION_DENIED",
          details: { proposalId, alternativeId, permission: err.permission },
        });
      }
    } catch {
      // Both audit paths failed. The denial is still enforced (original error re-thrown).
      // The audit failure is an operational issue — alert via log monitoring.
    }
  }
  throw err; // Always re-throw the ORIGINAL PermissionDeniedError
}
```

**Critical**: The original `PermissionDeniedError` is **always** the error the caller sees. Audit logging failures are operational issues — they must NOT replace or hide the authorization error. This is the FIX-2 pattern from G01's 01-10-FINAL-CLOSURE.

### 4.5 Append-Only Enforcement

The `audit_log` table itself is append-only — `balance_app` has only SELECT + INSERT, not UPDATE or DELETE. This was established in G00 (mission 00-01) and is inherited by G03.

The G03 append-only tables (`reform_action_updates`, `reform_approvals`, `reform_feedback_loops`) follow the same pattern — UPDATE and DELETE are REVOKED from `balance_app`.

### 4.6 Audit Log Retention

Audit logs are **never deleted** by application code. Retention is an operational policy owned by the project owner. In Demolandia (current state), no retention policy is enforced — all audit logs persist indefinitely.

For a future production deployment, retention would be:
- 7 years (typical compliance requirement)
- Or "indefinite" (sovereign audit trail)
- Deletion only via explicit owner-approved data retention job (not via application code)

---

## 5. Evidence Handling Policy

### 5.1 Two Evidence Patterns

G03 uses two distinct evidence patterns, depending on the operation's sovereignty:

| Pattern | Used by | Storage | Why |
|---------|---------|---------|-----|
| **Evidence snapshot** (immutable) | `ReformApproval` | JSONB column with `{ evidenceId, claim, type, verificationStatus, sourceCode }` at approval time | Captures what was known when approved — even if evidence later changes, the approval record is unchanged. Sovereign decision record. |
| **Live evidence link** (mutable context) | `ReformActionUpdate` | JSONB array of evidence IDs `["ev1", "ev2", ...]` | Progress reports reference current evidence state. As evidence is verified/refuted, the context updates. Not a sovereign decision — ongoing context. |

### 5.2 Evidence Snapshot at Approval Time

The `ReformApproval.supportingEvidence` and `counterEvidence` fields capture evidence state at approval time:

```typescript
interface EvidenceSnapshot {
  evidenceId: string;
  claim: string;
  type: string;             // "supporting" | "counter" | "neutral"
  verificationStatus: string;  // "unverified" | "verified" | "disputed" | "refuted"
  sourceCode: string | null;
}
```

**Critical**: This snapshot is **immutable**. RLS blocks UPDATE + DELETE on `reform_approvals` for `balance_app`. To "change" the evidence supporting an approval, create a new proposal that supersedes the old one — the old approval stays unchanged.

### 5.3 Evidence Completeness Check

When capturing the snapshot, G03 enforces an **evidence completeness check** (mirrors G00's `createDecision` pattern per ADR-0010):

```typescript
async function captureEvidenceSnapshots(
  tx: Prisma.TransactionClient,
  tenantId: string,
  evidenceIds: string[]
): Promise<EvidenceSnapshot[]> {
  if (evidenceIds.length === 0) return [];

  // Fetch all requested evidence in tenant scope
  const evidence = await tx.evidence.findMany({
    where: { id: { in: evidenceIds }, tenantId },
    include: { source: { select: { code: true } } },
  });

  // VERIFY: all requested IDs were found
  if (evidence.length !== evidenceIds.length) {
    const found = new Set(evidence.map(e => e.id));
    const missing = evidenceIds.filter(id => !found.has(id));
    throw new Error(
      `Evidence completeness violation: ${missing.length} of ${evidenceIds.length} ` +
      `evidence IDs not found in tenant scope. Missing: ${missing.join(", ")}. ` +
      "Approval rejected — no partial snapshots allowed."
    );
  }

  return evidence.map(e => ({
    evidenceId: e.id,
    claim: e.claim,
    type: e.type,
    verificationStatus: e.verificationStatus,
    sourceCode: e.source?.code ?? null,
  }));
}
```

**Why this matters**: If an analyst provides 5 evidence IDs but only 4 exist (or the 5th is cross-tenant), the entire approval is rejected. No partial snapshots — the approval record is either complete or non-existent.

### 5.4 Live Evidence Links in Action Updates

`ReformActionUpdate.evidenceIds` is a JSONB array of evidence IDs:

```typescript
// When adding an action update:
await addReformActionUpdate(session, {
  actionId,
  updateType: "evidence",
  notes: "New evidence memo #X attached",
  evidenceIds: ["ev1", "ev2"],  // live links, not snapshots
});

// The array is stored as-is. When queried later, the service joins with Evidence table:
const updatesWithEvidence = await tx.reformActionUpdate.findMany({
  where: { actionId },
  include: {
    // Note: JSONB arrays can't be directly joined in Prisma.
    // The service layer fetches evidence separately:
  },
});
// Then service layer fetches:
const evidenceIds = updatesWithEvidence.flatMap(u => u.evidenceIds);
const evidence = await tx.evidence.findMany({ where: { id: { in: evidenceIds }, tenantId } });
```

**Why live links for updates**: Updates are ongoing context, not sovereign decisions. If evidence is later verified/refuted, the update's context naturally reflects the current state. This is different from approvals, where the decision must be frozen at approval time.

### 5.5 Evidence Creation by G03

G03 may create **new** Evidence rows for reform-specific evidence (e.g., a memo about a reform decision, a photo of completed infrastructure). This follows the G00 Evidence pattern:

```typescript
// In reform-action-update-service.ts (when attaching new evidence)
const newEvidence = await tx.evidence.create({
  data: {
    tenantId,
    claim: input.evidenceClaim,
    type: "supporting",
    sourceId: input.sourceId,        // optional
    classification: "public",        // default — G02-L26 conservative
    verificationStatus: "unverified", // default
    observedAt: input.observedAt,
    retrievalMethod: input.retrievalMethod,
    metadata: input.metadata ?? {},
  },
});
```

**Critical**:
- G03 only CREATES new Evidence — never mutates existing Evidence rows
- G03 follows the G02-L26 conservative clearance: `classification = "public"` by default
- G03 does NOT introduce a new clearance model (that's a future mission requiring owner approval)

### 5.6 Evidence Classification Policy (Inherited)

G03 inherits G02's evidence classification policy (G02-L26):

| Classification | Who can see it | G03 impact |
|----------------|---------------|-----------|
| `public` | All authenticated users (including government viewers via PermissionedView) | Default for new G03 evidence |
| `classified` | Only authorized users (no granular clearance model yet) | G03 may set this, but the conservative government projection will only show `public` |
| `restricted` | Only authorized users (no granular clearance model yet) | Same as `classified` |

**G02-L26 invariant**: Government projection (PermissionedView tier) shows only `classification="public"` evidence. This applies to G03 evidence as well — G03 does not weaken this policy.

---

## 6. LLM Boundary Policy

### 6.1 LLM Is Advisory Only

The LLM (when integrated via `getLLMProvider()`) is **advisory only** in G03. It can:

- Draft problem statements (for analyst review/edit)
- Draft reform alternatives (for analyst review/edit)
- Draft comparison summaries (for analyst review/edit)
- Draft anticipated outcomes (for analyst review/edit)

The LLM **cannot**:
- Approve proposals
- Select an alternative
- Verify an action
- Create causal claims
- Override human decisions
- Make authoritative recommendations (only descriptive comparisons)

### 6.2 Simulated Flag

When `StubProvider` is active (current state), all LLM advisor output carries `simulated: true`:

```typescript
export interface AdvisorDraftResult {
  draft: string;
  simulated: boolean;        // always true with StubProvider
  provider: string;          // "stub" with StubProvider
  model: string;             // "stub-v1" with StubProvider
  warnings: string[];        // e.g., "This is a simulated draft. Review and edit before saving."
}
```

The `simulated` flag is also stored in `ReformAlternative.metadata.simulated` when an LLM-drafted alternative is saved. This honors ADR-0002 (LLM Provider Abstraction) and ADR-0010 §"Simulated model output disclaimer".

### 6.3 Causal Language Rejection

G03 advisor output is validated to reject causal language. The Zod schema for advisor outputs (and for human inputs that may include LLM-suggested text) includes pattern checks:

```typescript
const causalPatterns = [
  /\bcaused\b/i,
  /\bdue to\b/i,
  /\bas a result of\b/i,
  /\bthe reform led to\b/i,
  /\bthis action resulted in\b/i,
  /\binflation (was )?reduced\b/i,
  /\bunemployment (was )?decreased\b/i,
];

function rejectCausalClaims(text: string): string[] {
  return causalPatterns
    .filter(pattern => pattern.test(text))
    .map(pattern => `Causal language detected: ${pattern.source}`);
}
```

**Defense in depth**: Causal language is rejected at:
1. Zod schema (input validation)
2. Service layer (before storage)
3. DB trigger (for `reform_feedback_loops.attributionLevel`)

### 6.4 LLM Provider Abstraction

G03 uses the existing LLM provider abstraction (`src/lib/llm/`). When a real LLM is integrated (future mission, post-G03 or late G03), only the `LLM_PROVIDER` env var needs to change — no G03 code changes.

```typescript
// In reform-advisor-service.ts
import { getLLMProvider } from "@/lib/llm";

export async function draftProblemStatement(session, input) {
  const provider = getLLMProvider(); // returns StubProvider by default
  const result = await provider.complete({
    messages: [
      { role: "system", content: "You are an advisory reform drafting assistant. Be descriptive, never causal. Never approve or recommend." },
      { role: "user", content: `Draft a problem statement for: ${JSON.stringify(input)}` },
    ],
    traceId: `advisor-${Date.now()}`,
  });

  // Validate output — reject causal language
  const causalWarnings = rejectCausalClaims(result.content);
  if (causalWarnings.length > 0) {
    return {
      draft: result.content,
      simulated: provider.name === "stub",
      provider: provider.name,
      model: result.model,
      warnings: [
        "This is a draft. Review and edit before saving.",
        ...causalWarnings,
      ],
    };
  }

  return {
    draft: result.content,
    simulated: provider.name === "stub",
    provider: provider.name,
    model: result.model,
    warnings: ["This is a draft. Review and edit before saving."],
  };
}
```

---

## 7. F6 Verification Pattern

### 7.1 Triple Enforcement

The F6 invariant (verifiedAction + evidenceSource required for "verified" status) is enforced at three layers:

| Layer | Enforcement | When it fires |
|-------|-------------|---------------|
| 1. Zod schema | `VerifyReformActionInputSchema.superRefine` | At API boundary (request validation) |
| 2. DB trigger | `enforce_reform_verification_f6` | At INSERT/UPDATE (database level) |
| 3. Service layer | Explicit check in `verifyReformAction` | Before calling `tx.reformVerification.upsert` |

### 7.2 Why Triple Enforcement?

1. **Zod schema**: Catches most violations early (before any DB operation) — fast feedback to the API caller.
2. **DB trigger**: Catches violations even if the service layer has a bug or is bypassed (e.g., by a future migration script) — defense in depth.
3. **Service layer**: Provides clear, actionable error messages with context — better DX than DB trigger errors.

### 7.3 Policy Outcome Language Rejection

The F6 pattern also rejects **policy outcome language** in `verifiedAction`. The verifier must describe the **specific action verified**, not a policy outcome.

| Rejected (policy outcome) | Accepted (specific action) |
|---------------------------|---------------------------|
| "Inflation was reduced" | "Memo #X issued by Ministry of Planning on 2026-10-15" |
| "Unemployment decreased" | "Training program Y completed with 500 graduates" |
| "The policy worked" | "Regulation Z published in official gazette #456" |
| "The reform caused growth" | "Infrastructure project W completed and inaugurated" |

The rejection is pattern-based (regex on common policy-outcome phrases). This is not a perfect NLP classifier — it's a defense-in-depth check. The reviewer is expected to write action-specific language; the pattern check catches obvious violations.

### 7.4 Dispute Pattern

When verification fails (status = "disputed"), the verifier must provide:
- `disputeReason` (≥10 chars) — why the verification is disputed
- `disputeEvidenceSource` (≥5 chars) — evidence supporting the dispute

This mirrors the F6 pattern for verified status. Both `verified` and `disputed` require evidence — there's no "unverified" status in G03 (the default is `pending`, which is the state before verification occurs).

---

## 8. Causal Attribution Prohibition

### 8.1 The Core Invariant

**Invariant #1**: `attributionLevel = "descriptive"` always — no causal claims without evidence.

This is the platform-wide invariant from G02, enforced at multiple layers in G03.

### 8.2 Where Causal Claims Could Creep In

| Location | Risk | Mitigation |
|----------|------|------------|
| `ReformProposal.problemStatement` | Analyst writes "X caused Y" | Service-layer check + reviewer judgment (no hard block — analyst may describe correlation) |
| `ReformAlternative.anticipatedOutcomes` | LLM drafts "this will cause Y" | Zod schema hardcodes `attributionLevel: "descriptive"` + causal pattern rejection |
| `ReformVerification.verifiedAction` | Verifier writes "this action caused Y" | F6 pattern rejection (regex) + reviewer judgment |
| `ReformFeedbackLoop.descriptiveSummary` | Analyst writes "the reform caused Y" | Zod schema causal pattern rejection + DB trigger on `attributionLevel` |
| `ReformFeedbackLoop.attributionLevel` | Set to "causal" by bug/attack | DB trigger blocks any value other than "descriptive" |

### 8.3 DB-Level Enforcement (Strongest Layer)

The strongest enforcement is the DB trigger on `reform_feedback_loops`:

```sql
CREATE OR REPLACE FUNCTION enforce_reform_feedback_attribution_descriptive()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."attributionLevel" IS DISTINCT FROM 'descriptive' THEN
    RAISE EXCEPTION 'Invariant violation: ReformFeedbackLoop.attributionLevel must always be "descriptive". Causal claims are forbidden.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_reform_feedback_attribution_descriptive
  BEFORE INSERT OR UPDATE ON reform_feedback_loops
  FOR EACH ROW EXECUTE FUNCTION enforce_reform_feedback_attribution_descriptive();
```

This trigger makes it **impossible** to set `attributionLevel` to anything other than `"descriptive"` — even via direct SQL access (e.g., a future migration script that bypasses the application layer).

### 8.4 Descriptive vs Causal — Examples

| Descriptive (allowed) | Causal (forbidden) |
|-----------------------|---------------------|
| "After the reform, the indicator was observed at X" | "The reform caused the indicator to change" |
| "The variance between planned and actual was Y" | "The reform reduced the variance" |
| "The action was verified: memo #X issued" | "The memo caused inflation to drop" |
| "Two observations were compared; the difference was Z" | "The difference was due to the reform" |

---

## 9. Publication Policy (Fail-Closed)

### 9.1 G02-L25 Inheritance

G03 inherits G02-L25 (Publication Approval Gap):

> No publication approval mechanism exists in the schema. `Evidence.classification="public"` is a default value, not publication consent. Public and Research tiers return `publication_unavailable` (fail-closed).

### 9.2 G03 Stance on Publication

G03 **does not introduce** a publication workflow in 03-00 through 03-06. All reform data is **tenant-private** by default.

**No `publication_status` field** exists on any G03 table. This is deliberate — adding a publication field without a workflow would create a false sense of publishability.

### 9.3 Future Publication Mission

A future mission (post-03-06, requires explicit owner approval) would:
1. Design a publication approval workflow (similar to G01's strategy approval)
2. Add a `publication_status` field to relevant G03 tables
3. Implement a `publishReformProposal()` service with atomic approval + audit
4. Integrate with G02's `PermissionedView` to expose published reforms to the public/research tiers

Until then, **no claim of operational public publication** is made for G03 data.

### 9.4 Government Projection (G02-L26 Inheritance)

If G03 data is ever exposed to government viewers (via G02's `PermissionedView` government tier), the same conservative clearance applies:

- Only `classification="public"` evidence is visible
- No granular clearance model (deferred to future mission)
- G03 does not weaken this policy

---

## 10. Cross-Ministry (Cross-Tenant) Coordination

### 10.1 Current Limitation

G03 ships **single-tenant only**. Each tenant's reforms are isolated by RLS — Tenant B cannot see Tenant A's reform proposals, alternatives, actions, or verifications.

This means a reform that spans multiple ministries (e.g., a monetary-fiscal coordination reform between the Central Bank and the Ministry of Planning) cannot be represented as a single shared proposal in 03-00.

### 10.2 Workaround (Within 03-00 Scope)

Each ministry can create its own proposal for the same problem:
- Tenant A (Ministry of Planning) creates Proposal X
- Tenant B (Central Bank) creates Proposal Y
- Both reference the same originating Alert (if it's a shared signal)
- Both reference the same strategy version (if applicable)

This is a **soft coordination** — there's no shared state, but the audit trail shows both ministries are working on the same problem.

### 10.3 Future Cross-Tenant Mission (Out of 03-00 Scope)

A future mission (requires explicit owner approval) could add:
- A `ReformCoordination` table linking proposals across tenants
- A coordination approval workflow (multiple ministries must approve)
- Shared visibility for coordinated proposals (with explicit per-tenant consent)

This is documented as open decision D6 in `G03_00_OPEN_DECISIONS.md`.

---

## 11. Security Test Plan

### 11.1 Integration Tests (Real PostgreSQL 16 + RLS)

| Test | What it verifies |
|------|------------------|
| `g03-01-rls.integration.test.ts` | Tenant B cannot see Tenant A's reform proposals |
| `g03-01-cross-tenant-trigger.integration.test.ts` | DB trigger blocks cross-tenant FK violations |
| `g03-01-append-only.integration.test.ts` | RLS blocks UPDATE/DELETE on `reform_action_updates`, `reform_approvals`, `reform_feedback_loops` |
| `g03-01-f6-trigger.integration.test.ts` | DB trigger blocks F6 violations (verified without verifiedAction) |
| `g03-01-attribution-trigger.integration.test.ts` | DB trigger blocks non-"descriptive" attributionLevel |
| `g03-01-permissions.integration.test.ts` | 9 new permissions work correctly per role |
| `g03-02-rbac-negative.integration.test.ts` | Analyst cannot approve; observer cannot read alternatives; analyst cannot verify |
| `g03-04-denied-audit.integration.test.ts` | Denied permission attempts are audited (best-effort, outside failed tx) |
| `g03-04-evidence-snapshot.integration.test.ts` | Evidence snapshot captured at approval time, immutable post-approval |
| `g03-06-causal-rejection.integration.test.ts` | Causal language in feedback loop rejected by Zod + DB trigger |

### 11.2 Sentinel Regression Tests

G03 adds sentinel regression tests (mirrors G02's `g02-l21-sentinel.integration.test.ts`):

```typescript
// tests/integration/g03-04-f6-sentinel.integration.test.ts
describe("G03 F6 Sentinel", () => {
  it("DB trigger blocks verified status without verifiedAction", async () => { ... });
  it("DB trigger blocks verified status without evidenceSource", async () => { ... });
  it("DB trigger blocks disputed status without disputeReason", async () => { ... });
  it("Zod schema rejects policy-outcome language", async () => { ... });
  it("RLS blocks UPDATE on reform_action_updates", async () => { ... });
  it("RLS blocks DELETE on reform_approvals", async () => { ... });
  it("DB trigger blocks non-descriptive attributionLevel", async () => { ... });
  it("Cross-tenant trigger blocks FK violation", async () => { ... });
});
```

### 11.3 Security Hardening Verification

G03 inherits G00's security hardening (ADR-0012). Verification:

| Requirement | How verified |
|-------------|--------------|
| Security headers present on G03 routes | Integration test (check response headers) |
| Rate limiting active on G03 routes | Integration test (exceed limit → 429) |
| Errors sanitized (no SQL/path/stack leaks) | Unit test on `error-sanitizer.ts` + integration test on G03 error paths |
| Sensitive data redacted from logs | Unit test on `redactSensitive()` |
| Audit log IP is hashed | Integration test (verify `ipHash` column, not raw IP) |
| Audit log is append-only | Integration test (UPDATE/DELETE rejected) |
| RBAC negative tests pass | Integration test (see §3.5) |

---

## 12. Operational Security

### 12.1 Log Monitoring

G03 services use structured logging via `childLogger({ module: "reform" })` (extends G00's `observability.ts`). All logs include:
- `tenantId` (for correlation)
- `userId` (for accountability)
- `action` (what was attempted)
- `requestId` (for tracing)
- Redacted `details` (secrets stripped)

**Alerts to monitor** (operational, not part of G03 code):
- `AUDIT_WRITE_FAILED` — best-effort audit write failed (investigate via logs)
- `PermissionDeniedError` spike — possible attack or misconfiguration
- F6 trigger violations — possible bug or attack
- Attribution trigger violations — possible bug or attack
- RLS policy violations — possible misconfiguration

### 12.2 Metrics

G03 extends G00's metrics (in-process Prometheus):

```
# Counters
reform_proposals_created_total{tenant_id, status}
reform_proposals_approved_total{tenant_id}
reform_proposals_rejected_total{tenant_id}
reform_actions_completed_total{tenant_id}
reform_verifications_verified_total{tenant_id}
reform_verifications_disputed_total{tenant_id}
reform_advisor_invocations_total{tenant_id, simulated}
reform_denied_attempts_total{tenant_id, permission}

# Gauges
reform_proposals_in_draft{tenant_id}
reform_proposals_under_review{tenant_id}
reform_actions_in_progress{tenant_id}
reform_actions_blocked{tenant_id}
reform_pending_verifications{tenant_id}
```

All metrics exposed via `GET /api/v1/_metrics` (requires `audit:read` permission, same as G00).

### 12.3 Backup/Restore

G03 inherits G00's backup/restore verification (mission 00-10):
- `scripts/backup-restore-test.sh` extended to include G03 tables
- Restore preserves all G03 rows
- RLS policies intact post-restore
- Audit trail complete post-restore

---

## 13. Security Review Checklist

| Requirement | Verified by | Layer |
|-------------|------------|-------|
| All 7 new tables have RLS ENABLE + FORCE | Migration SQL + integration test | DB |
| Cross-tenant triggers block FK violations | Integration test | DB |
| Append-only tables block UPDATE/DELETE for balance_app | Integration test (RLS) | DB |
| F6 trigger blocks verified without verifiedAction/evidenceSource | Sentinel integration test | DB |
| Attribution trigger blocks non-"descriptive" values | Sentinel integration test | DB |
| 9 new permissions work per role | Integration test (positive + negative) | Application |
| All privileged ops check CURRENT DB role | Code review | Application |
| All state transitions write atomic audit log | Integration test | Application |
| Denied attempts audited (best-effort) | Integration test | Application |
| Evidence snapshot captured at approval time | Integration test | Application |
| Evidence completeness check (no partial snapshots) | Integration test | Application |
| LLM output carries `simulated: true` when StubProvider active | Unit test | Application |
| Causal language rejected in feedback loop | Zod + DB trigger (sentinel test) | Application + DB |
| No `publication_status` field (fail-closed) | Schema review | Application |
| Security headers present on G03 routes | Integration test | HTTP |
| Rate limiting active on G03 routes | Integration test | HTTP |
| Errors sanitized (no SQL/path/stack leaks) | Unit test | HTTP |

---

*End of G03-00 Security & Evidence Policy. Companion documents: ARCHITECTURE_PROPOSAL.md, DOMAIN_MODEL.md, WORKFLOW_AND_APPROVALS.md, INTEGRATION_CONTRACTS.md.*
