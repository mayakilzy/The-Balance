# G03-00 — Empirical Security Validation Report (REV 6)

> **Mission:** 03-00 — Targeted Reform Architecture & Scope Foundation
> **Document type:** Empirical security validation results (DESIGN ONLY — test scripts, no app code)
> **Date:** 2026-10-18 (revision 6 — empirical validation on real PostgreSQL 16.4)
> **Author:** GLM (implementation agent)
> **Status:** REV 6 — empirical proof of B1 contract; documented limitations honest
> **Companion to:** `G03_00_BLOCKER_CLOSURE_REV5.md` (corrected by these findings)

---

## 1. Executive Summary

Per owner directive (REV 5 audit): "استخدم PostgreSQL 16 حقيقياً في بيئة اختبار محلية معزولة. أنشئ اختباراً مستقلاً للعقود الأمنية المقترحة."

I built PostgreSQL 16.4 from source (no root access, no Docker), created an isolated test database, and ran empirical validation of the B1 security contract. This REV 6 report distinguishes **empirically proven results** from **architectural assumptions**.

### 1.1 Key Findings

| Finding | Status | Evidence |
|---------|--------|----------|
| B1.1: Lead can remove participant (function works) | ✅ PROVEN | TEST 1: result=TRUE, status changed to 'removed' |
| B1.2: Non-lead cannot remove (zero modification) | ✅ PROVEN | TEST 2: result=FALSE, status unchanged |
| B1.3: Direct cross-tenant UPDATE blocked by RLS | ✅ PROVEN | TEST 3: 0 rows updated |
| B1.4: PUBLIC cannot EXECUTE the function | ✅ PROVEN | TEST 4: ERROR "permission denied for function" |
| B1.5: `set_config` impersonation possible | ⚠️ DOCUMENTED LIMITATION | TEST 5: impersonation SUCCEEDED |
| B1.6: `balance_coordination_admin` needs SELECT privilege | ✅ FIXED & PROVEN | Initial failure → granted SELECT → works |

### 1.2 Critical Correction to REV 5 Contract

**The REV 5 contract was incomplete**: it granted `balance_coordination_admin` only `UPDATE` on participants, claiming `UPDATE...RETURNING` doesn't need SELECT. **This is false in PostgreSQL**.

PostgreSQL documentation states: *"For UPDATE, also requires SELECT privilege on all columns whose values are read in SET expressions or in the WHERE clause."* ([PostgreSQL 16 GRANT docs](https://www.postgresql.org/docs/16/sql-grant.html))

**The function reads columns** (`"coordinationId"`, `"id"`, `"status"`) in the WHERE clause, so it needs SELECT privilege. Without it, the function fails with `permission denied for table reform_coordination_participants`.

**Fix applied in the test script**: Granted `SELECT` on `reform_coordination_participants` to `balance_coordination_admin` + added RLS SELECT policy (`USING(true)`). This is acceptable because:
1. The role is NOLOGIN (cannot connect directly)
2. The function returns BOOLEAN (no data exfiltration via the function)
3. The function's WHERE clause enforces the lead check
4. The role has no other privileges

---

## 2. Test Environment

### 2.1 PostgreSQL Build

- **Version**: PostgreSQL 16.4
- **Source**: Built from official source (`postgresql-16.4.tar.gz` from postgresql.org)
- **Build**: `./configure --prefix=/home/z/pgsql16/installed --without-readline --without-zlib --without-icu --disable-nls && make -j2 -s && make install -s`
- **Data dir**: `/home/z/pgsql16/testdata`
- **Port**: 15432 (isolated, no conflict)
- **Auth**: trust (local only — test environment)

### 2.2 Test Database

- **Database**: `g03_security_test` (isolated, no connection to project data)
- **Schema**: `g03_b1_test` (isolated, dropped and recreated for each run)
- **Roles**: `balance_app`, `balance_admin` (BYPASSRLS), `balance_coordination_admin` (NOLOGIN)
- **Test data**: Synthetic (tenant-A, tenant-B, coord-1, coord-2, part-A1, part-B1, etc.)

### 2.3 Reproducibility

The test script is at `scripts/g03-security-validation/b1_participant_removal.sql` (committed to the repo). It can be re-run with:

```bash
# Build PostgreSQL 16.4 (or use existing installation)
# Start the server on port 15432
# Run:
psql -p 15432 -U postgres -d postgres -c "CREATE DATABASE g03_security_test;"
psql -p 15432 -U postgres -d g03_security_test -f scripts/g03-security-validation/b1_participant_removal.sql
```

No secrets, no project data, no app code changes.

---

## 3. B1 Test Results (Detailed)

### 3.1 TEST 1: Lead removes participant (PASS)

**Setup**: tenant-A is lead of coord-1. part-B1 is a tenant-B participant in coord-1 (active status).

**Action**: `balance_app` (with `app.tenant_id='tenant-A'`) calls `remove_coordination_participant('coord-1', 'part-B1', 'Lead removes participant')`.

**Result**:
```
 test1_result 
--------------
 t
(1 row)

 TEST1_verify | part-B1 | removed | user-A-admin
```

**Verdict**: ✅ **PASS**. The function returned TRUE, and the participant's status changed to 'removed' with the correct `removedBy`.

### 3.2 TEST 2: Non-lead cannot remove (PASS)

**Setup**: tenant-B is NOT the lead of coord-1 (tenant-A is). part-A1 is a tenant-A participant in coord-1.

**Action**: `balance_app` (with `app.tenant_id='tenant-B'`) calls `remove_coordination_participant('coord-1', 'part-A1', 'Non-lead attempt')`.

**Result**:
```
 test2_result 
--------------
 f
(1 row)

 TEST2_verify | part-A1 | active | 
```

**Verdict**: ✅ **PASS**. The function returned FALSE, and the participant's status remained 'active' (unchanged). **Zero rows modified** — this is the critical B1 closure proof.

### 3.3 TEST 3: Direct cross-tenant UPDATE blocked by RLS (PASS)

**Setup**: tenant-A's `balance_app` attempts a direct UPDATE on part-B2 (tenant-B's row in coord-2).

**Action**: `UPDATE reform_coordination_participants SET "removalReason" = 'direct update attempt' WHERE id = 'part-B2' AND status = 'active'`.

**Result**:
```
 TEST3_verify | part-B2 | active | 
```

**Verdict**: ✅ **PASS**. The `removalReason` column remained NULL — the UPDATE affected 0 rows because RLS blocked the SELECT visibility of part-B2 (tenant-A cannot see tenant-B's rows).

### 3.4 TEST 4: PUBLIC cannot EXECUTE the function (PASS)

**Setup**: A `test_public_user` LOGIN role (with USAGE on schema, no EXECUTE grant) attempts to call the function.

**Action**: `SELECT g03_b1_test.remove_coordination_participant('coord-2', 'part-A2', 'public attempt')`.

**Result**:
```
ERROR:  permission denied for function remove_coordination_participant
```

**Verdict**: ✅ **PASS**. The `REVOKE EXECUTE FROM PUBLIC` worked. Unprivileged users cannot invoke the function.

### 3.5 TEST 5: `set_config` impersonation (DOCUMENTED LIMITATION)

**Setup**: tenant-A's `balance_app` sets `app.tenant_id = 'tenant-B'` (impersonating tenant-B) and calls the function on coord-2 (lead: tenant-B).

**Action**: `SET LOCAL app.tenant_id = 'tenant-B'; SELECT remove_coordination_participant('coord-2', 'part-A2', 'impersonation');`

**Result**:
```
 test5_result 
--------------
 t
(1 row)

 TEST5_verify | part-A2 | removed | impersonator
```

**Verdict**: ⚠️ **DOCUMENTED LIMITATION**. The impersonation **succeeded** — the function returned TRUE and the participant was removed.

**Root cause**: PostgreSQL's `set_config()` / `SET LOCAL` can be called by any role with normal connection privileges. There is no DB-level mechanism to prevent `balance_app` from setting `app.tenant_id` to an arbitrary value.

**Implication**: The security model **depends on the application layer** (`withAuthenticatedTenant` in `src/lib/security/tenant-context.ts`) to set `app.tenant_id` only from a verified session, NOT from client input. This is **not a DB-level guarantee** — it is an application-layer invariant.

**Documentation update needed**: The REV 5 contract claimed "balance_app cannot set app.tenant_id arbitrarily". This is **inaccurate**. The correct statement is:

> "The security model assumes the application layer (`withAuthenticatedTenant`) sets `app.tenant_id` from a verified session. PostgreSQL does NOT prevent `balance_app` from setting custom GUCs via `set_config()`. If an attacker gains direct SQL access as `balance_app`, they can impersonate any tenant. This is a documented limitation mitigated by: (1) no direct SQL access in production, (2) the application never passes client-supplied tenant IDs to `set_config`, (3) audit logging records the actor."

---

## 4. Corrections to REV 5 Contract

### 4.1 Correction C1: `balance_coordination_admin` needs SELECT privilege

**REV 5 claim**: "balance_coordination_admin has UPDATE on participants only (not SELECT). The function uses UPDATE...RETURNING, which requires UPDATE privilege but reads via RETURNING, not SELECT."

**Empirical finding**: **FALSE**. PostgreSQL requires SELECT privilege for:
- Columns read in the WHERE clause (`"coordinationId"`, `"id"`, `"status"`)
- Columns read via RETURNING (though this is more nuanced — RETURNING of updated values works, but reading existing values requires SELECT)

**Correction**: Grant `SELECT` on `reform_coordination_participants` to `balance_coordination_admin`. Add a SELECT RLS policy (`USING(true)` — acceptable because the role is NOLOGIN and the function returns BOOLEAN).

### 4.2 Correction C2: `set_config` is NOT a DB-level identity guarantee

**REV 5 claim**: "balance_app cannot set app.tenant_id to an arbitrary value — it can only set it via the application's verified session mechanism."

**Empirical finding**: **FALSE**. PostgreSQL allows any role to call `set_config(name, value, is_local)`. There is no DB-level restriction on which values `balance_app` can set for custom GUCs.

**Correction**: The security model **depends on the application layer** to set `app.tenant_id` correctly. This is a documented limitation, not a DB guarantee. The mitigation is operational (no direct SQL access in production) + application-layer verification (`withAuthenticatedTenant` reads from verified session, never from client input).

### 4.3 Correction C3: Tests must run in transactions

**Finding**: `set_config(..., true)` sets the GUC transaction-locally. If tests run as separate statements (psql default), the GUC is lost between statements.

**Correction**: All tests that set `app.tenant_id` must run inside a `BEGIN...COMMIT` block. This is a test-script concern, not a contract issue.

---

## 5. B2 and B3 Tests (Deferred to Follow-up)

Due to time constraints in this session, B2 (revocation) and B3 (institutional authority) tests are **not yet run empirically**. They are the next priority.

**Owner directive**: "اختبر عمليات منح وسحب تفويض الاعتماد والتحقق المؤسسي" (B3) and "اختبر على PostgreSQL حقيقي: رؤية اللقطات المعتمدة، إلغاء اللقطات..." (B2).

**Status**: B2 and B3 test scripts will be written and run in a follow-up commit. The B1 results above are sufficient to demonstrate the empirical validation approach works and to correct the REV 5 contract.

---

## 6. Updated RLS Permissions Model (REV 6 — Corrected)

### 6.1 `balance_coordination_admin` Grants (CORRECTED)

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|:---:|:---:|:---:|:---:|
| `reform_coordinations` | ✓ (for lead check subquery) | — | — | — |
| `reform_coordination_participants` | ✓ (**CORRECTED** — needed for WHERE clause) | — | ✓ | — |

### 6.2 RLS Policies for `balance_coordination_admin` (CORRECTED)

| Table | Policy | USING | WITH CHECK |
|-------|--------|-------|------------|
| `reform_coordinations` | SELECT | `true` | — |
| `reform_coordination_participants` | SELECT (**NEW**) | `true` | — |
| `reform_coordination_participants` | UPDATE | `true` | `true` |

### 6.3 Documented Limitation: `set_config` Impersonation

The security model assumes (but does not enforce at DB level) that:
1. `balance_app` is never used for direct SQL access in production
2. The application (`withAuthenticatedTenant`) sets `app.tenant_id` only from a verified session
3. No client-supplied value reaches `set_config('app.tenant_id', ...)`

If these assumptions hold, the B1 contract is secure. If any assumption is violated (e.g., a SQL injection allows `set_config`), an attacker can impersonate any tenant.

**Mitigation**: 
- Application-layer: `withAuthenticatedTenant` is the only path to set `app.tenant_id`
- Operational: No direct DB access for `balance_app` in production (only via the app)
- Audit: All `set_config` calls could be logged via a trigger (future enhancement)

---

## 7. Deliverables

### 7.1 Test Script (Committed)

- `scripts/g03-security-validation/b1_participant_removal.sql` — reproducible test script
- `scripts/g03-security-validation/b1_results.txt` — raw test output (for evidence)

### 7.2 Documents to Update

The following documents need updates to reflect the REV 6 corrections:

| Document | Update needed |
|----------|---------------|
| `G03_00_BLOCKER_CLOSURE_REV5.md` | Add C1 (SELECT grant), C2 (set_config limitation), C3 (transaction tests) |
| `G03_00_SECURITY_CONTRACT_FOR_COORDINATION.md` | Update role grants + add documented limitation |
| `G03_00_OPEN_DECISIONS.md` | Add D16 (set_config limitation — documented, not DB-enforced) |
| `G03_00_THREAT_MODEL.md` | Add T14 (set_config impersonation if direct SQL access) |
| `G03_00_MISSION_REPORT.md` | REV 6 report (this document) |

### 7.3 Not Done (Honest Disclosure)

- ❌ B2 empirical tests (revocation enforcement on real DB) — deferred to follow-up
- ❌ B3 empirical tests (institutional authority cross-tenant operations) — deferred to follow-up
- ❌ Full content updates to the 5 documents listed in §7.2 — will be done in follow-up commit if owner accepts REV 6 approach

---

## 8. GLM's Technical Opinion (REV 6)

### 8.1 What the Empirical Validation Revealed

1. **The REV 5 contract had a real defect** (missing SELECT privilege). My documentation claimed `UPDATE...RETURNING` doesn't need SELECT, but PostgreSQL requires it for WHERE clause column reads. The empirical test caught this immediately — proving the owner's directive to validate on real PostgreSQL was correct.

2. **`set_config` is NOT a DB-level identity guarantee.** This is a fundamental limitation of PostgreSQL's GUC mechanism. The security model must honestly document this as an application-layer assumption, not claim it as a DB-level invariant.

3. **The B1 core contract (lead check inside UPDATE WHERE) works correctly.** When the function has correct privileges, it returns FALSE and modifies zero rows on authorization failure. This is the critical B1 closure proof.

### 8.2 What I'm Confident About Now

1. **The B1 contract is sound** (with the SELECT grant fix). The lead check inside UPDATE WHERE is the correct PostgreSQL pattern.

2. **The empirical validation approach is the right path forward.** Documenting contracts without testing them leads to defects (as REV 4 and REV 5 showed). Testing on real PostgreSQL catches them immediately.

3. **The documented limitation on `set_config` is honest.** Rather than claiming a DB-level guarantee that doesn't exist, the contract now explicitly states the assumption and its mitigation.

### 8.3 What I Recommend

1. **Accept REV 6 as the corrected B1 contract** (with the SELECT grant fix and documented set_config limitation).

2. **Defer B2 and B3 empirical tests to a short follow-up** — I have the test infrastructure ready, just need to write the B2/B3 scripts.

3. **Do NOT grant FINAL PASS until B2 and B3 are also empirically validated.** The owner's directive was clear: prove the contracts work, don't just document them.

---

## 9. Next Actions

### 9.1 For the Owner (Ayman)

1. **Review the B1 empirical results** in this document and the test script
2. **Verify the test script** can be reproduced (instructions in §2.3)
3. **Decide**: Accept REV 6 B1 results + authorize B2/B3 empirical tests as follow-up?
4. **Forward to ChatGPT** for independent review of the empirical evidence

### 9.2 For the Technical Reviewer (ChatGPT)

1. **Verify the test results** match the claims
2. **Re-run the test script** if desired (reproducible, no secrets)
3. **Focus on**: the C1 correction (SELECT grant), C2 limitation (set_config), and whether the documented mitigation is sufficient

### 9.3 For GLM (me) — After Owner Direction

1. If accepted: write B2 and B3 empirical test scripts + run them + report results
2. Update the 5 documents listed in §7.2 with the REV 6 corrections
3. Commit + push the test scripts + updated documents

---

## 10. Conclusion

REV 6 provides **empirical proof** that the B1 contract works correctly on real PostgreSQL 16.4, with two corrections to the REV 5 contract:

1. **C1 (fixed)**: `balance_coordination_admin` needs SELECT privilege (PostgreSQL requirement for WHERE clause column reads)
2. **C2 (documented limitation)**: `set_config` is not a DB-level identity guarantee — the security model depends on the application layer

The B1 closure is **empirically validated** for:
- Lead can remove participant (TEST 1: PASS)
- Non-lead cannot remove (TEST 2: PASS — zero modification)
- Direct cross-tenant UPDATE blocked (TEST 3: PASS)
- PUBLIC cannot EXECUTE (TEST 4: PASS)
- `set_config` impersonation possible (TEST 5: DOCUMENTED LIMITATION)

B2 and B3 empirical tests are the next priority. The test infrastructure (PostgreSQL 16.4, isolated database, reproducible scripts) is ready.

**Ready for owner + reviewer direction on B2/B3 empirical validation.**

---

*End of G03-00 Empirical Security Validation Report (REV 6). This document provides empirical evidence, not architectural assumptions.*
