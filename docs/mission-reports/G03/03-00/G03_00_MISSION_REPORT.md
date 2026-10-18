# Mission 03-00 Report — Targeted Reform Architecture & Scope Foundation

**Mission type:** Architecture / Design / Contract Review (DESIGN ONLY)
**Date:** 2026-10-18
**Author:** GLM (implementation agent)
**Status:** COMPLETE — awaiting owner + reviewer approval
**Final SHA:** (to be filled after commit)
**CI:** (to be filled after push)
**Recovery:** (to be filled after push)

---

## 1. Mission Summary

Mission 03-00 established the architectural foundation for GROUP 03 — Targeted Reform. The mission produced 7 design documents totaling ~6513 lines (~305 KB) covering architecture, domain model, workflow, integration contracts, security policy, mission roadmap, and open decisions.

**No code was written. No migrations were created. No permissions were changed.** The mission is documentation-only — it sets the foundation for missions 03-01 through 03-06, which will implement the actual reform pipeline.

---

## 2. Deliverables

### 2.1 Design Documents (7)

All under `docs/mission-reports/G03/03-00/`:

| Document | Lines | Purpose |
|----------|-------|---------|
| `G03_00_ARCHITECTURE_PROPOSAL.md` | 869 | Architecture overview, 14 inherited invariants + 10 new G03 invariants, layered architecture, integration with G00/G01/G02 |
| `G03_00_DOMAIN_MODEL.md` | 1028 | 7 new tables with full schemas, indexes, RLS policies, cross-tenant triggers, F6 trigger, attribution trigger, supersession trigger |
| `G03_00_WORKFLOW_AND_APPROVALS.md` | 987 | End-to-end reform loop, 5 state machines, approval sequence, denied-attempt audit pattern, F6 verification workflow, feedback loop |
| `G03_00_INTEGRATION_CONTRACTS.md` | 1237 | 11 service modules with signatures, full Zod schemas (including F6 superRefine), 30+ API routes, error handling, test contracts |
| `G03_00_SECURITY_AND_EVIDENCE_POLICY.md` | 899 | RLS policy, RBAC matrix (9 new permissions), 3-layer audit pattern, evidence snapshot vs live link, LLM boundaries, F6 triple enforcement, causal attribution prohibition, fail-closed publication |
| `G03_00_MISSION_ROADMAP.md` | 877 | 7-mission decomposition (1 design + 1 schema + 5 service), per-mission scope/files/contracts/acceptance criteria, ~190 new tests target, ~6800 LOC estimated |
| `G03_00_OPEN_DECISIONS.md` | 616 | 8 open decisions (D1-D8) with recommendations, alternatives, trade-offs, urgency, GLM's technical opinion |
| **TOTAL** | **6513** | **~305 KB of design documentation** |

### 2.2 Architecture Highlights

#### New Tables (7 — all PRIVATE, RLS ENABLE + FORCE)

1. **`reform_proposals`** — top-level reform container, nullable FK to Alert/VarianceRecord/StrategyVersion/Objective, status lifecycle (draft → under_review → approved/rejected/superseded)
2. **`reform_alternatives`** — multiple options per proposal, cost as range (Decimal min/max), risk level, feasibility score, only ONE selected per proposal (partial unique index)
3. **`reform_approvals`** — immutable approval record with evidence snapshot (mirrors G00 Decision pattern), one per proposal (unique constraint)
4. **`reform_actions`** — implementation tracking, optional FK to G01 Program/Project, lifecycle (planned → in_progress → completed/blocked/cancelled), denormalized progressPercentage
5. **`reform_action_updates`** — append-only progress log (RLS blocks UPDATE/DELETE), 5 update types (progress/blocker/milestone/evidence/note)
6. **`reform_verifications`** — F6-pattern verification, `verifiedAction` + `evidenceSource` required for `verified` status (triple enforcement: Zod + DB trigger + service)
7. **`reform_feedback_loops`** — descriptive before/after comparison, `attributionLevel` hardcoded to `"descriptive"` (DB trigger blocks any other value)

#### New Permissions (9)

- `reform:proposal:{read, write, approve}` — proposal CRUD + approval (reviewer/admin only for approve)
- `reform:alternative:{read, write}` — alternative CRUD
- `reform:action:{read, write, verify}` — action CRUD + F6 verification (reviewer/admin only for verify)
- `reform:verification:read` — read verification records

#### New Service Modules (11 — planned for 03-02 through 03-06)

All under `src/lib/reform/` (not created in 03-00):
1. `contracts.ts` — Zod schemas + types + error re-exports
2. `reform-proposal-service.ts` — 7 functions
3. `reform-alternative-service.ts` — 4 functions
4. `reform-comparison-service.ts` — 1 function (deterministic, no LLM)
5. `reform-advisor-service.ts` — 4 functions (LLM-assisted, advisory only)
6. `reform-approval-service.ts` — 3 functions (atomic approval + denied audit)
7. `reform-action-service.ts` — 7 functions
8. `reform-action-update-service.ts` — 2 functions (append-only)
9. `reform-verification-service.ts` — 3 functions (F6 pattern)
10. `reform-feedback-service.ts` — 3 functions (descriptive feedback loop)
11. `reform-query-service.ts` — 2 functions (snapshot + dashboard)

#### New API Routes (30+ — planned for 03-02 through 03-06)

All under `src/app/api/v1/reform/`:
- `/proposals/*` — 9 routes (CRUD + lifecycle)
- `/alternatives/*` — 2 routes (select + withdraw)
- `/advisor/*` — 4 routes (LLM-assisted drafting)
- `/actions/*` — 10 routes (CRUD + lifecycle + updates)
- `/dashboard` — 1 route (summary)

---

## 3. Architectural Compliance

### 3.1 Inherited Invariants (14 — all honored)

| # | Invariant | How G03 honors it |
|---|-----------|-------------------|
| 1 | `attributionLevel = "descriptive"` always | DB trigger on `reform_feedback_loops` blocks any other value; Zod hardcodes the literal |
| 2 | StrategyVersion read-only FK | G03 references it via nullable FK; never calls `strategyVersion.update` |
| 3 | Observations append-only | G03 calls `ingestObservation` (G02 contract), never mutates existing |
| 4-6 | (G02-specific F1/F3/F4) | N/A — G03 doesn't introduce new observations directly |
| 7 | Lifecycle separated from verification | `ReformAction.status` (lifecycle) vs `ReformVerification.verificationStatus` (verification) |
| 8 | F6 verifiedAction + evidenceSource | Triple enforcement: Zod + DB trigger + service check |
| 9 | No new tables in service missions | 03-01 is the only schema mission; 03-02 through 03-06 have schema diff = 0 |
| 10 | `state-builder/` diff = 0 | G03 imports from G01 are read-only function calls only |
| 11 | `state-observatory/` diff = 0 | G03 imports from G02 are read-only function calls only |
| 12 | Fail-closed publication | No `publication_status` field; G03 has no publication workflow |
| 13 | Government projection limited to public | G03 inherits G02-L26 conservative clearance |
| 14 | Human remains sovereign | Every transition requires authenticated human + permission check |

### 3.2 New G03 Invariants (10 — proposed, frozen after owner approval)

1. G3-I1: ReformProposal.originatingAlertId nullable but, when set, must be same-tenant
2. G3-I2: Multiple alternatives per proposal, each with own cost/risk/assumptions
3. G3-I3: Only ONE selected alternative per proposal (partial unique index)
4. G3-I4: ReformApproval atomic with evidence snapshot (same pattern as G00 Decision)
5. G3-I5: ReformActionUpdate append-only (RLS blocks UPDATE/DELETE)
6. G3-I6: ReformVerification.verified requires verifiedAction + evidenceSource (F6)
7. G3-I7: ReformFeedbackLoop descriptive only (comparisonType never "causal")
8. G3-I8: All G03 tables PRIVATE with RLS ENABLE + FORCE
9. G3-I9: LLM advisor output carries `simulated: true` when StubProvider active
10. G3-I10: No G03 service calls update/delete on entities it doesn't own

### 3.3 Pattern Consistency with G00/G01/G02

| Pattern | G00/G01/G02 source | G03 reuse |
|---------|---------------------|----------|
| `withAuthenticatedTenant(session, fn)` | `src/lib/security/tenant-context.ts` | Every G03 service |
| `requirePermissionWithCurrentRole(session, perm)` | `src/lib/permissions.ts` | Every privileged operation |
| `writeAuditTx(tx, entry)` (atomic) | `src/lib/audit.ts` | Every state transition |
| `writeAudit(entry)` (best-effort) | `src/lib/audit.ts` | Denied-attempt audit fallback |
| `approveStrategyVersionWithAuditSafe` pattern | `src/lib/state-builder/approval-service.ts` | Reference for `approveReformProposalWithAuditSafe` |
| Evidence snapshot at decision time | G00 `Decision` (ADR-0010) | `ReformApproval.supportingEvidence`/`counterEvidence` |
| Alert F6 pattern (verifiedAction + evidenceSource) | G02 `Alert` (R5/F6) | `ReformVerification` |
| Durable Task runtime + fencing tokens | `src/lib/balance-master.ts` + `task-service.ts` | Available for async reform tasks |
| Capability Registry | G00 `Capability` table | Optional registration of G03 capabilities |
| `FixtureTracker` | `tests/integration/helpers/fixture-tracker.ts` | G03 integration tests |
| Zod schemas + error classes | `src/lib/state-observatory/contracts.ts` | `src/lib/reform/contracts.ts` (mirrors pattern) |
| Barrel exports | `src/lib/state-observatory/index.ts` | `src/lib/reform/index.ts` (mirrors pattern) |

---

## 4. Mission Roadmap (Summary)

| Mission | Title | Type | Schema diff | New tests | Dependencies |
|---------|-------|------|:-----------:|:---------:|--------------|
| **03-00** | Architecture & Scope Foundation | Design | 0 (docs only) | 0 | None (this mission) |
| **03-01** | Schema Bootstrap | Schema | +1 migration, +7 tables, +9 permissions | ~25 | 03-00 approved |
| **03-02** | Reform Proposal + Alternative Services | Code | 0 | ~45 | 03-01 approved |
| **03-03** | Reform Comparison + Advisor Services | Code | 0 | ~35 | 03-02 approved |
| **03-04** | Reform Approval Workflow | Code | 0 | ~25 | 03-02, 03-03 approved |
| **03-05** | Reform Action + Update Tracking | Code | 0 | ~35 | 03-04 approved |
| **03-06** | Reform Verification + Feedback Loop | Code | 0 | ~25 | 03-05 approved |

**Total**: 7 missions, ~190 new tests, ~6800 LOC.
**Target at end of G03**: ~1007 tests passed | 10 skipped | 0 failed (up from 817 at end of G02).

---

## 5. Open Decisions (8 — Require Owner Approval)

Full detail in `G03_00_OPEN_DECISIONS.md`. Summary:

| # | Decision | Recommendation | Urgency |
|---|----------|----------------|---------|
| D1 | Independent reform tables vs. reuse G01 | **Independent tables** | Before 03-01 |
| D2 | System-initiated opportunity detection | **Advisory only** (no auto-create) | Low (future mission) |
| D3 | Problem detection vs. cause analysis | **Separate fields** | Before 03-01 |
| D4 | ReformAction → Program/Project link | **Optional nullable FK** | Before 03-01 |
| D5 | Definition of approved/implemented/verified | **Three distinct states** | Before 03-01 |
| D6 | Cross-ministry reforms | **Defer to future mission** | Low |
| D7 | Duplicate proposal prevention | **Soft check with override** | Before 03-02 |
| D8 | Which G02 limitations to address | **Defer all** | Low |

**Critical**: D1, D3, D4, D5 must be approved before 03-01 (schema bootstrap).

---

## 6. GLM's Technical Opinion (As Requested by Owner)

Per the owner's directive: *"لا تتردد في طرح رأيك أو مقترحك بنهاية تنفيذ اي مهمة"* — here is my honest technical opinion.

### 6.1 What I'm Proud Of

1. **The F6 triple enforcement** — Zod + DB trigger + service check ensures the F6 invariant (verifiedAction + evidenceSource) cannot be bypassed even by application bugs or future migration scripts. This is defense in depth at its best.

2. **The attribution-level DB trigger** — `enforce_reform_feedback_attribution_descriptive()` makes it **impossible** to set `attributionLevel` to anything other than `"descriptive"` — even via direct SQL access. This is the strongest enforcement of invariant #1 in the entire platform.

3. **The 7-mission decomposition** — Mirrors G02's proven pattern (1 bootstrap + 5 service) but extends it to cover the reform loop's additional phases. Each mission is reviewable in one pass, with clear entry/exit contracts.

4. **The evidence snapshot vs. live link distinction** — Approvals get immutable snapshots (sovereign decision records); action updates get live links (ongoing context). This is epistemically correct and operationally efficient.

### 6.2 What I'm Uncertain About

1. **D6 (cross-ministry coordination)** — I deferred this, but I'm not fully confident. In a real government context, many reforms ARE cross-ministry. Shipping single-tenant-only may limit real-world usefulness. I'd appreciate the owner's view on whether cross-ministry reforms are a common use case or a rare edge case.

2. **The advisor's causal language rejection** — I used regex patterns (e.g., `/\bcaused\b/i`) to reject causal language in LLM output. This is **not** a perfect NLP classifier — sophisticated causal phrasing may slip through. The defense in depth (DB trigger on `attributionLevel` + reviewer judgment) catches what the regex misses, but I want to flag this limitation honestly.

3. **The denormalized `progressPercentage`** — I denormalized `ReformAction.progressPercentage` from the latest `ReformActionUpdate` for query efficiency. This creates a small risk of inconsistency if the service layer fails to sync. The mitigation (service-layer sync + integration test) should catch this, but it's a known trade-off.

### 6.3 What I'd Recommend Changing (If I Were the Owner)

1. **Consider addressing G02-L25 (publication workflow) earlier** — If reforms are meant to be visible to the public eventually, the publication workflow should be designed before G03 ships. Otherwise, G03 reforms will be tenant-private indefinitely, which may limit real-world impact. However, I also understand the desire to ship focused first.

2. **Consider a UI mission earlier** — G02 shipped without UI (G02-L03), and I've proposed the same for G03. But if the reviewer (ChatGPT) finds it hard to verify behavior without a UI, a 03-07 UI mission may be needed earlier than expected. I'd defer this decision until 03-02 is reviewed.

3. **Consider `ReformAction.assignedTo` more carefully** — I made this a nullable `String` (userId), but in a real government context, assignment may be to a role (e.g., "Ministry of Planning analyst") rather than a specific user. If this is a common pattern, a `ReformAction.assignedRole` field may be needed. I'd appreciate the owner's view.

### 6.4 What I'd Like the Reviewer (ChatGPT) to Check

1. **The F6 trigger logic** — Is the trigger correct? Does it handle all edge cases (NULL, empty string, whitespace-only)?
2. **The cross-tenant triggers** — Are they comprehensive? Did I miss any child table?
3. **The permission matrix** — Are the role/permission assignments correct per the separation of duties principle?
4. **The Zod schemas** — Are the `superRefine` checks correct? Are there edge cases the regex patterns miss?
5. **The mission decomposition** — Is 7 missions the right granularity? Should any be split or merged?
6. **The open decisions** — Are my recommendations sound? Are there alternatives I missed?

---

## 7. Verification Status

### 7.1 What Was Verified Locally

| Check | Result |
|-------|--------|
| HEAD at `bc052b6` (verified checkpoint) | ✓ |
| Working tree clean before adding docs | ✓ |
| Only `docs/mission-reports/G03/` added (no src/ or prisma/ changes) | ✓ |
| No migrations added (last migration: `20261018000021_g02_observatory_bootstrap`) | ✓ |
| No `src/lib/reform/` directory created (services deferred) | ✓ |
| No permissions.ts changes (permissions deferred to 03-01) | ✓ |
| 7 design documents exist with expected line counts | ✓ |

### 7.2 What Was NOT Verified Locally

| Check | Reason | Mitigation |
|-------|--------|------------|
| `bun run lint` | `node_modules` not installed locally (fresh clone) | CI on GitHub Actions will install + run lint |
| `bunx tsc --noEmit` | Same as above | CI will run typecheck |
| `bun run test` (817 tests) | Same as above | CI will run all tests — expected to pass (no code changes) |
| `RUN_INTEGRATION_TESTS=1 bun test` | Same + needs PostgreSQL 16 | CI will run integration tests on real PostgreSQL 16 |
| `git push --dry-run` | Already verified in G03-GITHUB-ACCESS-READY-REPORT | Push will be tested by actual commit + push |

### 7.3 Expected CI Results

Since this is a **docs-only commit** (no `.ts`, `.tsx`, `.prisma`, `.sql` changes):
- **Lint**: Should pass (no new code to lint)
- **Typecheck**: Should pass (no new code to typecheck)
- **Tests**: Should pass with 817 tests (no code changes — same as CI #169 on `bc052b6`)
- **Integration tests**: Should pass with same count as before
- **Recovery**: Should pass (no schema changes — same migration count: 21)

---

## 8. Next Actions

### 8.1 For the Owner (Ayman)

1. **Review the 7 design documents** under `docs/mission-reports/G03/03-00/`
2. **Review the 8 open decisions** in `G03_00_OPEN_DECISIONS.md`
3. **Approve, modify, or reject** each decision (especially D1, D3, D4, D5 — required before 03-01)
4. **Forward to ChatGPT** (technical reviewer) for independent review
5. **Issue FINAL PASS / PENDING / FAIL** after both reviews complete

### 8.2 For the Technical Reviewer (ChatGPT)

1. **Independent code review** of the design documents
2. **Verify CI + Recovery** pass on the new commit
3. **Issue FINAL PASS / PENDING / FAIL** in Arabic (per project convention)
4. **Flag any architectural concerns** — especially around F6 enforcement, cross-tenant triggers, permission matrix, and mission decomposition

### 8.3 For GLM (me) — After Approval

1. If approved as-is: **Begin Mission 03-01** (schema bootstrap) when authorized
2. If approved with modifications: **Update the design documents** to reflect changes, then re-commit
3. If rejected: **Propose alternatives** for the rejected decisions and re-submit

---

## 9. Honest Disclosure

### 9.1 What This Mission Did NOT Do

- ❌ Did NOT write any TypeScript code
- ❌ Did NOT create any Prisma migrations
- ❌ Did NOT modify `permissions.ts`
- ❌ Did NOT create `src/lib/reform/` directory
- ❌ Did NOT create API routes
- ❌ Did NOT write tests
- ❌ Did NOT change the schema
- ❌ Did NOT run any tests locally (node_modules not installed in fresh clone)
- ❌ Did NOT push any commits yet (will push after this report is written)

### 9.2 What This Mission DID Do

- ✅ Read all G00/G01/G02 authoritative documents (handoff, readiness, ADRs, schema, services, contracts)
- ✅ Analyzed 35+ Prisma models, 17 state-observatory modules, 11 state-builder services
- ✅ Designed 7 new tables with full schemas, indexes, RLS policies, triggers
- ✅ Designed 9 new permissions with per-role matrix
- ✅ Designed 11 service modules with full signatures + Zod schemas
- ✅ Designed 30+ API routes
- ✅ Designed 5 state machines (proposal, alternative, action, verification, approval)
- ✅ Designed 3-layer audit pattern (authorization + event + audit_log)
- ✅ Designed F6 triple enforcement (Zod + DB trigger + service)
- ✅ Designed causal attribution prohibition (DB trigger + Zod + service)
- ✅ Decomposed G03 into 7 missions with clear scope/contracts/acceptance criteria
- ✅ Documented 8 open decisions with recommendations + alternatives + trade-offs
- ✅ Honored all 14 inherited invariants
- ✅ Proposed 10 new G3 invariants
- ✅ Maintained pattern consistency with G00/G01/G02

### 9.3 What I Cannot Verify

- The design has not been validated by actual implementation (that's 03-01 through 03-06)
- The Zod schemas have not been run against test inputs (no `bun install` locally)
- The DB triggers have not been tested on real PostgreSQL (no DB locally)
- The migration SQL has not been applied to a real DB (no DB locally)

These will all be verified in **Mission 03-01** (schema bootstrap) when the migration is actually written and tested.

---

## 10. Conclusion

Mission 03-00 is **complete**. The 7 design documents provide a comprehensive, internally consistent, invariant-honoring architecture for GROUP 03 — Targeted Reform. The architecture:

- **Closes the strategic loop**: observatory (G02) → reform (G03) → back to observatory
- **Preserves human sovereignty**: every transition is human-initiated and permission-gated
- **Maintains epistemic honesty**: descriptive only, never causal (enforced at DB level)
- **Honors all 14 inherited invariants**: no violations
- **Follows proven G01/G02 patterns**: consistency over novelty
- **Ships focused**: 7 missions, ~190 tests, ~6800 LOC — no scope creep

The 8 open decisions are documented with clear recommendations. I await the owner's approval (or modification/rejection) of each decision, and the technical reviewer's independent assessment.

**Once D1, D3, D4, D5 are approved, the architecture is frozen and Mission 03-01 (schema bootstrap) can begin.**

---

## 11. References

### 11.1 Documents Read (Authoritative Sources)

- `docs/handoffs/THE_BALANCE_GROUP_03_MASTER_HANDOFF_2026-10-18.md`
- `docs/mission-reports/G02/GROUP_03_READINESS_HANDOFF.md`
- `docs/mission-reports/G02/GROUP_02_KNOWN_LIMITATIONS.md`
- `docs/adr/ADR-0010-strategy-contracts-design.md`
- `docs/adr/ADR-0013-g01-domain-model.md`
- `docs/adr/ADR-0017-institutional-design.md`
- `docs/adr/ADR-0012-security-hardening-design.md`
- `prisma/schema.prisma` (994 lines — all 35+ models)
- `src/lib/permissions.ts`
- `src/lib/audit.ts`
- `src/lib/strategy-service.ts`
- `src/lib/state-builder/approval-service.ts`
- `src/lib/state-observatory/contracts.ts`
- `src/lib/state-observatory/index.ts`
- `src/lib/security/tenant-context.ts`
- `src/lib/balance-master.ts`

### 11.2 Documents Produced (This Mission)

1. `docs/mission-reports/G03/03-00/G03_00_ARCHITECTURE_PROPOSAL.md`
2. `docs/mission-reports/G03/03-00/G03_00_DOMAIN_MODEL.md`
3. `docs/mission-reports/G03/03-00/G03_00_WORKFLOW_AND_APPROVALS.md`
4. `docs/mission-reports/G03/03-00/G03_00_INTEGRATION_CONTRACTS.md`
5. `docs/mission-reports/G03/03-00/G03_00_SECURITY_AND_EVIDENCE_POLICY.md`
6. `docs/mission-reports/G03/03-00/G03_00_MISSION_ROADMAP.md`
7. `docs/mission-reports/G03/03-00/G03_00_OPEN_DECISIONS.md`
8. `docs/mission-reports/G03/03-00/G03_00_MISSION_REPORT.md` (this file)

---

**End of Mission 03-00 Report.**

**STUDY → DESIGN → DOCUMENT → VERIFY → REPORT → WAIT FOR OWNER REVIEW.**
