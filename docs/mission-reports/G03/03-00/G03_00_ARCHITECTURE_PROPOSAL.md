# G03-00 — Architecture Proposal (REV 5 — Final)

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Architecture proposal (DESIGN ONLY — no code, no migrations, no permissions changes)
> **Date:** 2026-10-18 (revision 5 — final, post blocker closure)
> **Author:** GLM (implementation agent)
> **Status:** REV 5 — all blockers (B1-B4) closed; awaiting owner FINAL PASS
> **Builds on:** GROUP 00 (Foundation), GROUP 01 (State Builder), GROUP 02 (State Observatory)

> ✅ **REV 5 STATUS**: This document is fully consistent with REV 5.
> All REV 1-4 contracts have been removed or superseded.
> The authoritative source for B1/B2/B3/B4 closure is `G03_00_BLOCKER_CLOSURE_REV5.md`.
> The authoritative source for decisions is `G03_00_OPEN_DECISIONS.md` (D1-D15).

---

## 1. Executive Summary (REV 5)

### 1.1 What GROUP 03 Is

GROUP 03 — **Targeted Reform** — closes the loop between *observing* a problem (GROUP 02) and *acting* on it (using the planning infrastructure of GROUP 01). It is **not** an automatic reform generator. It is a structured, evidence-respecting, human-sovereign pipeline that:

1. Consumes **descriptive signals** from the State Observatory (VarianceRecord, Alert, EarlyWarning, TemporalTrend).
2. Helps analysts **frame problems** and **draft reform proposals** with multiple alternatives, costs (as ranges), risks, assumptions, and expected outcomes (descriptive, never causal).
3. Routes proposals through a **human approval workflow** that inherits the atomic, audited pattern proven in GROUP 01.
4. Converts approved proposals into **trackable reform actions** with append-only progress updates and evidence attachments.
5. Verifies execution using the F6 pattern — `verifiedAction` + `evidenceSource` — describing the **specific action verified**, never a policy outcome.
6. Feeds results back to the observatory as **new observations** with **no causal attribution**.

### 1.2 Multi-Institution Coordination (Core Capability — per D6)

GROUP 03 supports **multi-institution reform coordination** as a core capability (not deferred). Multiple tenants (ministries, agencies) can coordinate on a shared reform via:

- **ReformCoordination** entity (lead tenant + participants)
- **Two-level approval**: coordination plan approval (lead) + per-participant proposal approval (each tenant's reviewer). **No majority override** — coordination `active` requires ALL linked proposals approved.
- **Explicit shared snapshots**: reviewer-approved, immutable summaries shared across participants. **No live links to private data**.
- **Coordination-aware RLS** via `is_coordination_participant()` helper function (SECURITY INVOKER).

### 1.3 Final Architecture Numbers (REV 5)

| Resource | Count | Note |
|----------|-------|------|
| Tables | 12 | 7 core + 5 coordination |
| Permissions | 13 | 9 core + 4 coordination |
| Services | 12 | 11 core + 1 coordination |
| Helper functions | 3 | 2 SECURITY INVOKER + 1 SECURITY DEFINER (participant removal — Option A corrected) |
| Dedicated roles | 1 | `balance_coordination_admin` (NOLOGIN, minimal grants) |
| Missions | 9 | 1 design + 1 schema + 7 service/closure |
| Coordination security tests | 66 | SEC-01 to SEC-66 |

**These are estimates derived from the design, not goals.** Per owner directive: "هذه أرقام تقديرية، ويجب أن تتبع الوظائف المطلوبة، لا العكس."

### 1.4 The Reform Loop

```
GROUP 02 (Observatory) → VarianceRecord / Alert / EarlyWarning / TemporalTrend
                              │ (descriptive signal — no causal claim)
                              ▼
GROUP 03 (Reform):
  ReformProposal (draft)
    → ReformAlternative[] (draft → selected)
    → ReformApproval (atomic + evidence snapshot)
    → ReformAction (planned → in_progress → completed)
    → ReformActionUpdate[] (append-only)
    → ReformVerification (F6: verifiedAction + evidenceSource)
    → ReformFeedbackLoop (descriptive — attributionLevel="descriptive" always)
                              │
                              ▼ (new observation via ingestObservation — append-only)
GROUP 02 (Observatory) — measures results, no causal attribution
```

### 1.5 Multi-Institution Coordination Loop (Optional)

```
Lead Tenant creates ReformCoordination
  → invites participants (ReformCoordinationInvitation with expiry)
  → participants accept (ReformCoordinationParticipant status: active)
  → each participant creates own ReformProposal (linked via coordinationId)
  → lead approves coordination plan (status: plan_approved)
  → each participant's reviewer approves their own proposal (per-tenant)
  → coordination auto-activates when ALL proposals approved (status: active)
  → participants share snapshots (draft → under_review → approved)
  → lead can remove participants (via remove_coordination_participant — Option A corrected)
  → participants can self-withdraw
  → coordination closes when all actions verified + feedback loops created
```

---

## 2. Architectural Invariants (Preserved)

### 2.1 The 14 Inherited Invariants (from G00/G01/G02)

All 14 inherited invariants are honored. See `G03_00_SECURITY_AND_EVIDENCE_POLICY.md` §3.1 for the full list with how G03 honors each.

### 2.2 The 10 New G03 Invariants (Proposed)

See `G03_00_SECURITY_AND_EVIDENCE_POLICY.md` §3.2.

### 2.3 REV 5 Security Guarantees (B1-B4 Closure)

| Guarantee | Source |
|-----------|--------|
| No authorization bypass in participant removal (lead check inside UPDATE WHERE) | B1 closure — `G03_00_BLOCKER_CLOSURE_REV5.md` §2 |
| No revoked snapshot visibility (DB-level enforcement) | B2 closure — `G03_00_BLOCKER_CLOSURE_REV5.md` §3 |
| No institutional commitment approval without verified authority (fail-closed) | B3 closure — `G03_00_BLOCKER_CLOSURE_REV5.md` §4 |
| All documents fully consistent (no REV 1-4 contracts as active) | B4 closure — `G03_00_CONSISTENCY_REVIEW.md` |

---

## 3. Layered Architecture

### 3.1 Three-Tier Service Pattern

```
Tier 3: API Routes (src/app/api/v1/reform/*)
  - HTTP layer, request validation, response shaping
  - Calls Tier 2 services via session
  - Rate-limited (extends G00's rate limiter)

Tier 2: Domain Services (src/lib/reform/*-service.ts)
  - Business logic, lifecycle transitions
  - withAuthenticatedTenant + requirePermissionWithCurrentRole
  - Atomic audit via writeAuditTx

Tier 1: Pure Contracts (src/lib/reform/contracts.ts)
  - Zod schemas (input validation)
  - Pure functions (thresholds, comparators)
  - No DB access, no side effects
```

### 3.2 Service Composition

Each G03 service follows the pattern proven in G02:

```typescript
export async function createReformProposal(
  session: Session,
  input: CreateReformProposalInput
): Promise<{ proposalId: string }> {
  const validated = CreateReformProposalInputSchema.parse(input);
  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId, roleCode }) => {
    await requirePermissionWithCurrentRole(session, "reform:proposal:write");
    // ... validate cross-tenant references ...
    const proposal = await tx.reformProposal.create({ data: { ...validated, tenantId, createdBy: userId } });
    await tx.event.create({ data: { tenantId, eventType: "reform.proposal_created", ... } });
    await writeAuditTx(tx, { tenantId, actor: userId, action: "reform.proposal_created", status: "ok", ... });
    return { proposalId: proposal.id };
  });
}
```

### 3.3 Denied-Attempt Audit Pattern

Mirrors G01's `approveStrategyVersionWithAuditSafe`:

```typescript
export async function approveReformProposalWithAuditSafe(...) {
  try {
    return await approveReformProposal(...);
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      // Best-effort denied audit entry (outside failed transaction)
      try { await writeAudit({ ..., status: "denied", errorCode: "PERMISSION_DENIED", ... }); } catch {}
    }
    throw err; // Always re-throw the original error
  }
}
```

---

## 4. Component Layout

```
src/
├── app/api/v1/reform/              # REST API routes
│   ├── proposals/                   # 9 routes (CRUD + lifecycle)
│   ├── alternatives/                 # 2 routes (select + withdraw)
│   ├── advisor/                     # 4 routes (LLM-assisted drafting)
│   ├── actions/                     # 10 routes (CRUD + lifecycle + updates)
│   ├── coordinations/               # 12 routes (CRUD + invitations + snapshots + shared view)
│   └── dashboard/                   # 1 route (summary)
│
├── lib/reform/                      # G03 services
│   ├── contracts.ts                 # Zod schemas + types
│   ├── reform-proposal-service.ts
│   ├── reform-alternative-service.ts
│   ├── reform-comparison-service.ts
│   ├── reform-advisor-service.ts
│   ├── reform-approval-service.ts
│   ├── reform-action-service.ts
│   ├── reform-action-update-service.ts
│   ├── reform-verification-service.ts
│   ├── reform-feedback-service.ts
│   ├── reform-query-service.ts
│   ├── reform-coordination-service.ts  # includes removeCoordinationParticipant (Option A)
│   └── index.ts
│
└── (existing G00/G01/G02 code unchanged)
```

---

## 5. Mission Roadmap (Summary)

| Mission | Title | Type | Schema diff |
|---------|-------|------|:-----------:|
| 03-00 | Architecture & Scope Foundation (this) | Design | 0 |
| 03-01 | Schema Bootstrap (12 tables, 13 permissions, 3 functions, 1 role) | Schema | +1 migration |
| 03-02 | Vertical Slice — Minimum Viable Reform | Code | 0 |
| 03-03 | Reform Alternatives | Code | 0 |
| 03-04 | Reform Comparison + Advisor | Code | 0 |
| 03-05 | Enhanced Approval Workflow | Code | 0 |
| 03-06 | Multi-Institution Coordination Services | Code | 0 |
| 03-07 | Coordination Vertical Slice | Code | 0 |
| 03-08 | Polish + Closure | Code | 0 |

See `G03_00_MISSION_ROADMAP.md` for full details.

---

## 6. References

### 6.1 Authoritative Documents (REV 5)

- `G03_00_BLOCKER_CLOSURE_REV5.md` — B1/B2/B3/B4 closure (authoritative)
- `G03_00_OPEN_DECISIONS.md` — D1-D15 decisions
- `G03_00_DOMAIN_MODEL.md` — 12 table schemas + RLS + triggers
- `G03_00_WORKFLOW_AND_APPROVALS.md` — lifecycle + state machines
- `G03_00_INTEGRATION_CONTRACTS.md` — service signatures + Zod schemas
- `G03_00_SECURITY_AND_EVIDENCE_POLICY.md` — security + evidence policy
- `G03_00_THREAT_MODEL.md` — 10+3 threats (T1-T13)
- `G03_00_SECURITY_CONTRACT_FOR_COORDINATION.md` — coordination RLS contract
- `G03_00_MISSION_ROADMAP.md` — 9 missions
- `G03_00_CONSISTENCY_REVIEW.md` — consistency verification

### 6.2 Superseded Documents (Historical)

- `G03_00_SECURITY_CORRECTIONS_REV4.md` — superseded by REV 5 (historical record of S1/S2/S3 findings)

---

## 7. Conclusion

GROUP 03 — Targeted Reform — is designed to close the strategic loop of THE BALANCE platform. The architecture is:

- **Additive** (no breaking changes to G00/G01/G02)
- **Conservative** (human-sovereign, no causal claims, fail-closed publication + institutional authority)
- **Consistent** with proven G01/G02 patterns
- **Secure** (B1-B4 closed, 66 coordination security tests planned)
- **Multi-institution capable** (coordination as core, not deferred)

The 9-mission roadmap delivers a complete reform pipeline with ~66 coordination security tests + ~180 functional tests, honoring all 14 inherited invariants and introducing 10 new G3 invariants.

**Ready for owner + reviewer FINAL PASS.**

---

*End of G03-00 Architecture Proposal (REV 5 — Final). All REV 1-4 contracts have been superseded.*

