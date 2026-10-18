# Mission 02-05 Report — Public / Research / Government Permissioned Observatory Views

```text
MISSION_ID = 02-05
TARGET_GROUP = GROUP 02 (State Observatory) — FINAL MISSION
BASE_COMMIT = 48b66789700086dcbdb74a8e5e46558c38886c10
FINAL_COMMIT = <set after CI passes>
```

## DELIVERED

### New module (1)
- `permissioned-view-service.ts` — `getPermissionedView()`. CORRECTION 1: fail-closed allowlist for evidence classification. CORRECTION 2: RLS-safe queries via `withAuthenticatedTenant`. CORRECTION 3: conservative clearance — ALL government viewers see only `classification="public"` evidence. Anonymous/research → `publication_unavailable` (fail-closed, no RLS query).

### G02-L21 Resolution
- All G02 integration test files: replaced unrestricted `deleteMany({})` with `deleteMany({ where: { tenantId: tenantAId } })` — scoped by tenant, preventing cross-tenant/cross-suite deletion.

### Tests
- `tests/unit/state-observatory/permissioned-view-service.test.ts` — 8 unit tests (P-01..P-08).
- `tests/integration/g02-permissioned-view.integration.test.ts` — 6 integration tests (P-09, P-10, P-11, P-12, P-13, P-16) on real PostgreSQL 16.

## CORRECTION VERIFICATION
- CORRECTION 1: Allowlist — only evidence explicitly found as `classification="public"` is included. Missing/unknown → excluded. (P-07, P-10, P-16)
- CORRECTION 2: Classification queries use `withAuthenticatedTenant` (RLS-safe). (P-09)
- CORRECTION 3: ALL government viewers (including admin) see only `classification="public"` evidence. No invented clearance. (P-10, P-16)
- CORRECTION 4: All `deleteMany({})` replaced with tenant-scoped cleanup. (G02-L21)

## TEST_COMMANDS
```
bun run lint && bun run typecheck && bun run test
```

### Local runtime
```
✓ lint: PASS (0 errors, 3 pre-existing G00 warnings)
✓ typecheck: PASS
✓ test: 320 passed | 499 skipped | 0 failed
```

## CONTRACT_CHANGES
- backward compatible: YES (additive only)
- migrations: NONE. tables: NONE. permissions: NONE. dependencies: NONE.
- src/lib/state-builder/ diff: 0. prisma/schema.prisma diff: 0.

## ACCEPTANCE
PENDING CI — local verification passes (320 tests).

## G02-L25 (NEW LIMITATION)
Publication approval gap: no mechanism exists to authorize public/research publication of tenant observatory data. Public and research tiers return `publication_unavailable` (fail-closed). Future mission required to implement publication approval.
