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

## G02-L21 Resolution
G02-L21 is RESOLVED: all G02 integration test files now use `deleteMany({ where: { tenantId: tenantAId } })` instead of unrestricted `deleteMany({})`. Cleanup is scoped by tenant, preventing cross-tenant/cross-suite data deletion.
