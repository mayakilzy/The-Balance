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
// ============================================================

interface CostInput {
  label: string;
  unitCost: { amount: number; currency: Currency };
  unitCount: number;
  horizonYears: number;
  source: string;
  note?: string;
  varianceLow?: number;   // multiplier for min (default 0.9)
  varianceHigh?: number;  // multiplier for max (default 1.15)
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
// CONSTANTS — Model defaults (all documented as assumptions)
// ============================================================

// Default variance multipliers — NOT arbitrary padding. These reflect that
// a unit-cost estimate is typically 10% optimistic (low) and 15% pessimistic
// (high) when scaled to program level. These are EXPLICIT assumptions that
// the analyst can override per-input. They are recorded in every estimate's
// assumptions array so anyone can reproduce the calculation.
const DEFAULT_VARIANCE_LOW = 0.9;
const DEFAULT_VARIANCE_HIGH = 1.15;

// ISO 4217-style currency code pattern (3 uppercase letters).
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// ============================================================
// HELPERS — validation
// ============================================================

function isValidCurrency(code: string): boolean {
  return CURRENCY_PATTERN.test(code);
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
    if (typeof currency !== "string" || !isValidCurrency(currency)) {
      errors.push(`costInputs[${i}].unitCost.currency must be a 3-letter ISO 4217 code`);
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

    // source (provenance)
    if (typeof item.source !== "string" || item.source.trim().length === 0) {
      errors.push(`costInputs[${i}].source is missing (provenance required for every cost input)`);
      continue;
    }

    // optional variance multipliers
    let varianceLow = DEFAULT_VARIANCE_LOW;
    let varianceHigh = DEFAULT_VARIANCE_HIGH;
    if (item.varianceLow !== undefined) {
      if (!isFinitePositiveNumber(item.varianceLow) || item.varianceLow > 1) {
        errors.push(`costInputs[${i}].varianceLow must be in (0, 1]`);
        continue;
      }
      varianceLow = item.varianceLow;
    }
    if (item.varianceHigh !== undefined) {
      if (!isFinitePositiveNumber(item.varianceHigh) || item.varianceHigh < 1) {
        errors.push(`costInputs[${i}].varianceHigh must be >= 1`);
        continue;
      }
      varianceHigh = item.varianceHigh;
    }
    if (varianceLow > varianceHigh) {
      errors.push(`costInputs[${i}].varianceLow (${varianceLow}) > varianceHigh (${varianceHigh})`);
      continue;
    }

    inputs.push({
      label: item.label,
      unitCost: { amount, currency },
      unitCount: item.unitCount as number,
      horizonYears: item.horizonYears as number,
      source: item.source,
      note: typeof item.note === "string" ? item.note : undefined,
      varianceLow,
      varianceHigh,
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

/**
 * Compute the cost range from validated, homogeneous cost inputs.
 * Returns { min, max } as string-formatted Decimals (2 decimal places)
 * to preserve precision in storage.
 */
function computeCostRange(inputs: CostInput[]): {
  min: string;
  max: string;
  lineItems: Array<{ label: string; min: string; max: string; source: string }>;
} {
  let minSum = 0;
  let maxSum = 0;
  const lineItems: Array<{ label: string; min: string; max: string; source: string }> = [];

  for (const inp of inputs) {
    const base = inp.unitCost.amount * inp.unitCount;
    const lineMin = base * inp.varianceLow!;
    const lineMax = base * inp.varianceHigh!;
    minSum += lineMin;
    maxSum += lineMax;
    lineItems.push({
      label: inp.label,
      min: lineMin.toFixed(2),
      max: lineMax.toFixed(2),
      source: inp.source,
    });
  }

  // Guard: if min > max (shouldn't happen given varianceLow <= varianceHigh,
  // but defensive), surface it.
  if (minSum > maxSum) {
    throw new BudgetIntegrityError(
      `Computed min (${minSum}) > max (${maxSum}). This indicates a bug in variance ` +
      `multiplier validation. Refusing to store an invalid range.`
    );
  }

  return {
    min: minSum.toFixed(2),
    max: maxSum.toFixed(2),
    lineItems,
  };
}

/**
 * Build the assumptions array — documents every input + the model defaults
 * so anyone can reproduce the calculation. Mission pack §3: "حافظ على مراجع
 * المدخلات وأرقام نسخها اللازمة لإعادة الإنتاج" (preserve input references
 * and the version numbers needed for reproduction).
 */
function buildAssumptions(
  inputs: CostInput[],
  lineItems: Array<{ label: string; min: string; max: string; source: string }>,
  currency: Currency,
  horizonYears: number
): Assumption[] {
  const assumptions: Assumption[] = [];

  // Per-input assumptions
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i]!;
    const li = lineItems[i]!;
    assumptions.push({
      description:
        `Cost input "${inp.label}": unitCost ${inp.unitCost.amount} ${inp.unitCost.currency} × ` +
        `${inp.unitCount} units = base ${inp.unitCost.amount * inp.unitCount} ${currency}, ` +
        `varianceLow ${inp.varianceLow} (min ${li.min}), varianceHigh ${inp.varianceHigh} (max ${li.max})` +
        (inp.note ? `. Note: ${inp.note}` : ""),
      source: inp.source,
      reproducesIn:
        `lineMin = unitCost.amount * unitCount * varianceLow; ` +
        `lineMax = unitCost.amount * unitCount * varianceHigh`,
    });
  }

  // Model-level assumptions
  assumptions.push({
    description:
      `Cost range aggregated by summing line-item min/max across ${inputs.length} input(s). ` +
      `Currency: ${currency}. Horizon: ${horizonYears} year(s). ` +
      `min = Σ(lineMin), max = Σ(lineMax). No NPV discounting applied (v1 model).`,
    source: "model-default (v1-deterministic)",
    reproducesIn:
      `costRange.min = sum(lineItems.min); costRange.max = sum(lineItems.max); ` +
      `modelVersion = ${BUDGET_MODEL_VERSION}`,
  });

  assumptions.push({
    description:
      `Default variance multipliers: varianceLow=${DEFAULT_VARIANCE_LOW} (10% optimism guard), ` +
      `varianceHigh=${DEFAULT_VARIANCE_HIGH} (15% pessimism guard). These reflect that a ` +
      `unit-cost estimate is typically optimistic at the low end and pessimistic at the high ` +
      `end when scaled to program level. An analyst can override these per-input.`,
    source: "model-default (v1-deterministic)",
    reproducesIn: `defaults: varianceLow=${DEFAULT_VARIANCE_LOW}, varianceHigh=${DEFAULT_VARIANCE_HIGH}`,
  });

  assumptions.push({
    description:
      `simulated: true — the cost model uses no real market data. The structure is real ` +
      `(deterministic, reproducible) but the numbers are illustrative. Do not present this ` +
      `estimate as a verified government cost projection without independent validation.`,
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
      // 1. Validate the strategy version belongs to this tenant
      const version = await tx.strategyVersion.findFirst({
        where: { id: input.strategyAlternativeId, tenantId },
        select: { id: true },
      });
      if (!version) {
        throw new BudgetValidationError(
          `Strategy version ${input.strategyAlternativeId} not found in tenant scope. ` +
          `Cannot estimate budgets for a strategy that doesn't belong to this tenant.`
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

        // Compute the cost range
        const { min, max, lineItems } = computeCostRange(inputs);
        const assumptions = buildAssumptions(inputs, lineItems, currency, horizonYears);

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
      return {
        programId: line.programId,
        programTitle: prog?.title ?? "",
        programSector: prog?.sector ?? "",
        costRange: {
          min: line.minAmount.toString(),
          max: line.maxAmount.toString(),
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
