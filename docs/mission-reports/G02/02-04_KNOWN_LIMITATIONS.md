# GROUP 02 — Mission 02-04 Known Limitations
**Mission:** 02-04 — Ministry & Public Service Observatory Views
**Date:** 2026-10-18

## New Limitations

### G02-L22: Institutional Early Warning Not Computed
- Institutional early warning is always "not_computed" in 02-04.
- The existing `assessEarlyWarning` service (02-03) supports national scope only.
- National early warning is labeled with `geoScope: "national"` to prevent conflation.
- Future mission may add institutional-scope early warning.

### G02-L23: No Hierarchical Institution Aggregation
- Parent/child institution measurements are NOT auto-merged (D5).
- `includeDescendants` flag not implemented in 02-04.
- Each institution's view contains only its own direct measurements.

### G02-L24: Sector View Observability Not Computed
- `aggregateObservability.status = "not_computed"` in sector view (D7).
- Real observability requires per-indicator `analyzeAggregateIndependence`.
- Sector view returns counts only (programs, institutions, indicators).

### G02-L21: Test Cleanup Isolation (CARRIED FORWARD — STILL OPEN)
- Legacy unrestricted `deleteMany({})` cleanup remains in G02 integration tests.
- Affected suites may run only on isolated, disposable databases.
- Must be resolved before GROUP 02 final closure.
