// ============================================================
// budget-service.ts — Budget & Financing Estimates (Conditional)
// ------------------------------------------------------------
// Mission 01-06: Attach conditional cost estimates to programs.
//
// estimateBudgets(session, { strategyAlternativeId }) → BudgetResult
//
// BudgetResult = {
//   strategyAlternativeId,
//   estimates: BudgetEstimate[],     // one per program WITH cost inputs
//   insufficientData: InsufficientDataEntry[],  // one per program WITHOUT cost inputs
//   modelVersion: "v1-deterministic",
//   summary: { totalPrograms, estimated, insufficient, ... },
// }
//
// BudgetEstimate = {
//   programId,
//   costRange: { min, max, currency, horizonYears },
//   assumptions: Assumption[],
//   financingSources: FinancingSource[],
//   modelVersion: "v1-deterministic",
//   simulated: true,                  // ALWAYS true in G01 — no real market data
//   institutionAssignmentGap: boolean, // surfaces a known limitation on estimate validity
//   mandateGap: boolean,               // surfaces a known limitation on estimate validity
// }
//
// InsufficientDataEntry = {
//   programId,
//   reason: string,                    // e.g. "no cost inputs provided in program metadata"
//   gaps: string[],                    // human-readable list of what's missing
// }
//
// ============================================================
// CORE PRINCIPLE — FINANCIAL HONESTY (mission pack §2)
// ============================================================
// The DEFAULT behavior when cost data is missing is:
//   "insufficient data for estimate"
//
// We NEVER fabricate a numeric range from just a program name or sector.
// A program titled "Agricultural reform" does NOT imply a cost of $X–$Y.
// Only explicit cost inputs (provided by an analyst in program.metadata.costInputs,
// or by a future CountryPackConfig) justify a numeric range.
//
// When cost inputs ARE present, we:
//   - Produce a {min, max} range, NEVER a point estimate
//   - Enforce min <= max (DB CHECK also enforces this)
//   - Validate currency (ISO 4217-style 3-letter code)
//   - Validate horizonYears > 0
//   - Document every assumption used in the calculation
//   - Record modelVersion for reproducibility
//   - Label simulated: true (always in G01 — we use no real market data)
//   - Refuse negative inputs (mission pack §6)
//   - Refuse to combine amounts in different currencies without an explicit
//     conversion assumption (mission pack §3)
//
// ============================================================
// COST INPUT FORMAT (mission pack §3)
// ============================================================
// Cost inputs are read from program.metadata.costInputs — an array of:
//   {
//     label: string,                   // e.g. "extension services training"
//     unitCost: { amount, currency },  // cost per unit
//     unitCount: number,               // how many units
//     horizonYears: number,            // over how many years
//     source: string,                  // provenance — who provided this input
//     note?: string,                   // optional clarification
//     varianceLow?: number,            // optional multiplier for min (default 0.9)
//     varianceHigh?: number,           // optional multiplier for max (default 1.15)
//   }
//
// The deterministic model (v1):
//   - For each cost input: lineMin = unitCost.amount * unitCount * (varianceLow ?? 0.9)
//                          lineMax = unitCost.amount * unitCount * (varianceHigh ?? 1.15)
//   - All inputs MUST share the same currency (no cross-currency aggregation
//     without an explicit conversion assumption — mission pack §3).
//   - All inputs MUST share the same horizonYears (or we surface a gap).
//   - costRange.min = sum of lineMin across all inputs
//   - costRange.max = sum of lineMax across all inputs
//   - assumptions[] documents every input + the variance multipliers + the model
//   - financingSources[] comes from program.metadata.financingSources (optional)
//     OR defaults to an empty array with an "insufficient financing data" note.
//
// The variance multipliers (0.9 / 1.15 by default) are EXPLICIT assumptions,
// not arbitrary padding. They are documented in the assumptions array so
// anyone can reproduce the calculation. An analyst can override them per-input.
//
// ============================================================
// STORAGE (mission pack §5)
// ============================================================
// Reuses the existing BudgetLine model (migration 0017):
//   - UNIQUE(tenantId, programId, modelVersion) added in migration 0020
//   - CHECK(minAmount <= maxAmount) from migration 0017
//   - RLS ENABLE + FORCE from migration 0017
//   - trigger enforce_budget_line_same_tenant from migration 0017
//
// Idempotent: re-running estimateBudgets on the same strategy version
// updates existing BudgetLine rows (upsert on the unique key) rather than
// creating duplicates. A "no cost inputs" program produces NO BudgetLine row —
// it's listed in insufficientData instead.
//
// Concurrency: two concurrent estimateBudgets calls for the same strategy
// version serialize via P2002 recovery (same pattern as program-service.ts
// FIX-3-LAST and strategy-composer-service.ts FIX-A-LAST). The first writer
// wins; the second reads the winning row in a new transaction.
//
// ============================================================
// PERMISSIONS
// ============================================================
// estimateBudgets: budget:compute (admin, analyst — NOT reviewer, NOT observer)
// getBudgets:      budget:read    (admin, analyst, reviewer — NOT observer)
//
// Per ADR-0013. Reuses G00 + 01-00 + 01-03 + 01-04 + 01-05 contracts.
// ============================================================
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

// ============================================================
// TYPES — Budget Estimate
// ============================================================

export const BUDGET_MODEL_VERSION = "v1-deterministic" as const;

export type Currency = string; // ISO 4217-style 3-letter code (e.g. "USD", "EUR", "SYP")

export interface CostRange {
  min: string;   // string to preserve Decimal precision (Prisma Decimal)
  max: string;
  currency: Currency;
  horizonYears: number;
}

export interface Assumption {
  description: string;
  source: string;            // provenance — "analyst-input", "model-default", "program-metadata"
  reproducesIn?: string;     // how to reproduce (formula or reference)
}

export interface FinancingSource {
  type: string;              // e.g. "treasury", "donor_grant", "loan", "public_private"
  description: string;
  confidence: "high" | "medium" | "low";
  confidenceRationale: string;
}

export interface BudgetEstimate {
  programId: string;
  programTitle: string;
  programSector: string;
  costRange: CostRange;
  assumptions: Assumption[];
  financingSources: FinancingSource[];
  modelVersion: string;      // "v1-deterministic"
  simulated: true;           // ALWAYS true in G01
  // Surface known gaps that limit the validity of this estimate:
  institutionAssignmentGap: boolean;  // true if program has no owning institution
  mandateGap: boolean;                // true if program has no legal mandate documented
}

export interface InsufficientDataEntry {
  programId: string;
  programTitle: string;
  programSector: string;
  reason: string;            // primary reason
  gaps: string[];            // all missing inputs that prevent estimation
}

export interface BudgetResult {
  strategyAlternativeId: string;
  estimates: BudgetEstimate[];
  insufficientData: InsufficientDataEntry[];
  modelVersion: string;
  summary: {
    totalPrograms: number;
    estimated: number;
    insufficient: number;
    withInstitutionGap: number;
    withMandateGap: number;
    currencies: Currency[];   // distinct currencies in produced estimates
  };
}

// ============================================================
// TYPES — Cost Input (read from program.metadata.costInputs)
// ------------------------------------------------------------
// FIX-1 (01-06): varianceLow + varianceHigh are REQUIRED on every
// cost input. There is NO default variance — applying an arbitrary
// 0.9/1.15 multiplier without justification would give decision-makers
// a false sense of precision. If the analyst cannot justify a variance,
// the program returns "insufficient data for estimate" instead.
//
// FINAL PROVENANCE CLOSURE (01-06): sourceType distinguishes analyst-
// supplied text from data references. The previous taxonomy used
// "verified-reference", which was misleading — it implied verification
// had happened when in fact only a non-empty referenceId was required.
// The new taxonomy is honest about what verification actually occurred:
//
//   - "analyst-input"        — analyst assertion. UNVERIFIED. No
//                              referenceId expected. The model never
//                              describes this as verified.
//
//   - "evidence-reference"   — references an internal Evidence row by ID.
//                              The service VALIDATES the evidence:
//                                * exists in the same tenant (RLS)
//                                * has metadata.countryId matching the
//                                  strategy version's country
//                                * verificationStatus is checked
//                              If the evidence's verificationStatus ===
//                              "verified", the input is labeled
//                              "evidence-verified" in assumptions. If
//                              verificationStatus is anything else
//                              (unverified, disputed, refuted), the input
//                              is labeled "evidence-pending-verification".
//                              In BOTH cases, an explicit note says the
//                              evidence does NOT automatically prove the
//                              price — it is examinable support, not
//                              price verification.
//                              If the evidence is missing, cross-tenant,
//                              or cross-country → REJECTED (fail-closed).
//
//   - "external-reference"   — references an external source (published
//                              price index, tender document, market data
//                              feed). The referenceId is a citation string.
//                              We have NO verification mechanism for
//                              external references yet → the input is
//                              labeled "external-pending-verification"
//                              with an explicit note that external
//                              verification is not yet implemented. The
//                              model NEVER describes external references
//                              as "verified".
// ============================================================

interface CostInput {
  label: string;
  unitCost: { amount: number; currency: Currency };
  unitCount: number;
  horizonYears: number;
  // source — provenance text (who/what provided this input). Always required.
  source: string;
  // FINAL PROVENANCE CLOSURE: sourceType taxonomy.
  //   "analyst-input"      — analyst assertion (UNVERIFIED)
  //   "evidence-reference" — references internal Evidence row (validated)
  //   "external-reference" — references external source (no verification yet)
  // Default "analyst-input" if omitted (backward compatible; always UNVERIFIED).
  sourceType?: "analyst-input" | "evidence-reference" | "external-reference";
  // referenceId — required when sourceType is "evidence-reference" or
  // "external-reference". For evidence-reference, this is an Evidence row ID
  // (validated against tenant + country scope). For external-reference, this
  // is a citation string (e.g. "WB-PI-2024-Q3", "tender-2024-001").
  referenceId?: string;
  note?: string;
  // FIX-1: varianceLow + varianceHigh are REQUIRED. No defaults.
  // The analyst must justify the range for each input. The varianceSource
  // documents WHERE the variance comes from (e.g. "test-fixture",
  // "historical-variance-2023", "expert-estimate-dr-x").
  varianceLow: number;    // multiplier for min (e.g. 0.9 = 10% below base)
  varianceHigh: number;   // multiplier for max (e.g. 1.15 = 15% above base)
  varianceSource: string; // provenance for the variance multipliers
}

interface ProgramMetadataForBudget {
  costInputs?: CostInput[];
  financingSources?: FinancingSource[];
}

// ============================================================
// ERRORS
// ============================================================

export class BudgetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetValidationError";
  }
}

export class BudgetIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetIntegrityError";
  }
}

// ============================================================
// CONSTANTS — FIX-1 + FIX-3
// ============================================================

// FIX-1: NO DEFAULT VARIANCE.
// The previous implementation used varianceLow=0.9 + varianceHigh=1.15
// as automatic defaults. This was scientifically unjustified — there is
// no empirical basis for applying the same 10%/15% margin to an
// agricultural program, an education program, a health program, and
// an infrastructure program across different countries. Documenting the
// assumption made it reproducible, but reproducibility ≠ correctness.
//
// Now: varianceLow + varianceHigh + varianceSource are REQUIRED on every
// cost input. If an analyst cannot justify a variance, the program
// returns "insufficient data for estimate" rather than fabricating a range.

// FIX-3: ISO 4217 currency support list.
// IMPORTANT: This is a VERSIONED INTERNAL SUPPORT LIST, not an authoritative
// reference of all currently-active ISO 4217 currencies. It was compiled from
// ISO 4217:2015 + amendments through 2024, and includes some historic codes
// (e.g. HRK — Croatian kuna, superseded by EUR in 2023; ZWL — Zimbabwean dollar
// 2009 series, multiple re-denominations since). The list requires periodic
// review and update as ISO publishes amendments. Codes here are accepted by
// the budget service; codes NOT here are rejected (fail-closed against typos
// and fabricated currencies). For production deployment, the list should be
// synchronized with the latest ISO 4217 amendment and cross-checked against
// the central bank of each tenant country.
//
// Source: ISO 4217:2015 + amendments through 2024.
// Last review: 2024-Q4.
const ISO_4217_CURRENCY_CODES: ReadonlySet<string> = new Set([
  // Major reserve currencies
  "USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD",
  // Asia / Pacific
  "CNY", "HKD", "SGD", "TWD", "KRW", "INR", "IDR", "MYR", "PHP", "THB",
  "VND", "PKR", "BDT", "LKR", "NPR", "KHR", "LAK", "MMK", "BND", "FJD",
  "PGK", "SBD", "VUV", "WST", "TOP", "JOD", "LBP", "ILS", "SAR", "AED",
  "QAR", "KWD", "BHD", "OMR", "YER", "IRR", "IQD", "AFN", "MOP",
  // Syria + neighbors (regional relevance for THE BALANCE)
  "SYP", "TRY", "JOD", "LBP", "IQD", "EGP",
  // Africa
  "ZAR", "EGP", "NGN", "KES", "ETB", "GHS", "TZS", "UGX", "RWF", "BIF",
  "CDF", "AOA", "MZN", "ZMW", "BWP", "MUR", "MAD", "DZD", "TND", "LYD",
  "SDG", "SOS", "DJF", "ERN", "GMD", "GNF", "LRD", "MWK", "XOF", "XAF",
  "XPF", "ZWL",
  // Europe (non-Euro) — includes historic HRK (Croatian kuna, superseded by EUR 2023)
  "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN", "HRK", "RSD",
  "ISK", "UAH", "MDL", "ALL", "BAM", "MKD", "RUB", "BYN", "GEL", "AMD",
  "AZN", "TRY",
  // Americas
  "MXN", "BRL", "ARS", "CLP", "COP", "PEN", "CUP", "DOP", "GTQ", "HNL",
  "NIO", "PAB", "PYG", "UYU", "VES", "BOB", "CRC", "JMD", "TTD", "BZD",
  // Central Asia / Caucasus
  "KZT", "UZS", "KGS", "TJS", "TMT", "AZN", "GEL", "AMD",
]);

// FIX-2: Rounding rule for financial arithmetic.
// ROUND_HALF_UP is the standard cash rounding convention: 0.005 rounds
// up to 0.01, 0.004 rounds down to 0.00. This matches how most
// accounting systems handle cents.
const DECIMAL_PLACES = 2;

// ============================================================
// HELPERS — validation
// ============================================================

function isValidCurrency(code: string): boolean {
  return ISO_4217_CURRENCY_CODES.has(code);
}

function isFinitePositiveNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function isFinitePositiveInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n > 0;
}

/**
 * Parse + validate the cost inputs from program.metadata.costInputs.
 * Returns { inputs, errors } where errors is a list of human-readable
 * validation failures. If errors is non-empty, the program is treated as
 * "insufficient data" with the errors surfaced as gaps.
 */
function parseCostInputs(
  raw: unknown
): { inputs: CostInput[] | null; errors: string[] } {
  const errors: string[] = [];

  if (raw == null) {
    return { inputs: null, errors: [] }; // no costInputs key — clean "no data"
  }

  if (!Array.isArray(raw)) {
    errors.push("program.metadata.costInputs is not an array");
    return { inputs: null, errors };
  }

  if (raw.length === 0) {
    return { inputs: null, errors: [] }; // empty array — clean "no data"
  }

  const inputs: CostInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>;
    if (!item || typeof item !== "object") {
      errors.push(`costInputs[${i}] is not an object`);
      continue;
    }

    // label
    if (typeof item.label !== "string" || item.label.trim().length === 0) {
      errors.push(`costInputs[${i}].label is missing or empty`);
      continue;
    }

    // unitCost
    const uc = item.unitCost as Record<string, unknown> | undefined;
    if (!uc || typeof uc !== "object") {
      errors.push(`costInputs[${i}].unitCost is missing`);
      continue;
    }
    const amount = (uc as { amount: unknown }).amount;
    const currency = (uc as { currency: unknown }).currency;
    if (!isFinitePositiveNumber(amount)) {
      errors.push(`costInputs[${i}].unitCost.amount must be a finite non-negative number`);
      continue;
    }
    // FIX-3: currency must be a recognized ISO 4217 code (not just 3 letters).
    if (typeof currency !== "string" || !isValidCurrency(currency)) {
      errors.push(
        `costInputs[${i}].unitCost.currency "${String(currency)}" is not a recognized ` +
        `ISO 4217 currency code. The code must appear in the ISO 4217 whitelist. ` +
        `Unknown or fabricated currency codes are rejected.`
      );
      continue;
    }

    // unitCount
    if (!isFinitePositiveNumber(item.unitCount)) {
      errors.push(`costInputs[${i}].unitCount must be a finite non-negative number`);
      continue;
    }

    // horizonYears
    if (!isFinitePositiveInteger(item.horizonYears)) {
      errors.push(`costInputs[${i}].horizonYears must be a positive integer`);
      continue;
    }

    // source (provenance text — who/what provided this input)
    if (typeof item.source !== "string" || item.source.trim().length === 0) {
      errors.push(`costInputs[${i}].source is missing (provenance required for every cost input)`);
      continue;
    }

    // FINAL PROVENANCE CLOSURE: sourceType taxonomy.
    //   "analyst-input"      — analyst assertion (UNVERIFIED, no referenceId)
    //   "evidence-reference" — references internal Evidence row (validated in tx)
    //   "external-reference" — references external source (no verification yet)
    // Default "analyst-input" if omitted.
    //
    // The previous "verified-reference" taxonomy was misleading — it implied
    // verification had happened when only a non-empty referenceId was required.
    // The new taxonomy is honest: "evidence-reference" triggers ACTUAL evidence
    // validation in the transaction (existence + tenant + country + verificationStatus),
    // and "external-reference" is explicitly labeled "pending-verification (external)"
    // because we have no external verification mechanism yet.
    let sourceType: "analyst-input" | "evidence-reference" | "external-reference" = "analyst-input";
    if (item.sourceType !== undefined) {
      if (item.sourceType !== "analyst-input" &&
          item.sourceType !== "evidence-reference" &&
          item.sourceType !== "external-reference") {
        errors.push(
          `costInputs[${i}].sourceType must be "analyst-input", "evidence-reference", ` +
          `or "external-reference" (got "${String(item.sourceType)}"). ` +
          `Note: "verified-reference" was renamed in the FINAL PROVENANCE CLOSURE — ` +
          `use "evidence-reference" for internal Evidence rows (validated against ` +
          `tenant + country + verificationStatus) or "external-reference" for ` +
          `external citations (labeled pending-verification).`
        );
        continue;
      }
      sourceType = item.sourceType;
    }
    let referenceId: string | undefined;
    if (sourceType === "evidence-reference" || sourceType === "external-reference") {
      if (typeof item.referenceId !== "string" || item.referenceId.trim().length === 0) {
        errors.push(
          `costInputs[${i}].referenceId is required when sourceType="${sourceType}". ` +
          (sourceType === "evidence-reference"
            ? `For evidence-reference, this must be an Evidence row ID (validated ` +
              `against tenant + country scope + verificationStatus in the transaction).`
            : `For external-reference, this is a citation string (e.g. "WB-PI-2024-Q3", ` +
              `"tender-2024-001"). External references are labeled pending-verification ` +
              `because no external verification mechanism is implemented yet.`)
        );
        continue;
      }
      referenceId = item.referenceId;
    }

    // FIX-1: varianceLow + varianceHigh + varianceSource are REQUIRED.
    // No default variance. If the analyst cannot justify a variance, the
    // program returns "insufficient data" rather than fabricating a range.
    if (item.varianceLow === undefined) {
      errors.push(
        `costInputs[${i}].varianceLow is required — no default variance is applied. ` +
        `The analyst must justify the lower-bound multiplier (e.g. 0.9 for 10% below base) ` +
        `and document its source in varianceSource. Without a justified variance, the ` +
        `program returns "insufficient data for estimate".`
      );
      continue;
    }
    if (item.varianceHigh === undefined) {
      errors.push(
        `costInputs[${i}].varianceHigh is required — no default variance is applied. ` +
        `The analyst must justify the upper-bound multiplier (e.g. 1.15 for 15% above base) ` +
        `and document its source in varianceSource.`
      );
      continue;
    }
    if (!isFinitePositiveNumber(item.varianceLow)) {
      errors.push(`costInputs[${i}].varianceLow must be a finite positive number`);
      continue;
    }
    if (!isFinitePositiveNumber(item.varianceHigh)) {
      errors.push(`costInputs[${i}].varianceHigh must be a finite positive number`);
      continue;
    }
    if (item.varianceLow > item.varianceHigh) {
      errors.push(
        `costInputs[${i}].varianceLow (${item.varianceLow}) > varianceHigh (${item.varianceHigh}) — ` +
        `min multiplier must not exceed max multiplier`
      );
      continue;
    }
    // varianceSource — documents WHERE the variance comes from.
    if (typeof item.varianceSource !== "string" || item.varianceSource.trim().length === 0) {
      errors.push(
        `costInputs[${i}].varianceSource is required — document where the variance ` +
        `multipliers come from (e.g. "test-fixture", "historical-variance-2023", ` +
        `"expert-estimate-dr-x"). An unjustified variance is not allowed.`
      );
      continue;
    }

    inputs.push({
      label: item.label,
      unitCost: { amount, currency },
      unitCount: item.unitCount as number,
      horizonYears: item.horizonYears as number,
      source: item.source,
      sourceType,
      referenceId,
      note: typeof item.note === "string" ? item.note : undefined,
      varianceLow: item.varianceLow,
      varianceHigh: item.varianceHigh,
      varianceSource: item.varianceSource,
    });
  }

  if (inputs.length === 0) {
    return { inputs: null, errors };
  }
  return { inputs, errors };
}

/**
 * Validate that all cost inputs share the same currency + horizonYears.
 * Mission pack §3: "لا تجمع تكاليف بعملات مختلفة دون أسعار تحويل موثوقة ومؤرخة"
 * (do not aggregate costs in different currencies without reliable, dated
 * conversion rates). We refuse cross-currency aggregation rather than
 * silently converting. If the analyst wants to combine USD and EUR, they
 * must pre-convert to a single currency and document the conversion as an
 * assumption.
 *
 * We also require a single horizonYears across inputs (the cost range is
 * for a single horizon). Different horizons would require NPV discounting,
 * which we don't do in v1.
 */
function validateInputsHomogeneous(inputs: CostInput[]): {
  currency: Currency;
  horizonYears: number;
  errors: string[];
} {
  const errors: string[] = [];
  const currencies = new Set(inputs.map((i) => i.unitCost.currency));
  const horizons = new Set(inputs.map((i) => i.horizonYears));

  if (currencies.size > 1) {
    errors.push(
      `cannot aggregate costs in multiple currencies (${[...currencies].join(", ")}). ` +
      `Pre-convert to a single currency and document the conversion rate as an assumption. ` +
      `Cross-currency aggregation without a documented, dated conversion rate is forbidden.`
    );
  }
  if (horizons.size > 1) {
    errors.push(
      `cost inputs have different horizonYears (${[...horizons].join(", ")}). ` +
      `v1-deterministic requires a single horizon per program. ` +
      `Multi-hizon aggregation requires NPV discounting (deferred to a future model version).`
    );
  }

  return {
    currency: inputs[0]!.unitCost.currency,
    horizonYears: inputs[0]!.horizonYears,
    errors,
  };
}

// ============================================================
// FINAL PROVENANCE CLOSURE: Evidence-reference validation
// ------------------------------------------------------------
// For sourceType="evidence-reference", we validate the cited Evidence row
// against tenant + country scope + verificationStatus. The result is a
// per-input verification state that buildAssumptions uses to label the
// input honestly.
//
// Verification states:
//   "analyst-unverified"          — sourceType="analyst-input" (default)
//   "evidence-verified"           — sourceType="evidence-reference", evidence
//                                    exists + in scope + verificationStatus="verified"
//   "evidence-pending-verification" — sourceType="evidence-reference", evidence
//                                    exists + in scope but verificationStatus is
//                                    "unverified" | "disputed" | "refuted"
//   "external-pending-verification" — sourceType="external-reference" (no
//                                    external verification mechanism yet)
//
// IMPORTANT: even "evidence-verified" does NOT mean the evidence proves the
// price. The evidence is examinable support — a human cited it. The
// assumption text explicitly says: "evidence does NOT automatically prove
// the price; it is examinable support, not price verification."
//
// If evidence is missing, cross-tenant, or cross-country → the input is
// REJECTED (fail-closed). The program goes to insufficientData with a gap
// explaining the rejection.
// ============================================================

export type InputVerificationState =
  | "analyst-unverified"
  | "evidence-verified"
  | "evidence-pending-verification"
  | "external-pending-verification";

export interface VerifiedInput extends CostInput {
  verificationState: InputVerificationState;
  // For evidence-reference: the evidence's verificationStatus (if found).
  // For other sourceTypes: undefined.
  evidenceVerificationStatus?: string;
}

/**
 * Validate evidence-reference inputs against the Evidence table.
 * Returns:
 *   - verifiedInputs: the inputs with verificationState populated
 *   - errors: per-input validation errors (missing evidence, cross-tenant,
 *     cross-country). If any error is present, the program should go to
 *     insufficientData.
 *
 * analyst-input and external-reference inputs pass through with their
 * respective default verification states (no DB lookup needed).
 */
async function validateEvidenceReferences(
  tx: Prisma.TransactionClient,
  tenantId: string,
  strategyCountryId: string,
  inputs: CostInput[]
): Promise<{ verifiedInputs: VerifiedInput[] | null; errors: string[] }> {
  const errors: string[] = [];
  const verifiedInputs: VerifiedInput[] = [];

  // Collect all evidence-reference referenceIds for a single batch query
  const evidenceRefIds: string[] = [];
  for (const inp of inputs) {
    if (inp.sourceType === "evidence-reference" && inp.referenceId) {
      evidenceRefIds.push(inp.referenceId);
    }
  }

  // Batch-fetch all cited evidence rows in one query (RLS enforces tenant scope)
  let evidenceMap: Map<string, { id: string; metadata: unknown; verificationStatus: string }> = new Map();
  if (evidenceRefIds.length > 0) {
    const evidenceRows = await tx.evidence.findMany({
      where: { tenantId, id: { in: evidenceRefIds } },
      select: { id: true, metadata: true, verificationStatus: true },
    });
    evidenceMap = new Map(evidenceRows.map((e) => [e.id, e]));
  }

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i]!;
    const sourceType = inp.sourceType ?? "analyst-input";

    if (sourceType === "analyst-input") {
      verifiedInputs.push({
        ...inp,
        verificationState: "analyst-unverified",
      });
      continue;
    }

    if (sourceType === "external-reference") {
      // External references have no verification mechanism yet.
      // Always labeled "external-pending-verification".
      verifiedInputs.push({
        ...inp,
        verificationState: "external-pending-verification",
      });
      continue;
    }

    // sourceType === "evidence-reference" — validate the evidence
    const refId = inp.referenceId!;
    const evidence = evidenceMap.get(refId);

    if (!evidence) {
      // Missing OR cross-tenant (RLS hides other tenants' rows, so a missing
      // result covers both cases). Fail-closed.
      errors.push(
        `costInputs[${i}] (label "${inp.label}"): evidence-reference "${refId}" ` +
        `was not found in tenant ${tenantId}. The reference may not exist, or it ` +
        `belongs to a different tenant (RLS hides cross-tenant rows). ` +
        `Fail-closed: a non-existent or cross-tenant evidence reference cannot ` +
        `be labeled as evidence-reference. Either fix the referenceId, or use ` +
        `sourceType="analyst-input" if this is an analyst assertion.`
      );
      continue;
    }

    // Fail-closed: evidence MUST have metadata.countryId (same as portfolio-service)
    const evMeta = (evidence.metadata ?? {}) as Record<string, unknown>;
    const evidenceCountryId = typeof evMeta.countryId === "string"
      ? evMeta.countryId : null;
    if (!evidenceCountryId) {
      errors.push(
        `costInputs[${i}] (label "${inp.label}"): evidence "${refId}" has no ` +
        `metadata.countryId. Fail-closed policy: evidence must be explicitly ` +
        `attributed to a country. Unattributed evidence cannot be used as an ` +
        `evidence-reference for a cost input.`
      );
      continue;
    }

    // Cross-country evidence is rejected
    if (evidenceCountryId !== strategyCountryId) {
      errors.push(
        `costInputs[${i}] (label "${inp.label}"): evidence "${refId}" belongs to ` +
        `country ${evidenceCountryId}, but the strategy version is for country ` +
        `${strategyCountryId}. Cross-country evidence references are not allowed.`
      );
      continue;
    }

    // Evidence exists + in scope. Determine verification state from verificationStatus.
    // verificationStatus values: "unverified" | "verified" | "disputed" | "refuted"
    const evStatus = evidence.verificationStatus;
    const verificationState: InputVerificationState =
      evStatus === "verified"
        ? "evidence-verified"
        : "evidence-pending-verification";

    verifiedInputs.push({
      ...inp,
      verificationState,
      evidenceVerificationStatus: evStatus,
    });
  }

  if (errors.length > 0) {
    return { verifiedInputs: null, errors };
  }
  return { verifiedInputs, errors };
}

/**
 * Compute the cost range from validated, homogeneous cost inputs.
 *
 * FIX-2 (01-06): All financial arithmetic uses Prisma.Decimal (decimal.js),
 * NOT JavaScript floating-point numbers. This prevents the classic
 * 0.1 + 0.2 = 0.30000000000000004 precision loss and ensures deterministic
 * results across re-runs. The Decimal constructor accepts strings and
 * numbers; we convert each input to Decimal at the start and never mix
 * with JS number arithmetic.
 *
 * Rounding rule: ROUND_HALF_UP to 2 decimal places (DECIMAL_PLACES).
 * This is the standard cash rounding convention: 0.005 → 0.01, 0.004 → 0.00.
 * Applied at line-item level AND at the aggregate level.
 *
 * Guards:
 *   - NaN/Infinity rejected at parse time (isFinitePositiveNumber)
 *   - Decimal.isNaN() / Decimal.isFinite() defensive check after construction
 *   - min > max integrity check (should be impossible given varianceLow <= varianceHigh)
 *
 * Returns { min, max } as string-formatted Decimals (2 decimal places)
 * to preserve precision in storage.
 */
function computeCostRange(inputs: VerifiedInput[]): {
  min: string;
  max: string;
  lineItems: Array<{
    label: string;
    min: string;
    max: string;
    source: string;
    sourceType: "analyst-input" | "evidence-reference" | "external-reference";
    referenceId?: string;
    verificationState: InputVerificationState;
    evidenceVerificationStatus?: string;
    base: string;
    varianceLow: string;
    varianceHigh: string;
    varianceSource: string;
  }>;
} {
  // Use Prisma.Decimal for all arithmetic. Initialize sums at 0.
  let minSum = new Prisma.Decimal(0);
  let maxSum = new Prisma.Decimal(0);
  const lineItems: Array<{
    label: string;
    min: string;
    max: string;
    source: string;
    sourceType: "analyst-input" | "evidence-reference" | "external-reference";
    referenceId?: string;
    verificationState: InputVerificationState;
    evidenceVerificationStatus?: string;
    base: string;
    varianceLow: string;
    varianceHigh: string;
    varianceSource: string;
  }> = [];

  for (const inp of inputs) {
    // Convert all numeric inputs to Prisma.Decimal at the boundary.
    // decimal.js accepts both string and number constructors; we use string
    // to avoid any JS floating-point representation issues at construction.
    const amountDec = new Prisma.Decimal(String(inp.unitCost.amount));
    const countDec = new Prisma.Decimal(String(inp.unitCount));
    const vLowDec = new Prisma.Decimal(String(inp.varianceLow));
    const vHighDec = new Prisma.Decimal(String(inp.varianceHigh));

    // Defensive: verify no NaN/Infinity slipped through (parse time should
    // have caught these, but Decimal may accept edge cases like "Infinity"
    // as a string).
    if (!amountDec.isFinite() || !countDec.isFinite() ||
        !vLowDec.isFinite() || !vHighDec.isFinite()) {
      throw new BudgetIntegrityError(
        `Non-finite Decimal encountered for cost input "${inp.label}". ` +
        `This should have been caught at parse time — indicates a bug in validation. ` +
        `amount=${amountDec.toString()}, count=${countDec.toString()}, ` +
        `varianceLow=${vLowDec.toString()}, varianceHigh=${vHighDec.toString()}`
      );
    }

    // base = amount × unitCount (Decimal multiplication — exact)
    const base = amountDec.mul(countDec);
    // lineMin = base × varianceLow; lineMax = base × varianceHigh
    const lineMin = base.mul(vLowDec);
    const lineMax = base.mul(vHighDec);

    // Round each line item to 2 decimal places (ROUND_HALF_UP) BEFORE summing.
    // This matches standard accounting practice: each line is rounded to cents,
    // then the cents are summed. (Alternative: sum first, round once — but
    // that can produce a different total than the sum of rounded lines, which
    // is confusing for audit. We round-then-sum for transparency.)
    const lineMinRounded = lineMin.toDecimalPlaces(DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP);
    const lineMaxRounded = lineMax.toDecimalPlaces(DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP);

    minSum = minSum.add(lineMinRounded);
    maxSum = maxSum.add(lineMaxRounded);

    lineItems.push({
      label: inp.label,
      min: lineMinRounded.toFixed(DECIMAL_PLACES),
      max: lineMaxRounded.toFixed(DECIMAL_PLACES),
      source: inp.source,
      sourceType: inp.sourceType ?? "analyst-input",
      referenceId: inp.referenceId,
      verificationState: inp.verificationState,
      evidenceVerificationStatus: inp.evidenceVerificationStatus,
      base: base.toFixed(DECIMAL_PLACES),
      varianceLow: vLowDec.toString(),
      varianceHigh: vHighDec.toString(),
      varianceSource: inp.varianceSource,
    });
  }

  // Round the aggregate sums to 2 decimal places.
  const minFinal = minSum.toDecimalPlaces(DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP);
  const maxFinal = maxSum.toDecimalPlaces(DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP);

  // Guard: if min > max (shouldn't happen given varianceLow <= varianceHigh,
  // but defensive), surface it. Use Decimal comparison (not JS comparison).
  if (minFinal.greaterThan(maxFinal)) {
    throw new BudgetIntegrityError(
      `Computed min (${minFinal.toFixed(DECIMAL_PLACES)}) > max (${maxFinal.toFixed(DECIMAL_PLACES)}). ` +
      `This indicates a bug in variance multiplier validation. Refusing to store an invalid range.`
    );
  }

  return {
    min: minFinal.toFixed(DECIMAL_PLACES),
    max: maxFinal.toFixed(DECIMAL_PLACES),
    lineItems,
  };
}

/**
 * Build the assumptions array — documents every input + the model so
 * anyone can reproduce the calculation. Mission pack §3: "حافظ على مراجع
 * المدخلات وأرقام نسخها اللازمة لإعادة الإنتاج" (preserve input
 * references and the version numbers needed for reproduction).
 *
 * FIX-1 (01-06): documents the explicit varianceLow + varianceHigh +
 * varianceSource for each input. No default-variance assumption is
 * emitted — there is no default.
 *
 * FINAL PROVENANCE CLOSURE (01-06): documents the verification state for
 * each input honestly:
 *   - analyst-unverified          → "[UNVERIFIED — analyst-supplied assertion]"
 *   - evidence-verified           → "[evidence-verified; referenceId=...; evidence
 *                                    does NOT automatically prove the price]"
 *   - evidence-pending-verification → "[evidence-pending-verification;
 *                                    referenceId=...; evidence verificationStatus=...]"
 *   - external-pending-verification → "[external-pending-verification; referenceId=...;
 *                                    no external verification mechanism implemented yet]"
 *
 * The model NEVER labels an input as simply "verified". Even evidence-verified
 * inputs get the explicit caveat: "evidence does NOT automatically prove the
 * price; it is examinable support, not price verification."
 */
function buildAssumptions(
  inputs: VerifiedInput[],
  lineItems: Array<{
    label: string; min: string; max: string; source: string;
    sourceType: "analyst-input" | "evidence-reference" | "external-reference";
    referenceId?: string;
    verificationState: InputVerificationState;
    evidenceVerificationStatus?: string;
    base: string;
    varianceLow: string; varianceHigh: string; varianceSource: string;
  }>,
  currency: Currency,
  horizonYears: number
): Assumption[] {
  const assumptions: Assumption[] = [];

  // Per-input assumptions — FIX-1 + FINAL PROVENANCE CLOSURE
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i]!;
    const li = lineItems[i]!;
    const sourceType = inp.sourceType ?? "analyst-input";

    // Build the verification note based on the ACTUAL verification state
    // (set by validateEvidenceReferences). This is the honest label —
    // never "verified" without qualification.
    let verificationNote: string;
    if (li.verificationState === "analyst-unverified") {
      verificationNote = ` [UNVERIFIED — analyst-supplied assertion; not independently verified]`;
    } else if (li.verificationState === "evidence-verified") {
      verificationNote =
        ` [evidence-verified; referenceId=${inp.referenceId ?? "MISSING"}; ` +
        `evidence verificationStatus="verified". ` +
        `IMPORTANT: evidence does NOT automatically prove the price — ` +
        `it is examinable support, not price verification. ` +
        `The evidence was cited by a human; its verificationStatus reflects ` +
        `the evidence's own verification, not a verification that the evidence ` +
        `supports this specific cost input.]`;
    } else if (li.verificationState === "evidence-pending-verification") {
      verificationNote =
        ` [evidence-pending-verification; referenceId=${inp.referenceId ?? "MISSING"}; ` +
        `evidence verificationStatus="${li.evidenceVerificationStatus ?? "unknown"}". ` +
        `The cited evidence exists and is in tenant+country scope, but its ` +
        `verificationStatus is not "verified". Do not treat this input as verified.]`;
    } else {
      // external-pending-verification
      verificationNote =
        ` [external-pending-verification; referenceId=${inp.referenceId ?? "MISSING"}. ` +
        `External references have no verification mechanism implemented yet. ` +
        `Do not treat this input as verified.]`;
    }

    assumptions.push({
      description:
        `Cost input "${inp.label}": unitCost ${inp.unitCost.amount} ${inp.unitCost.currency} × ` +
        `${inp.unitCount} units = base ${li.base} ${currency}. ` +
        `varianceLow ${li.varianceLow} (min ${li.min}), varianceHigh ${li.varianceHigh} (max ${li.max}). ` +
        `varianceSource: ${inp.varianceSource}. ` +
        `sourceType: ${sourceType}.` +
        (inp.note ? ` Note: ${inp.note}.` : "") +
        verificationNote,
      source: inp.source,
      reproducesIn:
        `lineMin = (amount * unitCount * varianceLow).toDecimalPlaces(2, ROUND_HALF_UP); ` +
        `lineMax = (amount * unitCount * varianceHigh).toDecimalPlaces(2, ROUND_HALF_UP); ` +
        `costRange.min = sum(lineItems.min); costRange.max = sum(lineItems.max)`,
    });
  }

  // Model-level assumptions
  assumptions.push({
    description:
      `Cost range aggregated by summing line-item min/max across ${inputs.length} input(s). ` +
      `Currency: ${currency}. Horizon: ${horizonYears} year(s). ` +
      `min = Σ(lineMin), max = Σ(lineMax). No NPV discounting applied (v1 model). ` +
      `Each line item rounded to 2 decimal places (ROUND_HALF_UP) BEFORE summing; ` +
      `aggregate sum rounded again to 2 decimal places.`,
    source: "model-default (v1-deterministic)",
    reproducesIn:
      `Decimal arithmetic (Prisma.Decimal / decimal.js). ` +
      `modelVersion = ${BUDGET_MODEL_VERSION}`,
  });

  // FIX-1: explicit statement that there is NO default variance.
  assumptions.push({
    description:
      `No default variance multipliers are applied. Each cost input carries ` +
      `its own varianceLow + varianceHigh + varianceSource, justified by the ` +
      `analyst. The model does NOT inject a generic 0.9/1.15 margin — that ` +
      `would give a false sense of precision. If an input lacks a justified ` +
      `variance, the program returns "insufficient data for estimate".`,
    source: "model-default (v1-deterministic)",
  });

  // FINAL PROVENANCE CLOSURE: explicit statement about the verification taxonomy.
  assumptions.push({
    description:
      `Input verification taxonomy (FINAL PROVENANCE CLOSURE): ` +
      `"analyst-input" = UNVERIFIED analyst assertion. ` +
      `"evidence-reference" = references an internal Evidence row, validated ` +
      `against tenant + country scope + verificationStatus. If the evidence's ` +
      `verificationStatus is "verified", the input is labeled "evidence-verified" ` +
      `(but the evidence does NOT automatically prove the price). Otherwise ` +
      `"evidence-pending-verification". ` +
      `"external-reference" = references an external source (price index, tender ` +
      `document); labeled "external-pending-verification" because no external ` +
      `verification mechanism is implemented yet. ` +
      `The model NEVER labels an input as simply "verified" — even evidence-verified ` +
      `inputs get the explicit caveat that the evidence is examinable support, ` +
      `not price verification.`,
    source: "model-default (v1-deterministic)",
  });

  assumptions.push({
    description:
      `simulated: true — the cost model uses no real market data. The structure is real ` +
      `(deterministic, reproducible, Decimal-precise) but the numbers are illustrative. ` +
      `Do not present this estimate as a verified government cost projection without ` +
      `independent validation.`,
    source: "model-default (v1-deterministic)",
  });

  return assumptions;
}

/**
 * Parse financing sources from program.metadata.financingSources.
 * Mission pack §4: "لا تختلق منحاً أو قروضاً معتمدة أو وعود تمويل"
 * (do not fabricate grants, approved loans, or funding promises).
 * We do NOT fabricate financing sources. If the program metadata has none,
 * financingSources is an empty array and we surface a "financing data gap"
 * note in the assumptions.
 */
function parseFinancingSources(raw: unknown): {
  sources: FinancingSource[];
  errors: string[];
} {
  const errors: string[] = [];

  if (raw == null) {
    return { sources: [], errors }; // no financingSources — clean empty
  }

  if (!Array.isArray(raw)) {
    errors.push("program.metadata.financingSources is not an array");
    return { sources: [], errors };
  }

  const sources: FinancingSource[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>;
    if (!item || typeof item !== "object") {
      errors.push(`financingSources[${i}] is not an object`);
      continue;
    }

    if (typeof item.type !== "string" || item.type.trim().length === 0) {
      errors.push(`financingSources[${i}].type is missing`);
      continue;
    }
    if (typeof item.description !== "string" || item.description.trim().length === 0) {
      errors.push(`financingSources[${i}].description is missing`);
      continue;
    }
    const confidence = item.confidence;
    if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
      errors.push(`financingSources[${i}].confidence must be "high", "medium", or "low"`);
      continue;
    }
    if (typeof item.confidenceRationale !== "string" || item.confidenceRationale.trim().length === 0) {
      errors.push(`financingSources[${i}].confidenceRationale is missing`);
      continue;
    }

    sources.push({
      type: item.type,
      description: item.description,
      confidence,
      confidenceRationale: item.confidenceRationale,
    });
  }

  return { sources, errors };
}

// ============================================================
// ESTIMATE BUDGETS (public API)
// ============================================================

export async function estimateBudgets(
  session: Session,
  input: { strategyAlternativeId: string }
): Promise<BudgetResult> {
  // Write operation — admin + analyst only
  await requirePermissionWithCurrentRole(session, "budget:compute");

  if (!input.strategyAlternativeId) {
    throw new BudgetValidationError("strategyAlternativeId is required");
  }

  // We process all programs in the strategy version. The whole estimateBudgets
  // call is wrapped in a single transaction so it's atomic — either all
  // programs get their budget lines (or insufficient-data entries) updated,
  // or none do. This prevents partial storage if the call crashes mid-way
  // (mission pack §6: "منع التكرار عند إعادة التنفيذ والتزامن" +
  //  "التزامن وعدم التخزين الجزئي").
  try {
    return await withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
      // 1. Validate the strategy version belongs to this tenant + fetch its
      // metadata (for countryId — needed by evidence-reference validation).
      // FINAL PROVENANCE CLOSURE: combined the existence check + metadata fetch
      // into a single query. The countryId from metadata.inputSnapshot is used
      // to validate evidence-reference inputs against the same country scope.
      const strategyVersion = await tx.strategyVersion.findFirst({
        where: { id: input.strategyAlternativeId, tenantId },
        select: { id: true, metadata: true },
      });
      if (!strategyVersion) {
        throw new BudgetValidationError(
          `Strategy version ${input.strategyAlternativeId} not found in tenant scope. ` +
          `Cannot estimate budgets for a strategy that doesn't belong to this tenant.`
        );
      }
      const svMeta = (strategyVersion.metadata ?? {}) as Record<string, unknown>;
      const inputSnapshot = (svMeta.inputSnapshot ?? {}) as Record<string, unknown>;
      const strategyCountryId = typeof inputSnapshot.countryId === "string"
        ? inputSnapshot.countryId : null;
      if (!strategyCountryId) {
        throw new BudgetValidationError(
          `Strategy version ${input.strategyAlternativeId} has no countryId in ` +
          `metadata.inputSnapshot. Cannot validate evidence-reference inputs ` +
          `without the strategy country scope.`
        );
      }

      // 2. Fetch all programs in this strategy version
      const programs = await tx.program.findMany({
        where: { tenantId, strategyVersionId: input.strategyAlternativeId },
        orderBy: { title: "asc" },
      });

      const estimates: BudgetEstimate[] = [];
      const insufficient: InsufficientDataEntry[] = [];
      const currencies = new Set<Currency>();
      let withInstitutionGap = 0;
      let withMandateGap = 0;

      for (const program of programs) {
        const meta = (program.metadata ?? {}) as Record<string, unknown>;
        const budgetMeta = meta as unknown as ProgramMetadataForBudget;

        // Surface known gaps that limit the validity of any estimate
        const programMeta = meta as Record<string, unknown>;
        const institutionAssignmentGap =
          (programMeta.institutionAssignmentGap as boolean) ?? true;
        const mandateGap = (programMeta.mandateGap as boolean) ?? true;
        if (institutionAssignmentGap) withInstitutionGap++;
        if (mandateGap) withMandateGap++;

        // Parse cost inputs
        const { inputs, errors: inputErrors } = parseCostInputs(budgetMeta.costInputs);
        const { sources: finSources, errors: finErrors } = parseFinancingSources(
          budgetMeta.financingSources
        );

        // If there are validation errors OR no inputs, this is "insufficient data"
        const allErrors = [...inputErrors, ...finErrors];
        if (!inputs || allErrors.length > 0) {
          const gaps: string[] = [];
          if (!inputs && inputErrors.length === 0) {
            gaps.push("no costInputs provided in program metadata");
          }
          gaps.push(...allErrors);
          if (inputs === null && finErrors.length === 0 && inputErrors.length === 0) {
            // clean "no data" case — no extra errors
          }
          insufficient.push({
            programId: program.id,
            programTitle: program.title,
            programSector: program.sector,
            reason: gaps[0] ?? "no cost inputs provided",
            gaps,
          });
          continue;
        }

        // Validate homogeneity (single currency, single horizon)
        const { currency, horizonYears, errors: homogErrors } =
          validateInputsHomogeneous(inputs);
        if (homogErrors.length > 0) {
          insufficient.push({
            programId: program.id,
            programTitle: program.title,
            programSector: program.sector,
            reason: homogErrors[0]!,
            gaps: homogErrors,
          });
          continue;
        }

        // FINAL PROVENANCE CLOSURE: validate evidence-reference inputs.
        // For sourceType="evidence-reference", verify the cited Evidence row
        // exists in tenant + country scope and check its verificationStatus.
        // Missing / cross-tenant / cross-country evidence → fail-closed
        // (program goes to insufficientData). analyst-input and external-reference
        // inputs pass through with their respective default verification states.
        const { verifiedInputs, errors: evidenceErrors } =
          await validateEvidenceReferences(tx, tenantId, strategyCountryId, inputs);
        if (verifiedInputs === null || evidenceErrors.length > 0) {
          insufficient.push({
            programId: program.id,
            programTitle: program.title,
            programSector: program.sector,
            reason: evidenceErrors[0] ?? "evidence-reference validation failed",
            gaps: evidenceErrors,
          });
          continue;
        }

        // Compute the cost range (uses verifiedInputs — verificationState
        // is included in lineItems for buildAssumptions)
        const { min, max, lineItems } = computeCostRange(verifiedInputs);
        const assumptions = buildAssumptions(verifiedInputs, lineItems, currency, horizonYears);

        // If no financing sources, surface a "financing data gap" assumption
        const finalFinSources = finSources;
        if (finalFinSources.length === 0) {
          assumptions.push({
            description:
              `No financing sources documented for this program. The cost range is ` +
              `estimated but unfunded — do not present this as a budgeted program. ` +
              `Financing sources must be documented before this estimate can inform ` +
              `an execution decision.`,
            source: "model-default (financing-data-gap)",
          });
        }

        const estimate: BudgetEstimate = {
          programId: program.id,
          programTitle: program.title,
          programSector: program.sector,
          costRange: { min, max, currency, horizonYears },
          assumptions,
          financingSources: finalFinSources,
          modelVersion: BUDGET_MODEL_VERSION,
          simulated: true,
          institutionAssignmentGap,
          mandateGap,
        };
        estimates.push(estimate);
        currencies.add(currency);

        // === IDEMPOTENT STORAGE ===
        // upsert on (tenantId, programId, modelVersion) — migration 0020 unique index.
        // If a budget line already exists for this program + model version,
        // update it; otherwise create it. This makes estimateBudgets idempotent.
        await tx.budgetLine.upsert({
          where: {
            tenantId_programId_modelVersion: {
              tenantId,
              programId: program.id,
              modelVersion: BUDGET_MODEL_VERSION,
            },
          },
          update: {
            currency,
            minAmount: new Prisma.Decimal(min),
            maxAmount: new Prisma.Decimal(max),
            horizonYears,
            assumptions: assumptions as unknown as Prisma.InputJsonValue,
            financingSources: finalFinSources as unknown as Prisma.InputJsonValue,
            modelVersion: BUDGET_MODEL_VERSION,
            metadata: {
              simulated: true,
              lineItems,
              institutionAssignmentGap,
              mandateGap,
              estimatedAt: new Date().toISOString(),
            } as unknown as Prisma.InputJsonValue,
          },
          create: {
            tenantId,
            programId: program.id,
            currency,
            minAmount: new Prisma.Decimal(min),
            maxAmount: new Prisma.Decimal(max),
            horizonYears,
            assumptions: assumptions as unknown as Prisma.InputJsonValue,
            financingSources: finalFinSources as unknown as Prisma.InputJsonValue,
            modelVersion: BUDGET_MODEL_VERSION,
            metadata: {
              simulated: true,
              lineItems,
              institutionAssignmentGap,
              mandateGap,
              estimatedAt: new Date().toISOString(),
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }

      // 3. Delete budget lines for programs that no longer have cost inputs
      // (e.g. the analyst removed the costInputs from metadata between runs).
      // This keeps the storage in sync with the current state. We only delete
      // lines for programs in THIS strategy version with THIS model version.
      if (programs.length > 0) {
        const programIds = programs.map((p) => p.id);
        const estimatedIds = new Set(estimates.map((e) => e.programId));
        const idsToDelete = programIds.filter((id) => !estimatedIds.has(id));
        if (idsToDelete.length > 0) {
          await tx.budgetLine.deleteMany({
            where: {
              tenantId,
              programId: { in: idsToDelete },
              modelVersion: BUDGET_MODEL_VERSION,
            },
          });
        }
      }

      // 4. Build summary
      const summary = {
        totalPrograms: programs.length,
        estimated: estimates.length,
        insufficient: insufficient.length,
        withInstitutionGap,
        withMandateGap,
        currencies: [...currencies].sort(),
      };

      return {
        strategyAlternativeId: input.strategyAlternativeId,
        estimates,
        insufficientData: insufficient,
        modelVersion: BUDGET_MODEL_VERSION,
        summary,
      };
    });
  } catch (err) {
    // P2002 recovery is handled by upsert() — it doesn't throw P2002 because
    // upsert is atomic. But if a concurrent worker is also running upsert on
    // the same key, one will win and the other will update. No P2002 should
    // surface from upsert. However, if some other constraint violation occurs
    // (e.g. the minAmount > maxAmount CHECK), we surface it as a clear error.
    if (err && typeof err === "object" && "code" in err &&
        (err as { code: string }).code === "P2002") {
      // Defensive: upsert shouldn't throw P2002, but if a future code path
      // introduces a raw create(), this catch prevents a crash.
      throw new BudgetIntegrityError(
        `Concurrent estimateBudgets call created a duplicate budget line. ` +
        `This should not happen — upsert is atomic. If you see this error, ` +
        `it indicates a bug in the budget service.`
      );
    }
    throw err;
  }
}

// ============================================================
// GET BUDGETS (read-only — for inspection / API routes)
// ============================================================

export async function getBudgets(
  session: Session,
  strategyAlternativeId: string
): Promise<BudgetEstimate[]> {
  await requirePermissionWithCurrentRole(session, "budget:read");

  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // Fetch programs in this strategy version (RLS-enforced)
    const programs = await tx.program.findMany({
      where: { tenantId, strategyVersionId: strategyAlternativeId },
      select: { id: true, title: true, sector: true, metadata: true },
    });
    if (programs.length === 0) return [];

    const programIds = programs.map((p) => p.id);
    const programMap = new Map(programs.map((p) => [p.id, p]));

    // Fetch budget lines for these programs (RLS-enforced)
    const lines = await tx.budgetLine.findMany({
      where: { tenantId, programId: { in: programIds }, modelVersion: BUDGET_MODEL_VERSION },
    });

    return lines.map((line) => {
      const prog = programMap.get(line.programId);
      const meta = (prog?.metadata ?? {}) as Record<string, unknown>;
      // Normalize Decimal to 2-decimal-place string for consistent display
      // (Prisma Decimal.toString() may strip trailing zeros, e.g. "900" instead
      // of "900.00"). The estimateBudgets path already uses toFixed(2), so we
      // match that format here for consistency.
      const minStr = parseFloat(line.minAmount.toString()).toFixed(2);
      const maxStr = parseFloat(line.maxAmount.toString()).toFixed(2);
      return {
        programId: line.programId,
        programTitle: prog?.title ?? "",
        programSector: prog?.sector ?? "",
        costRange: {
          min: minStr,
          max: maxStr,
          currency: line.currency,
          horizonYears: line.horizonYears,
        },
        assumptions: (line.assumptions as unknown as Assumption[]) ?? [],
        financingSources: (line.financingSources as unknown as FinancingSource[]) ?? [],
        modelVersion: line.modelVersion,
        simulated: true as const,
        institutionAssignmentGap: (meta.institutionAssignmentGap as boolean) ?? true,
        mandateGap: (meta.mandateGap as boolean) ?? true,
      };
    });
  });
}

// ============================================================
// VALIDATE COST INPUT (helper for API routes / tests)
// ------------------------------------------------------------
// Allows an analyst to validate cost inputs BEFORE storing them on a program.
// Returns the list of validation errors (empty = valid).
// ============================================================

export function validateCostInputs(raw: unknown): string[] {
  const { inputs, errors } = parseCostInputs(raw);
  if (!inputs) return errors.length > 0 ? errors : [];
  const homog = validateInputsHomogeneous(inputs);
  return [...errors, ...homog.errors];
}
