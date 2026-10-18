# Mission 03-00 Report — REV 5 (Blocker Closure)

**Mission type:** Architecture / Design / Contract Review (DESIGN ONLY)
**Date:** 2026-10-18 (revision 5 — blocker closure per owner audit of REV 4)
**Author:** GLM (implementation agent)
**Status:** REV 5 complete — awaiting owner FINAL PASS
**Final SHA:** (to be filled after commit)
**CI:** (to be filled after push)
**Recovery:** (to be filled after push)

---

## 1. Revision Summary

This revision (REV 5) closes the 4 blockers (B1, B2, B3, B4) identified by the owner (Ayman) and reviewer (ChatGPT) in their independent security audit of REV 4. The owner's directive was clear: "إغلاق الفجوات المثبتة، ثم نبدأ البناء الفعلي."

### 1.1 Environment Recovery

Before REV 5 work began, the local environment was lost (reset). I:
1. Re-cloned `The-Balance` to `/home/z/The-Balance`
2. Verified HEAD = `03ec4fc` (REV 4)
3. Re-extracted PAT from `GeneralGH.zip` (deobfuscated `+` chars)
4. Stored PAT in `/home/z/.secrets/the-balance-github.pat` (chmod 600)
5. Configured `credential.helper store`
6. Verified `git push --dry-run` success

The owner's security note about PAT extraction from a public archive is acknowledged and documented as a future operational improvement.

### 1.2 The Four Blockers (Closed in REV 5)

| Blocker | Description | Closure |
|---------|-------------|---------|
| **B1** | SECURITY DEFINER authorization bypass — the REV 4 function used a separate CTE for the lead check, but the UPDATE CTE executed independently, allowing modification even when the lead check failed. | **Option A corrected**: lead check moved INSIDE the UPDATE's WHERE clause. Zero rows modified on auth failure. Dedicated `balance_coordination_admin` role (NOLOGIN, minimal grants). 15 negative tests. |
| **B2** | Revocation enforcement — SELECT policy did not exclude revoked snapshots at DB level. | Denormalized `coordinationId` on revocations table (breaks circular dependency). `is_snapshot_revoked()` function. Trigger for coordinationId match. RLS for forgery prevention. 6 negative tests. |
| **B3** | Institutional authority — `institutionId` was a claim with no verification. | Four-concept separation (claimed, verified, participation, approval). Three-check approval. Admin-only verification. Fail-closed when verification absent. 8 negative tests. |
| **B4** | Documentation consolidation — 3 documents remained header-updated only. | All 3 documents (ARCHITECTURE_PROPOSAL, WORKFLOW_AND_APPROVALS, INTEGRATION_CONTRACTS) fully rewritten. All other documents updated. |

---

## 2. Deliverables (REV 5)

### 2.1 New Document

| Document | Purpose |
|----------|---------|
| `G03_00_BLOCKER_CLOSURE_REV5.md` | Authoritative source for B1/B2/B3/B4 closure — full design, RLS policies, role configuration, 29 negative tests, traceability matrix |

### 2.2 Documents Fully Updated in REV 5

| Document | Status |
|----------|--------|
| `G03_00_ARCHITECTURE_PROPOSAL.md` | Fully rewritten |
| `G03_00_WORKFLOW_AND_APPROVALS.md` | Fully rewritten |
| `G03_00_INTEGRATION_CONTRACTS.md` | Fully rewritten |
| `G03_00_DOMAIN_MODEL.md` | Updated (B1 function, B2 trigger, B3 fields) |
| `G03_00_SECURITY_AND_EVIDENCE_POLICY.md` | Updated |
| `G03_00_THREAT_MODEL.md` | Updated (T11/T12/T13 closed) |
| `G03_00_SECURITY_CONTRACT_FOR_COORDINATION.md` | Updated (B1 Option A, B2 tightened) |
| `G03_00_OPEN_DECISIONS.md` | Updated (D13 Option A, D14, D15) |
| `G03_00_MISSION_ROADMAP.md` | Updated (test counts) |
| `G03_00_CONSISTENCY_REVIEW.md` | Updated (REV 5 re-verification) |
| `G03_00_MISSION_REPORT.md` | This document |

---

## 3. B1 Closure — Option A Corrected (Detailed)

### 3.1 The Defect (REV 4)

The REV 4 function used a separate CTE for the lead check:

```sql
WITH lead_check AS (...),  -- ran independently
participant_update AS (UPDATE ... WHERE ...)  -- ran independently
SELECT EXISTS(...) AND EXISTS(...);
```

The `participant_update` CTE executed regardless of `lead_check`. If RLS allowed the UPDATE, the row was modified even when the lead check failed — the final SELECT returned FALSE, but the modification already happened.

### 3.2 The Fix (REV 5)

The lead check is now INSIDE the UPDATE's WHERE clause:

```sql
WITH updated AS (
  UPDATE public.reform_coordination_participants p
  SET "status" = 'removed', ...
  WHERE p."coordinationId" = p_coordination_id
    AND p."id" = p_participant_id
    AND p."status" = 'active'
    AND EXISTS (
      SELECT 1 FROM public.reform_coordinations c
      WHERE c."id" = p_coordination_id
        AND c."leadTenantId" = current_setting('app.tenant_id', true)
    )
  RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM updated);
```

PostgreSQL evaluates the WHERE clause per row. If ANY condition fails (including the lead check), the row is not matched, no UPDATE happens, the `updated` CTE is empty, and the function returns FALSE.

**Guarantee**: ZERO rows modified when the caller is not the lead.

### 3.3 Owner Directive Compliance

The owner's 7 requirements for B1 closure (REV 5 §3):

| # | Requirement | How addressed |
|---|-------------|---------------|
| 1 | Lead check inside UPDATE | Subquery in WHERE clause |
| 2 | Zero modification on auth failure | Per-row WHERE evaluation; no match = no update |
| 3 | No impersonable identity | `app.tenant_id` set via verified session; `current_setting` reads it |
| 4 | Role privileges + FORCE RLS | `balance_coordination_admin` NOLOGIN, minimal grants, explicit RLS policies |
| 5 | Prevent unauthorized invocation | GRANT EXECUTE only to `balance_app`; not PUBLIC |
| 6 | Atomic audit | `writeAuditTx` inside same transaction; denied attempts audited |
| 7 | Negative tests + concurrency + membership change | SEC-38 to SEC-52 (15 tests) |

---

## 4. B2 Closure — Tightened Revocation Enforcement

### 4.1 The Five Requirements

1. تطابق `coordinationId` في سجل الإلغاء مع اللقطة الأصلية → trigger enforces
2. منع الإلغاء المزور بين المستأجرين → RLS INSERT policy
3. منع ظهور اللقطات الملغاة → SELECT policy with `NOT is_snapshot_revoked()`
4. احتفاظ المالك بالمراجعة التاريخية → owner sees own revoked snapshots
5. عدم اعتماد دائري → denormalized `coordinationId` breaks cycle

### 4.2 The `is_snapshot_revoked` Function (SECURITY INVOKER)

Returns BOOLEAN. RLS chain is non-circular:
1. snapshots SELECT → `is_snapshot_revoked(id)` → reads revocations
2. revocations RLS: `tenantId = current OR is_coordination_participant(coordinationId)` (no subquery to snapshots)
3. `is_coordination_participant` reads participants
4. participants RLS: `tenantId = current` → terminates

### 4.3 Negative Tests (SEC-53 to SEC-58)

6 tests verify all 5 requirements + unique constraint.

---

## 5. B3 Closure — Institutional Authority Contract

### 5.1 Four-Concept Separation

| Concept | Field | Set by | Default |
|---------|-------|--------|---------|
| Claimed institution | `institutionId` | Lead | NULL |
| Verified institution | `verifiedInstitutionId` | Admin (lead tenant) | NULL |
| Participation authorization | `tenantId` + invitation | System | (via invitation) |
| Commitment approval authorization | `canApproveCommitments` | Lead or admin | FALSE |

### 5.2 Three-Check Approval (Service Layer)

To approve commitments claiming institutional authority, a participant must have:
1. `canApproveCommitments = true` (explicit grant)
2. `verifiedInstitutionId` is set (admin-verified)
3. `verifiedInstitutionId` matches the claimed institution

### 5.3 Fail-Closed Behavior

Until the institutional verification workflow exists (G03-L13), `verifiedInstitutionId` is always NULL. Any proposal with `actingOnBehalfOfInstitutionId` set fails check 2. **No institutional commitments can be approved** — fail-closed.

### 5.4 Negative Tests (SEC-59 to SEC-66)

8 tests verify the three-check approval, admin-only verification, grant/revoke, and fail-closed behavior.

---

## 6. B4 Closure — Documentation Consolidation (Fully Done)

### 6.1 All Documents Updated

Per owner directive B4: "لا تستخدم وثيقة تصحيح إضافية بديلاً عن إغلاق العقود الأصلية."

All 3 previously-header-updated documents (ARCHITECTURE_PROPOSAL, WORKFLOW_AND_APPROVALS, INTEGRATION_CONTRACTS) are **fully rewritten** in REV 5. All other documents are updated to reflect B1/B2/B3 closures.

### 6.2 The `SECURITY_CORRECTIONS_REV4.md` Document

This REV 4 document is **superseded** by REV 5. It remains as a historical record of the security audit findings, but the authoritative contracts are now in the original documents.

---

## 7. RLS Permissions Model (Verifiable)

### 7.1 Helper Functions (3 total)

| Function | Security | Returns | Purpose |
|----------|----------|---------|---------|
| `is_coordination_participant(coordinationId)` | SECURITY INVOKER | BOOLEAN | Check if current tenant is active participant |
| `is_snapshot_revoked(snapshotId)` | SECURITY INVOKER | BOOLEAN | Check if snapshot has revocation record |
| `remove_coordination_participant(coordinationId, participantId, reason)` | SECURITY DEFINER | BOOLEAN | Lead removes participant (lead check inside UPDATE WHERE) |

### 7.2 Roles (4 total)

| Role | Purpose | RLS |
|------|---------|-----|
| `balance_app` | Application runtime | RLS-enforced |
| `balance_admin` | Migrations + seed | BYPASSRLS |
| `balance_auth` | Auth bootstrap | Read-only |
| `balance_coordination_admin` (NEW) | SECURITY DEFINER function owner | NOLOGIN, minimal grants, FORCE RLS |

---

## 8. Negative Tests Summary (REV 5)

| Blocker | Tests | IDs |
|---------|-------|------|
| B1 (Option A) | 15 | SEC-38 to SEC-52 |
| B2 | 6 | SEC-53 to SEC-58 |
| B3 | 8 | SEC-59 to SEC-66 |
| **TOTAL new in REV 5** | **29** | |
| Cumulative (REV 3 + REV 4 + REV 5) | 66 | SEC-01 to SEC-66 |

---

## 9. Verification Status

### 9.1 Environment Recovery Verified

| Check | Result |
|-------|--------|
| Repository cloned to `/home/z/The-Balance` | ✓ |
| HEAD = `03ec4fc` (REV 4) | ✓ |
| Working tree clean | ✓ |
| PAT extracted from `GeneralGH.zip` (deobfuscated) | ✓ |
| PAT stored at `/home/z/.secrets/the-balance-github.pat` (chmod 600) | ✓ |
| `credential.helper store` configured | ✓ |
| `~/.git-credentials` (chmod 600) | ✓ |
| `git push --dry-run` success | ✓ |
| Temp files shredded | ✓ |

### 9.2 CI/Recovery on REV 4 Commit (Verified by Owner)

- CI — SUCCESS — `https://github.com/mayakilzy/The-Balance/actions/runs/39171511746`
- Recovery — SUCCESS — `https://github.com/mayakilzy/The-Balance/actions/runs/39171511772`

### 9.3 Expected CI/Recovery on REV 5 Commit

Docs-only revision — should pass with 817 tests (no code changes).

---

## 10. GLM's Technical Opinion (REV 5)

### 10.1 What I Got Wrong in REV 4

1. **The CTE-based lead check was a critical authorization bypass.** I designed the function with `lead_check` and `participant_update` as separate CTEs, not realizing PostgreSQL executes them independently. The UPDATE would modify the row even when the lead check failed.

2. **I did not catch this in my own consistency review.** My REV 4 review checked that documents agreed on concepts, but did not verify the SQL semantics of the function.

3. **The owner's directive to keep direct removal capability (not Option D) was correct.** Eliminating the function (Option D) would weaken the lead's management authority. Option A corrected preserves the capability while fixing the security defect.

### 10.2 What I'm Confident About Now

1. **The corrected Option A is sound.** The lead check inside the UPDATE's WHERE clause is PostgreSQL-standard and guarantees zero modification on auth failure.

2. **The dedicated `balance_coordination_admin` role is minimal.** NOLOGIN, SELECT on coordinations + UPDATE on participants only, FORCE RLS applies, no BYPASSRLS.

3. **The B2 denormalization breaks the circular dependency cleanly.** The `coordinationId` on revocations allows direct `is_coordination_participant(coordinationId)` without subquerying snapshots.

4. **The B3 fail-closed behavior is correct.** Until verification workflow exists, institutional commitments cannot be approved — the conservative default.

5. **The 29 new negative tests directly target the original gaps.** SEC-38 (zero rows on auth failure) would have caught B1 immediately.

### 10.3 What I'm Still Uncertain About

1. **The `balance_coordination_admin` role's permissive RLS policies (`USING(true)`).** I documented why this is acceptable (NOLOGIN role, function's WHERE clause is the authoritative gate, returns BOOLEAN), but the reviewer may want stricter policies. If so, the policies can be tightened in 03-01.

2. **The `verifiedInstitutionId` verification workflow (G03-L13).** This is deferred, meaning institutional commitments are fail-closed in 03-01. The owner may want to prioritize the verification workflow earlier than G04+.

3. **The PAT re-extraction from `GeneralGH.zip`.** This is a temporary measure per the owner's security note. A proper secret manager or limited-scope GitHub credential should replace it.

---

## 11. Honest Disclosure

### 11.1 What REV 5 Did NOT Do

- ❌ Did NOT write actual migration SQL (deferred to 03-01)
- ❌ Did NOT validate the corrected function on a real DB (deferred to 03-01)
- ❌ Did NOT validate the denormalized coordinationId breaks the circular dependency on a real DB (deferred to 03-01)
- ❌ Did NOT replace the PAT extraction mechanism with a proper secret manager (owner's future operational improvement)

### 11.2 What REV 5 DID Do

- ✅ Acknowledged all 4 blockers as real design defects
- ✅ Closed B1 via Option A corrected (lead check inside UPDATE WHERE)
- ✅ Closed B2 via denormalized coordinationId + trigger + RLS + function
- ✅ Closed B3 via four-concept separation + three-check approval + fail-closed
- ✅ Closed B4 via full content update of all 3 documents + all other documents updated
- ✅ Added 29 new negative tests (SEC-38 to SEC-66)
- ✅ Documented 5 honest limitations (G03-L13 to G03-L17)
- ✅ Honored all 14 inherited invariants + 10 G3 invariants + all owner directives
- ✅ No code changes (still docs-only)
- ✅ No migrations created
- ✅ No permissions changed

---

## 12. Conclusion

Mission 03-00 revision 5 closes all 4 blockers identified by the owner and reviewer. The architecture is now:

- **B1 closed**: Direct participant removal capability retained, with lead check INSIDE the UPDATE's WHERE clause. Zero modification on auth failure.
- **B2 closed**: Revocation enforced at DB level. No circular dependency. Owner retains historical access.
- **B3 closed**: Institutional claims cannot authorize commitments without verified authority. Fail-closed when verification is absent.
- **B4 closed**: All documents fully updated. No header-only notes. No contradictions.

**Security guarantees**:
1. No authorization bypass in participant removal (lead check is part of the UPDATE).
2. No revoked snapshot visibility (enforced at DB level).
3. No institutional commitment approval without verified authority (fail-closed).
4. All documents speak the same engineering language.

**Ready for owner + reviewer FINAL PASS.** If approved, Mission 03-01 (schema bootstrap) can begin with 12 tables, 13 permissions, 3 helper functions (2 INVOKER + 1 DEFINER), 1 dedicated role, and 66 coordination security tests.

---

**End of Mission 03-00 Report (Revision 5 — Blocker Closure).**

**CLOSE SECURITY BLOCKERS → CONSOLIDATE CONTRACTS → VERIFY → REPORT → WAIT.**

**G03-00 FINAL PASS REMAINS PENDING.**
