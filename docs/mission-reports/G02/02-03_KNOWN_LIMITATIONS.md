# GROUP 02 — Mission 02-03 Known Limitations
**Mission:** 02-03 — Temporal Integrity & Early Warnings
**Date:** 2026-10-18

## New Limitations Introduced by 02-03

### G02-L18: Temporal Trend Requires ≥2 Usable Data Points
- `analyzeTemporalTrend` returns `unknown` when fewer than 2 usable (non-null, isCurrent=true) observations exist in the lookback range.

### G02-L19: Early Warning is Always Uncalibrated
- `assessEarlyWarning` returns `isCalibrated=false` in 02-03. No indicator-specific calibrated risk policy exists. The warning levels (`none`/`watch`/`advisory`/`insufficient_data`) are descriptive signals, NOT calibrated risk assessments.

### G02-L20: No Future Prediction
- 02-03 analyzes past data only. No forecasting or prediction is attempted. The temporal trend describes what happened, not what will happen.

### G02-L21: Test Cleanup Isolation Not Yet Applied to Legacy G02 Tests
- C18 (scoped test cleanup) was specified but not fully applied to all existing G02 test files in this mission. The new test files use scoped cleanup. Legacy files still use `deleteMany({})`. This is safe in CI (isolated DB per run) but should be hardened for parallel test execution.
