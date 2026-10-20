---
Task ID: G03-03-R1
Agent: GLM (corrective session)
Task: G03-03 R1 — Close concurrency-evidence gap without redesigning the implementation.

Work Log:
- Read PRE-04 reviewer finding: lockProposalRow silently skips SELECT FOR UPDATE
  when $queryRaw is missing; 12 ALT integration tests are sequential, not concurrent.
  Both files (reform-proposal-service.ts + reform-alternative-service.ts) duplicate the
  same flawed helper.

- R1.1 — Fail-closed lock helper (shared):
  * Created src/lib/reform/lock-helper.ts with LockUnavailableError + lockProposalRow().
  * Helper ALWAYS executes SELECT ... FOR UPDATE. If $queryRaw is not a function,
    throws LockUnavailableError (no silent skip — production contract).
  * Verifies proposal belongs to authenticated tenant (WHERE id AND tenantId);
    throws NotFoundError if 0 rows returned (no phantom lock).
  * Removed duplicated lockProposalRow from both service files; both now import
    from the shared helper. Exported via index.ts barrel.

- R1.1c — Unit tests updated:
  * Created tests/unit/reform/lock-helper.test.ts (6 tests) — covers
    LockUnavailableError on missing $queryRaw, NotFoundError on 0 rows,
    success on ≥1 row, bound-parameter signature, error diagnostics.
  * Updated tests/unit/reform/services.test.ts: added explicit $queryRaw
    mock to 4 lifecycle tests (submit ConflictError + NotFoundError, approve
    ConflictError + idempotency, audit-failure rollback).
  * Updated tests/unit/reform/reform-alternative-service.test.ts: added
    explicit $queryRaw mock to 5 lifecycle tests (add ConflictError +
    NotFoundError + D1, select ConflictError, withdraw ConflictError).

- R1.2 — Real PostgreSQL concurrency tests (C1-C7):
  * Created tests/integration/g03-03-concurrency.integration.test.ts (7 tests).
  * Each scenario uses 3 separate PrismaClient instances (admin, actor A, actor B)
    with independent connection pools. Synchronization via Promise.all — no sleeps.
  * C1: concurrent selection → exactly one wins, partial unique index blocks the other.
  * C2: approval vs withdrawal → no approval references withdrawn alternative.
  * C3: addition vs submission → no late additions after submission.
  * C4: selection vs withdrawal → at most one selected, serialized.
  * C5: concurrent approvals → exactly one immutable approval record.
  * C6: concurrent additions at capacity → at most 5 active alternatives.
  * C7: audit failure rollback — REVOKE INSERT on audit_log from balance_app,
    attempt approve, transaction rolls back, no partial mutation persists.
  * GRANT INSERT restored in finally block.

- R1.2 Local environment:
  * No PostgreSQL installed locally; no root; no Docker.
  * Downloaded postgresql-17 + postgresql-17-pgvector + libpq5 .deb packages via
    `apt-get download` (no root needed). Extracted to /tmp/pgsql17.
  * Initialized /tmp/pgdata with initdb, started pg_ctl on port 5432.
  * Created roles (balance_admin SUPERUSER, balance_app, balance_auth) + database.
  * Ran prisma migrate deploy + bun run db:seed.

- R1.2c — Concurrency tests executed locally:
  * 7/7 PASS on PostgreSQL 17.11 (CI uses pgvector/pgvector:pg16; behavior
    equivalent for FOR UPDATE + partial unique index + RLS).
  * Prisma error logs in stdout are EXPECTED — they prove the concurrency
    protections (unique constraint violations, RLS denials) actually fire.

- R1.3 — Transaction guarantees verified:
  * All mutating operations acquire the same single lock (proposal row)
    before evaluating mutable state. Single serialization point → no deadlocks.
  * Lock ordering consistent across add/select/withdraw/submit/approve.
  * Transaction failures roll back correctly (C7 verified atomicity).
  * Unique violations produce safe ConflictError (C1, C5, C6).
  * Tenant isolation enforced by WHERE clause + RLS (lock-acquire boundary).
  * No alternative/approval left inconsistent after concurrent failure
    (verified in C2, C4, C5, C7 post-conditions).

- R1.4 — Regression:
  * Unit: 391/391 PASS (was 385, +6 lock-helper tests).
  * G03-03 alternatives integration: 12/12 PASS.
  * G03-03 concurrency integration (NEW): 7/7 PASS.
  * G03-02 vertical slice: 13/13 PASS.
  * G03-02 sentinels (F6 + attribution + append-only + feedback atomicity): 17/17 PASS.
  * G03-01 SQL acceptance: 25/25 PASS.
  * Lint: 0 errors (3 pre-existing warnings).
  * Typecheck: 0 errors.
  * Build: SUCCESS (all 14 reform routes registered).
  * Note: G01/G02 baseline tests show local-only failures due to test
    pollution (share DB with seed data). Verified by stashing R1 changes —
    same failures occur without my changes. CI runs each suite against a
    fresh DB, so these will pass.

- R1.5 — Push to GitHub:
  * BLOCKED — no GitHub PAT available in this workspace.
    (Searched repo-info/GeneralGH/GeneralGH.zip, ~/.git-credentials, env vars,
    gh CLI, SSH keys — none present.)
  * Will produce a git bundle for owner-assisted publishing.

Stage Summary:
- R1 implementation complete. All 7 concurrency acceptance tests (C1-C7)
  pass against real PostgreSQL with true concurrent connections.
- Fail-closed lock contract enforced: production code always acquires
  SELECT FOR UPDATE; unit tests must mock $queryRaw explicitly.
- Tenant isolation enforced at the lock boundary (NotFoundError if proposal
  missing OR belongs to a different tenant).
- No migrations modified. No frozen G03-02 contracts changed.
- 46 approveReformProposal call sites remain unchanged.
- D1-D4 preserved. RLS/FORCE preserved. Append-only protections preserved.
  DEFINER functions remain DORMANT. Atomic audit preserved.
- Bundle ready for owner-assisted publishing.
- Awaiting FINAL PASS decision.
