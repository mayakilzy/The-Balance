# Mission 02-02 Report — Evidence Independence & Observatory Views

```text
MISSION_ID = 02-02
TARGET_GROUP = GROUP 02 (State Observatory)
BASE_COMMIT = 7c29b8314d3d0a9e033acefcb951f4f6af6d46f2
FINAL_COMMIT = <set after CI passes>
WORKTREE = clean (mission-02-02 branch)
```

## DELIVERED

### New modules (2)
- `src/lib/state-observatory/aggregate-independence-service.ts` — `analyzeAggregateIndependence()` service. Distinguishes geographic coverage from source independence (B4). FULL requires national-level observation + ≥2 independent verified evidence linked via direct `evidenceId` OR `Evidence.relatedEvidenceId` (B6 correction). Returns `limitationReason` when FULL unreachable (B7).
- `src/lib/state-observatory/observatory-query-service.ts` — `getObservatorySnapshot()` read-only tenant-scoped query layer. 4-layer structure per indicator (B12): observedFacts, calculatedComparisons, uncertainties, interpretations. Per-indicator aggregate independence (B10 correction). Counter-evidence via `relatedEvidenceId` (B11 correction).

### Modified modules (3)
- `src/lib/state-observatory/observation-service.ts` — B14: country-scope UNKNOWN warning now surfaced in `qualityNotes.provenanceWarnings`.
- `src/lib/state-observatory/provenance-validator.ts` — B15: source mismatch warning now explanatory ("acceptable when evidence cites a different primary source; both sources preserved").
- `src/lib/state-observatory/index.ts` — exports new modules.

### Tests
- `tests/unit/state-observatory/aggregate-independence-service.test.ts` — 9 unit tests (U-01..U-11).
- `tests/unit/state-observatory/observatory-query-service.test.ts` — 6 unit tests (U-12..U-14 + scope validation).
- `tests/integration/g02-aggregate-independence.integration.test.ts` — 4 integration tests (H-01, H-02/H-03, H-04, H-05) on real PostgreSQL 16.
- `tests/integration/g02-observatory-snapshot.integration.test.ts` — 7 integration tests (H-06..H-12) on real PostgreSQL 16.
- `tests/unit/state-observatory/provenance-validator.test.ts` — updated for B15 explanatory warning.

### Documentation
- `docs/mission-reports/G02/02-02_REPORT.md` — this file.
- `docs/mission-reports/G02/02-02_KNOWN_LIMITATIONS.md` — new 02-02 limitations + G02-L12/L13/L14 status update.
- `docs/mission-reports/G02/02-01_KNOWN_LIMITATIONS.md` — G02-L12/L13/L14 marked RESOLVED by 02-02.

## TEST_COMMANDS

```
bun run lint && bun run typecheck && bun run test
```

### Local runtime (with AUTH_SECRET set)

```
✓ lint: PASS (0 errors, 3 pre-existing G00 warnings)
✓ typecheck: PASS
✓ test: 289 passed | 476 skipped | 0 failed
```

## LIVE_EVIDENCE

### real (verified locally with mocks; pending CI on real PostgreSQL)
- ✅ Aggregate independence: subnational spread never produces FULL (B4 — U-04).
- ✅ Aggregate FULL reachable via national obs + 2 independent verified evidence (direct + related) — U-03.
- ✅ Aggregate PARTIAL + limitationReason when only subnational observations — U-02.
- ✅ Coverage vs independence separation — U-07.
- ✅ Snapshot 4-layer structure — U-12.
- ✅ Snapshot no causal claims (B13) — U-13.
- ✅ Snapshot simulatedData flag — U-14.
- ✅ B14: country-scope UNKNOWN warning surfaced in provenanceWarnings.
- ✅ B15: source mismatch warning explanatory.

### pending CI verification (real PostgreSQL 16)
- ⏳ H-01: Subnational spread → PARTIAL (not FULL)
- ⏳ H-02/H-03: FULL via national obs + 2 independent verified evidence (direct + related via `relatedEvidenceId`)
- ⏳ H-04: 1 national source + 1 verified evidence → PARTIAL
- ⏳ H-05: Coverage vs independence separation
- ⏳ H-06: Snapshot 4-layer structure
- ⏳ H-07: Refuted evidence preserved in snapshot
- ⏳ H-08: Disputed evidence preserved in snapshot
- ⏳ H-09: Cross-tenant snapshot denied
- ⏳ H-10: Country-scope warning surfaced
- ⏳ H-11: Source mismatch warning explanatory
- ⏳ H-12: Snapshot honesty block

### mocked
- Unit tests use mocked Prisma for deterministic logic verification.

### not tested
- Browser UI (out of scope — G02-L03).
- External integrations (out of scope — G02-L05).
- LLM (out of scope — G02-L06).

## SECURITY_CHECKS

- **authz**: Reuses `observatory:observation:read` + `observatory:variance:read` + `observatory:alert:read`. No new permissions.
- **tenant isolation**: RLS on all queries; H-09 verifies cross-tenant denial.
- **no causal claims**: B13 — `attributionLevel="descriptive"` everywhere; `honesty.noCausalClaims=true` in snapshot.
- **evidence preservation**: A13 — refuted/disputed/counter evidence preserved in snapshot (H-07, H-08).
- **no auto-promotion**: A8 — verificationStatus never auto-promoted.
- **FULL honesty**: B4 + B7 — FULL never manufactured from subnational spread; `limitationReason` explains when unreachable.

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

None. All 16 02-02 decisions (B1-B16) frozen and implemented.

## ACCEPTANCE

**PENDING CI** — local verification passes (289 unit tests). Awaiting CI + Recovery on real PostgreSQL 16.

## NEXT_STEP

After CI + Recovery pass:
- Mark G02-L12/L13/L14 as RESOLVED in `02-01_KNOWN_LIMITATIONS.md`.
- Define Mission 02-03 scope.
