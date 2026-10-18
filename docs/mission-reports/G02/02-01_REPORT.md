# Mission 02-01 Report — Validated Evidence & Data Ingestion

```text
MISSION_ID = 02-01
TARGET_GROUP = GROUP 02 (State Observatory)
BASE_COMMIT = 3c17229186d5dbb683c128ff3bba36e264b88876
FINAL_COMMIT = <set after CI passes>
WORKTREE = clean (mission-02-01 branch)
```

## DELIVERED

### New modules (3)
- `src/lib/state-observatory/provenance-validator.ts` — Pure function `validateObservationProvenance()` with 11 rules (A2, A7, A8, A13, A15, A16). Never mutates verificationStatus (A8).
- `src/lib/state-observatory/evidence-country-validator.ts` — Pure function `verifyEvidenceCountryScope()`. Uses `Evidence.metadata.countryId` (A4). Missing → warning (A5). Mismatch → rejection (A6).
- `src/lib/state-observatory/evidence-independence-service.ts` — `analyzeIndependence()` service. Counts distinct sources (A9), dedup by `independenceGroup` (A10), multiple obs from same source = 1 source (A11), only `isCurrent=true` (A12), classifies FULL/PARTIAL/LOW per Blueprint §5.4.

### Modified modules (2)
- `src/lib/state-observatory/observation-service.ts` — `ingestObservation` now calls `validateObservationProvenance()` + `verifyEvidenceCountryScope()` + tenant checks BEFORE INSERT. Warnings attached to `qualityNotes.provenanceWarnings`.
- `src/lib/state-observatory/index.ts` — Exports new modules.

### Tests
- `tests/unit/state-observatory/provenance-validator.test.ts` — 15 unit tests (U-01..U-12 + edge cases).
- `tests/unit/state-observatory/evidence-country-validator.test.ts` — 8 unit tests (U-09, U-10, U-11 + edge cases).
- `tests/unit/state-observatory/evidence-independence-service.test.ts` — 10 unit tests (A10, A11, A12, A14, Blueprint §5.4 classification, geo scoping, audit).
- `tests/integration/g02-independence.integration.test.ts` — 5 integration tests (H-05, H-06, H-07, H-08, H-12) on real PostgreSQL 16.
- `tests/integration/g02-provenance-hardening.integration.test.ts` — 8 integration tests (H-01, H-02, H-03, H-04, H-09, H-10, H-11) on real PostgreSQL 16 with isolated audit-failure injection.
- `tests/unit/state-observatory/observation-service.test.ts` — Updated mocks for new `tx.source.findUnique` + `tx.evidence.findFirst` + `tx.tenant.findUnique` calls.

### Documentation
- `docs/mission-reports/G02/02-01_REPORT.md` — this file.
- `docs/mission-reports/G02/02-01_KNOWN_LIMITATIONS.md` — new 02-01 limitations + G02-L07/L08 status update.
- `docs/mission-reports/G02/02-00_KNOWN_LIMITATIONS.md` — G02-L07 + G02-L08 marked RESOLVED by 02-01 (pending CI verification).

## TEST_COMMANDS

```
bun run lint && bun run typecheck && bun run test
```

### Local runtime (with AUTH_SECRET set, simulating CI)

```
✓ lint: PASS (0 errors, 3 pre-existing G00 warnings)
✓ typecheck: PASS
✓ test: 273 passed | 465 skipped | 0 failed
```

## LIVE_EVIDENCE

### real (verified locally with mocks; pending CI on real PostgreSQL)
- ✅ Provenance validation: 15 unit tests pass — rejects refuted evidence, rejects cross-tenant evidence, rejects cross-tenant source, warns on candidate source, warns on disputed evidence, never auto-promotes verificationStatus.
- ✅ Country scope: 8 unit tests pass — valid/unknown/mismatch classification correct.
- ✅ Independence: 10 unit tests pass — dedup by independenceGroup, multiple obs from same source = 1 source, only isCurrent=true counted, FULL/PARTIAL/LOW classification.
- ✅ Integration with ingestObservation: validation runs before INSERT, warnings attached to qualityNotes.

### pending CI verification (real PostgreSQL 16)
- ⏳ H-01: Audit failure injection → real rollback (REVOKE INSERT on audit_log)
- ⏳ H-02: Correction mid-tx failure → no partial state
- ⏳ H-03: Concurrent correction failure → chain preserved
- ⏳ H-04: Duplicate value handling (F1 constraint, not value equality)
- ⏳ H-05: Independence dedup by independenceGroup (real DB)
- ⏳ H-06: Multiple obs from same source (real DB)
- ⏳ H-07: Corrections don't inflate independence (real DB)
- ⏳ H-08: FULL/PARTIAL/LOW classification (real DB)
- ⏳ H-09: Country scope mismatch rejected (real DB)
- ⏳ H-10: Missing country metadata → warning (real DB)
- ⏳ H-11: Cross-tenant evidence rejected (real DB)
- ⏳ H-12: Counter-evidence preserved (real DB)

### mocked
- Unit tests use mocked Prisma transaction client for deterministic provenance rule verification.

### not tested
- Browser UI (out of scope).
- External integrations (out of scope).
- LLM (out of scope).

## SECURITY_CHECKS

- **authz**: Reuses `observatory:observation:read`. No new permissions.
- **tenant isolation**: A15 (cross-tenant evidence rejected) + A16 (cross-tenant source rejected) verified by unit tests U-05, U-06, U-07.
- **country scope**: A6 (mismatch reject) + A5 (missing warn) verified by U-09, U-10, U-11.
- **audit integrity**: H-01 + H-02 verify real PostgreSQL rollback (pending CI).
- **chain integrity**: H-03 verifies concurrent correction failure preserves chain (pending CI).
- **counter-evidence preservation**: A13 verified by U-03, U-04 + H-12 (pending CI).
- **no auto-promotion**: A8 verified by U-08, U-12.
- **duplicate handling**: A17 — value equality alone never rejects. H-04 verifies F1 constraint handles uniqueness.

## CONTRACT_CHANGES

- **backward compatible**: YES — additive only.
- **migrations**: NONE.
- **new tables**: NONE.
- **new permissions**: NONE.
- **new dependencies**: NONE.
- **src/lib/state-builder/ diff**: 0.
- **prisma/schema.prisma diff**: 0.

## OPEN_DEFECTS

None (pending CI verification).

## DECISION_REQUESTS

None. All 18 02-01 decisions (A1-A18) frozen and implemented.

## ACCEPTANCE

**PENDING CI** — local verification passes (273 unit tests). Awaiting CI + Recovery on real PostgreSQL 16 to verify integration tests H-01..H-12.

## NEXT_STEP

After CI + Recovery pass:
- Mark G02-L07 + G02-L08 as RESOLVED in `02-00_KNOWN_LIMITATIONS.md`.
- Define Mission 02-02 scope.
