# Mission 02-04 Report — Ministry & Public Service Observatory Views

```text
MISSION_ID = 02-04
TARGET_GROUP = GROUP 02 (State Observatory)
BASE_COMMIT = 4ed0dcecf5b51524cb679c1d70fed3fb0d40daab
FINAL_COMMIT = <set after CI passes>
```

## DELIVERED

### New modules (2)
- `institutional-view-service.ts` — `getInstitutionalView()`. Read-only institutional observatory view. CORRECTION 1: national and institutional observations are SEPARATE fields. Temporal context has explicit geoScope labels ("national" / "institutional"). National trend is NOT presented as institutional trend. Institutional early warning = "not_computed" (existing service supports national only). D3: program ownership ≠ outcome attribution. D4: "linkedNationalIndicatorsCount" (not "attributed"). D5: exact geoRefId match. D10: executionProgress = "not_tracked" always. D11: causalAttribution = "descriptive" always.
- `sector-view-service.ts` — `getSectorView()`. Read-only sector view. CORRECTION 3: aggregateObservability = "not_computed" (not fabricated). simulatedData = null when not inspected (not false). D8: indicators deduplicated by ID.

### Modified modules (1)
- `index.ts` — exports new modules.

### Tests
- `tests/unit/state-observatory/institutional-view-service.test.ts` — 7 unit tests (V-01..V-05, V-08, CORRECTION 1).
- `tests/unit/state-observatory/sector-view-service.test.ts` — 3 unit tests (V-06..V-07, CORRECTION 3).

### Documentation
- `docs/mission-reports/G02/02-04_REPORT.md` — this file.
- `docs/mission-reports/G02/02-04_KNOWN_LIMITATIONS.md` — new limitations.

## CORRECTION 1 VERIFICATION
- National and institutional observations are SEPARATE fields in `InstitutionalIndicatorView`
- `temporalContext.nationalTrend.geoScope = "national"` (explicit label)
- `temporalContext.institutionalTrend.geoScope = "institutional"` (explicit label, computed with `geoLevel="institutional"` + `geoRefId=institutionId`)
- `temporalContext.nationalEarlyWarning.geoScope = "national"` (labeled NATIONAL, not presented as institutional)
- `temporalContext.institutionalEarlyWarning.warningLevel = "not_computed"` (existing service supports national only)

## CORRECTION 2 VERIFICATION
- Institution → country → tenant validation (V-08)
- StrategyVersion → tenant validation
- ObservationPeriod → tenant validation
- Program → tenant + strategyVersion + owningInstitutionId
- IndicatorDefinition → tenant + programId
- Observation → exact geoLevel + geoRefId match (V-03)

## CORRECTION 3 VERIFICATION
- Sector view: `aggregateObservability.status = "not_computed"` with reason pointing to `analyzeAggregateIndependence` (V-07)
- `honesty.simulatedData = null` when not inspected (CORRECTION 3 test)
- Indicators deduplicated by ID across programs (V-06)

## CORRECTION 4 VERIFICATION
- V-01: institution-to-program ownership linkage
- V-02: "linked" not "attributed" terminology
- V-03: exact institutional geoRefId matching
- V-04: no unsupported causal attribution
- V-05: no fabricated execution verification from Program.status
- V-08: cross-country institution rejection
- CORRECTION 1: national/institutional temporal context separation
- V-06: sector deduplication
- V-07: not_computed observability

## TEST_COMMANDS
```
bun run lint && bun run typecheck && bun run test
```

### Local runtime
```
✓ lint: PASS (0 errors, 3 pre-existing G00 warnings)
✓ typecheck: PASS
✓ test: 312 passed | 482 skipped | 0 failed
```

## CONTRACT_CHANGES
- backward compatible: YES (additive only)
- migrations: NONE. tables: NONE. permissions: NONE. dependencies: NONE.
- src/lib/state-builder/ diff: 0. prisma/schema.prisma diff: 0.

## ACCEPTANCE
PENDING CI — local verification passes (312 tests).
