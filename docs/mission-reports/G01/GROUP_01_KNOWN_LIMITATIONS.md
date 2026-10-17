# GROUP 01 — Known Limitations

**Final SHA:** `4aa7de238f01a318c040c3775785788664ee7baf`

## 1. Simulated Intelligence (StubProvider)

All LLM-dependent services use StubProvider — a deterministic, non-AI provider.
- Strategy Composer: alternatives are derived from input data structure, not real strategic reasoning
- Development Advisor: recommendation text is derived from the comparison matrix, not from advanced AI reasoning
- All outputs labeled `simulated: true`
- **Impact:** The platform's "intelligence" is structural (deterministic algorithms) not cognitive (AI reasoning)
- **Mitigation:** When a real LLM provider is integrated, the same contracts apply — only the provider changes

## 2. Evidence Support Assessment (supportAssessment = "not-assessed")

The system distinguishes between:
- Evidence verification (the evidence's own verificationStatus)
- Evidence relevance to a claim (NOT assessed in v1)
- Actual claim support (NOT assessed in v1)

Citing verified evidence does NOT mean the claim is supported. The claim-to-evidence support relationship has not been assessed. This is an honest limitation — we don't have a model for verifying that evidence supports a specific strategic claim.

## 3. Counter-Evidence Provenance

Counter-evidence references are extracted from strategy version metadata (from the 01-03 composer). The system verifies that the cited Evidence rows exist in the tenant, but:
- Does not verify country scope of counter-evidence Evidence rows (deferred to future hardening)
- Unresolved references (non-existent Evidence rows) are moved to risks, not presented as counter-evidence
- The counter-evidence's verificationStatus does NOT prove it contradicts the specific strategic claim

## 4. Budget Estimates (No Real Market Data)

- All cost estimates are labeled `simulated: true`
- Variance multipliers (varianceLow/varianceHigh) are analyst-supplied, not derived from market data
- No external financial data integration (no FX rates, no market price indices)
- Cross-currency aggregation is refused (no silent conversion)
- ISO 4217 currency whitelist is a versioned internal support list, not an authoritative reference

## 5. Timeline / Scheduling

- No sub-year scheduling granularity (only integer years)
- No resource-leveling (programs in the same phase are assumed parallelizable)
- Execution duration is NOT computed by the comparison engine (requires buildRoadmap, not called to stay read-only)
- Temporal validation uses strict no-overlap rule (prereq.endYear < dependent.startYear) — no partial-dependency model

## 6. Development Advisor Abstention

The advisor abstains when:
- ANY alternative has an invalid timeline (temporal violations)
- ALL alternatives lack cost data (financial comparison impossible)

It does NOT abstain based on evidence gaps alone (the previous >50% threshold was removed as arbitrary). Evidence gaps are surfaced as risks + uncertainty.

## 7. Browser E2E Test Coverage

The Playwright E2E test (`t1-state-builder.spec.ts`) covers login, navigation, and screenshot capture. The full T1 journey (baseline → gap → compose → ... → approval) is tested at the API/integration level (`g01-t1-integration.integration.test.ts`), not via browser UI, because GROUP 01 does not include dedicated UI pages for each State Builder step. A browser-based UI for the full journey would be built in a future group.

**Browser E2E status: LOGIN + NAVIGATION = PASS**
**Browser E2E status: FULL T1 JOURNEY VIA UI = NOT IMPLEMENTED**

## 8. No Real Country Data

All testing uses "Demolandia" — a fictional country with seeded data. No real Syrian (or other country) data has been ingested. The platform is ready for real data but has not been validated against it.

## 9. Single-Tenant Testing

Most tests use Tenant A (DML-MOP-TENANT). Cross-tenant isolation is verified via explicit negative tests, but multi-tenant concurrent operation has not been stress-tested.

## 10. Counter-Evidence Country Scope Not Verified

The advisor verifies that counter-evidence Evidence rows exist in the tenant, but does not verify that they belong to the same country as the strategy. This is a known gap — the country scope check for counter-evidence Evidence rows should be added in GROUP 02 or a future hardening pass.

## 11. Audit Failure Injection Not Tested

The atomic audit contract (writeAuditTx inside the approval transaction) is verified structurally — a successful approval produces all three layers (version status + event + audit_log), and a re-approval fails atomically (no partial state). However, we have not injected a forced writeAuditTx failure to verify that the transaction rolls back. This would require mocking the Prisma client, which is not currently set up. The structural verification (writeAuditTx is called inside withAuthenticatedTenant, before the return) provides strong evidence of atomicity, but a forced-failure test would be more definitive.
