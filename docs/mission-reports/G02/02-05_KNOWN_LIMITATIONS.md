# GROUP 02 — Mission 02-05 Known Limitations
**Mission:** 02-05 — Permissioned Observatory Views + GROUP 02 Closure
**Date:** 2026-10-18

## New Limitation

### G02-L25: Publication Approval Gap
- **Affected component:** Public and Research tiers
- **Description:** No publication approval mechanism exists in the schema. `Evidence.classification="public"` is a default value, not publication consent. Public and Research tiers return `publication_unavailable` (fail-closed).
- **Impact:** Public and Research observatory data is deliberately unavailable until a trustworthy publication system is implemented.
- **Status:** DOCUMENTED — deliberate fail-closed design. Future mission required.

### G02-L26: Government Projection Limited to Public Evidence
- **Affected component:** `permissioned-view-service.ts` government tier
- **Description:** The new permissioned projection includes only `classification="public"` evidence for ALL government viewers (including admin). No classified/restricted clearance policy exists.
- **Impact:** Government viewers see a conservative subset of evidence. The existing Observatory Snapshot (02-02) still shows all evidence for authorized users — the new projection is additive, not replacing.
- **Status:** DOCUMENTED — conservative security design. Granular clearance requires explicit owner approval.

## G02-L21 Resolution — CLOSED

**G02-L21 is CLOSED.** Owner-verified closure on SHA `b5fb96503ab4a11bc0204c6cf6a020b1c2d2cbd3` (CI #167 + Recovery #105).

The original resolution statement (scoped `deleteMany({ where: { tenantId } })`) was superseded by a stricter ownership-aware approach in subsequent commits. The final closure path:

1. **SHA `6c18c7a`** — Removed 146 redundant `testFixtures.track.observationPeriod(<id>)` calls that bypassed the ownership-aware `trackOwned` API. Added ownership-aware tracking for all `beforeAll` shared fixtures. Added 4 sentinel regression tests.
2. **SHA `11a813b`** — Removed text-based exception suppression in `FixtureTracker.cleanup()`. Added FINAL-1 (negative regression), FINAL-2 (parallel cleanup), FINAL-2b (parallel with overlap).
3. **SHA `b5fb965`** — Fixed FINAL-1 test (rewrote to use broken PrismaClient for deterministic DB error).

Final state of the FixtureTracker:
- `trackOwned(record)` only tracks when `createdByThisSuite=true` — pre-existing records are never registered for deletion.
- `cleanup(client)` uses `deleteMany({ where: { id } })` (idempotent — `count=0` for missing records, no throw).
- Real DB errors are surfaced (no text-based suppression).
- Tracking state is RETAINED after failure.
- 7 sentinel regression tests PASS on real PostgreSQL 16 in CI #167.

See `GROUP_02_KNOWN_LIMITATIONS.md` for the authoritative GROUP 02 limitations register.
