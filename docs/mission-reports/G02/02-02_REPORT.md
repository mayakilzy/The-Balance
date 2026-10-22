# Mission 02-02 Report — Evidence Independence & Observatory Views

```text
MISSION_ID = 02-02
TARGET_GROUP = GROUP 02 (State Observatory)
BASE_COMMIT = 7c29b8314d3d0a9e033acefcb951f4f6af6d46f2
FINAL_COMMIT = 1a983bd (on main — CI + Recovery PASS)
WORKTREE = clean (mission-02-02 branch merged to main)
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

### CI runtime (CI #146 on 1a983bd — real PostgreSQL 16)

```
✓ lint: PASS
✓ typecheck: PASS
✓ test: 755 passed | 10 skipped | 0 failed
✓ Playwright: 5 passed | 2 flaky (passed on retry) | 0 failed
```

### CI + Recovery URLs (verified)

- **CI #146**: https://github.com/mayakilzy/The-Balance/actions/runs/39084276696 — SUCCESS
- **Recovery #84**: https://github.com/mayakilzy/The-Balance/actions/runs/39084276698 — SUCCESS

## LIVE_EVIDENCE

### real (verified on CI with real PostgreSQL 16)
- ✅ Aggregate independence: subnational spread never produces FULL (B4 — H-01).
- ✅ Aggregate FULL reachable via national obs + 2 independent verified evidence (direct + related via `relatedEvidenceId`) — H-02/H-03.
- ✅ Aggregate PARTIAL + limitationReason when only 1 independent verified evidence — H-04.
- ✅ Coverage vs independence separation — H-05.
- ✅ Snapshot 4-layer structure — H-06.
- ✅ Refuted evidence preserved in snapshot — H-07.
- ✅ Disputed evidence preserved in snapshot — H-08.
- ✅ Cross-tenant snapshot denied — H-09.
- ✅ Country-scope UNKNOWN warning surfaced in provenanceWarnings — H-10.
- ✅ Source mismatch warning explanatory (B15) — H-11.
- ✅ Snapshot honesty block (simulatedData + noCausalClaims + limitations) — H-12.

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

**PASS**

### Verified on CI (real PostgreSQL 16) — 2026-10-18
1. ✅ CI #146 — SUCCESS (https://github.com/mayakilzy/The-Balance/actions/runs/39084276696)
2. ✅ Recovery #84 — SUCCESS (https://github.com/mayakilzy/The-Balance/actions/runs/39084276698)
3. ✅ Vitest: 755 passed | 10 skipped | 0 failed
4. ✅ Playwright: 5 passed | 2 flaky (passed on retry) | 0 failed
5. ✅ `src/lib/state-builder/` diff = 0
6. ✅ `prisma/schema.prisma` diff = 0 (no new models)
7. ✅ `package.json` diff = 0 (no new dependencies)
8. ✅ All 16 02-02 decisions (B1-B16) implemented
9. ✅ G02-L12 RESOLVED — FULL reachable via national obs + ≥2 independent verified evidence (direct + related)
10. ✅ G02-L13 RESOLVED — country-scope UNKNOWN warning surfaced in provenanceWarnings
11. ✅ G02-L14 DOCUMENTED — source mismatch warning explanatory (B15)
12. ✅ B4 enforced — subnational geographic spread NEVER produces FULL (H-01 verified)
13. ✅ B7 enforced — limitationReason explains when FULL is unreachable (H-04 verified)
14. ✅ B13 enforced — no causal claims; attributionLevel="descriptive" everywhere

## NEXT_STEP

Mission 02-02 is APPROVED. Define Mission 02-03 scope based on Roadmap §5 (remaining GROUP 02 components: Ministry/Service Views, Temporal & Attribution Labels, Early Warnings calibration, Public/Research/Gov permissioned views).
