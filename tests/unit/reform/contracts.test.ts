// ============================================================
// tests/unit/reform/contracts.test.ts
// ------------------------------------------------------------
// Unit tests for G03-02 Zod schemas. Pure validation, no DB.
// ============================================================
import { describe, it, expect } from "vitest";
import {
  CreateReformProposalInputSchema,
  ApproveReformProposalInputSchema,
  RejectReformProposalInputSchema,
  CreateReformActionInputSchema,
  AddReformActionUpdateInputSchema,
  VerifyReformActionInputSchema,
  CreateReformFeedbackLoopInputSchema,
  CloseOriginatingAlertInputSchema,
  ReformProposalStatusSchema,
  ReformActionStatusSchema,
  ReformVerificationStatusSchema,
} from "@/lib/reform/contracts";

// ============================================================
// Proposal lifecycle enums
// ============================================================
describe("ReformProposalStatusSchema", () => {
  it("accepts the 5 frozen lifecycle values", () => {
    expect(ReformProposalStatusSchema.parse("draft")).toBe("draft");
    expect(ReformProposalStatusSchema.parse("under_review")).toBe("under_review");
    expect(ReformProposalStatusSchema.parse("approved")).toBe("approved");
    expect(ReformProposalStatusSchema.parse("rejected")).toBe("rejected");
    expect(ReformProposalStatusSchema.parse("superseded")).toBe("superseded");
  });
  it("rejects unknown values", () => {
    expect(() => ReformProposalStatusSchema.parse("pending")).toThrow();
    expect(() => ReformProposalStatusSchema.parse("active")).toThrow();
  });
});

describe("ReformActionStatusSchema", () => {
  it("accepts planned/in_progress/completed (G03-02 minimal)", () => {
    expect(ReformActionStatusSchema.parse("planned")).toBe("planned");
    expect(ReformActionStatusSchema.parse("in_progress")).toBe("in_progress");
    expect(ReformActionStatusSchema.parse("completed")).toBe("completed");
  });
  it("rejects blocked/cancelled (deferred to G03-05)", () => {
    expect(() => ReformActionStatusSchema.parse("blocked")).toThrow();
    expect(() => ReformActionStatusSchema.parse("cancelled")).toThrow();
  });
});

describe("ReformVerificationStatusSchema", () => {
  it("accepts pending/verified/disputed", () => {
    expect(ReformVerificationStatusSchema.parse("pending")).toBe("pending");
    expect(ReformVerificationStatusSchema.parse("verified")).toBe("verified");
    expect(ReformVerificationStatusSchema.parse("disputed")).toBe("disputed");
  });
});

// ============================================================
// CreateReformProposalInputSchema
// ============================================================
describe("CreateReformProposalInputSchema", () => {
  const validInput = {
    originatingAlertId: "cmv_alert_001",
    title: "Reform monetary policy framework",
    problemStatement:
      "Demolandia monetary base growth exceeded 7% in 2024, threatening price stability.",
    hypothesizedCauses: ["loose fiscal-monetary coordination"],
    alternative: {
      title: "Inflation Targeting Framework",
      description:
        "Adopt a 3%±1pp inflation targeting framework with quarterly accountability reports.",
    },
  };

  it("accepts a valid proposal input", () => {
    const result = CreateReformProposalInputSchema.parse(validInput);
    expect(result.title).toBe("Reform monetary policy framework");
    expect(result.alternative.costCurrency).toBe("USD"); // default
    expect(result.alternative.riskLevel).toBe("medium"); // default
  });

  it("requires originatingAlertId", () => {
    expect(() =>
      CreateReformProposalInputSchema.parse({ ...validInput, originatingAlertId: "" })
    ).toThrow();
  });

  it("requires title >= 5 chars", () => {
    expect(() =>
      CreateReformProposalInputSchema.parse({ ...validInput, title: "ab" })
    ).toThrow();
  });

  it("requires problemStatement >= 20 chars", () => {
    expect(() =>
      CreateReformProposalInputSchema.parse({
        ...validInput,
        problemStatement: "short",
      })
    ).toThrow();
  });

  it("rejects >5 hypothesizedCauses", () => {
    expect(() =>
      CreateReformProposalInputSchema.parse({
        ...validInput,
        hypothesizedCauses: ["a", "b", "c", "d", "e", "f"],
      })
    ).toThrow();
  });

  it("requires the alternative sub-object", () => {
    expect(() =>
      CreateReformProposalInputSchema.parse({
        originatingAlertId: "x",
        title: "valid title",
        problemStatement: "valid problem statement here",
      })
    ).toThrow();
  });

  it("defaults costCurrency to USD when not provided", () => {
    const result = CreateReformProposalInputSchema.parse(validInput);
    expect(result.alternative.costCurrency).toBe("USD");
  });

  it("rejects unknown authority-bearing fields in the alternative", () => {
    // The schema does not allow canApproveCommitments, verifiedInstitutionId, etc.
    // These are NEVER accepted from client input.
    expect(() =>
      CreateReformProposalInputSchema.parse({
        ...validInput,
        alternative: {
          ...validInput.alternative,
          canApproveCommitments: true,
        },
      })
    ).toThrow();
  });
});

// ============================================================
// ApproveReformProposalInputSchema
// ============================================================
describe("ApproveReformProposalInputSchema", () => {
  it("accepts a valid approval input without alternativeId (auto-resolved)", () => {
    const result = ApproveReformProposalInputSchema.parse({
      proposalId: "cmv_prop_001",
      rationale: "Approved based on cross-tenant evidence convergence.",
    });
    expect(result.alternativeId).toBeUndefined();
  });

  it("accepts an explicit alternativeId", () => {
    const result = ApproveReformProposalInputSchema.parse({
      proposalId: "cmv_prop_001",
      alternativeId: "cmv_alt_001",
      rationale: "Approved based on cross-tenant evidence convergence.",
    });
    expect(result.alternativeId).toBe("cmv_alt_001");
  });

  it("requires rationale >= 20 chars", () => {
    expect(() =>
      ApproveReformProposalInputSchema.parse({
        proposalId: "x",
        rationale: "short",
      })
    ).toThrow();
  });

  it("rejects actingOnBehalfOfInstitutionId (B3 belongs to G03-06)", () => {
    expect(() =>
      ApproveReformProposalInputSchema.parse({
        proposalId: "x",
        rationale: "valid rationale for approval here",
        actingOnBehalfOfInstitutionId: "inst_001",
      })
    ).toThrow();
  });
});

// ============================================================
// RejectReformProposalInputSchema
// ============================================================
describe("RejectReformProposalInputSchema", () => {
  it("requires rejectionReason >= 20 chars", () => {
    expect(() =>
      RejectReformProposalInputSchema.parse({
        proposalId: "x",
        rejectionReason: "short",
      })
    ).toThrow();
  });

  it("accepts a valid rejection", () => {
    const result = RejectReformProposalInputSchema.parse({
      proposalId: "x",
      rejectionReason: "Insufficient evidence to support the proposed reform.",
    });
    expect(result.rejectionReason.length).toBeGreaterThan(20);
  });
});

// ============================================================
// CreateReformActionInputSchema
// ============================================================
describe("CreateReformActionInputSchema", () => {
  it("requires proposalId", () => {
    expect(() =>
      CreateReformActionInputSchema.parse({ title: "valid action title" })
    ).toThrow();
  });

  it("requires title >= 5 chars", () => {
    expect(() =>
      CreateReformActionInputSchema.parse({
        proposalId: "x",
        title: "ab",
      })
    ).toThrow();
  });

  it("accepts optional dueDate as ISO 8601 datetime", () => {
    const result = CreateReformActionInputSchema.parse({
      proposalId: "x",
      title: "valid action title",
      dueDate: "2025-06-30T00:00:00Z",
    });
    expect(result.dueDate).toBe("2025-06-30T00:00:00Z");
  });

  it("rejects malformed dueDate", () => {
    expect(() =>
      CreateReformActionInputSchema.parse({
        proposalId: "x",
        title: "valid action title",
        dueDate: "not-a-date",
      })
    ).toThrow();
  });

  it("does NOT accept programId/projectId (D4 deferred to G03-05)", () => {
    expect(() =>
      CreateReformActionInputSchema.parse({
        proposalId: "x",
        title: "valid action title",
        programId: "prog_001",
      })
    ).toThrow();
  });
});

// ============================================================
// AddReformActionUpdateInputSchema
// ============================================================
describe("AddReformActionUpdateInputSchema", () => {
  it("accepts a valid update input", () => {
    const result = AddReformActionUpdateInputSchema.parse({
      actionId: "x",
      updateType: "progress",
      notes: "Action started on time; first deliverable drafted.",
      progressPercentage: 25,
    });
    expect(result.updateType).toBe("progress");
    expect(result.progressPercentage).toBe(25);
    expect(result.evidenceIds).toEqual([]); // default
  });

  it("rejects progressPercentage > 100", () => {
    expect(() =>
      AddReformActionUpdateInputSchema.parse({
        actionId: "x",
        updateType: "progress",
        notes: "valid notes",
        progressPercentage: 150,
      })
    ).toThrow();
  });

  it("rejects progressPercentage < 0", () => {
    expect(() =>
      AddReformActionUpdateInputSchema.parse({
        actionId: "x",
        updateType: "progress",
        notes: "valid notes",
        progressPercentage: -1,
      })
    ).toThrow();
  });

  it("accepts all 5 update types", () => {
    for (const t of ["progress", "blocker", "milestone", "evidence", "note"]) {
      const result = AddReformActionUpdateInputSchema.parse({
        actionId: "x",
        updateType: t,
        notes: "valid notes",
      });
      expect(result.updateType).toBe(t);
    }
  });
});

// ============================================================
// VerifyReformActionInputSchema — F6 superRefine
// ============================================================
describe("VerifyReformActionInputSchema — F6 enforcement", () => {
  it("accepts verified with verifiedAction + evidenceSource", () => {
    const result = VerifyReformActionInputSchema.parse({
      actionId: "x",
      verificationStatus: "verified",
      verifiedAction:
        "Action #A1 mandate published in gazette on 2025-03-15; verified via gazette archive URL",
      evidenceSource: "gazette-2025-03-15.pdf",
    });
    expect(result.verificationStatus).toBe("verified");
  });

  it("rejects verified WITHOUT verifiedAction", () => {
    const result = VerifyReformActionInputSchema.safeParse({
      actionId: "x",
      verificationStatus: "verified",
      evidenceSource: "src",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.path.join("."));
      expect(issues).toContain("verifiedAction");
    }
  });

  it("rejects verified WITHOUT evidenceSource", () => {
    const result = VerifyReformActionInputSchema.safeParse({
      actionId: "x",
      verificationStatus: "verified",
      verifiedAction: "valid specific action description here",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.path.join("."));
      expect(issues).toContain("evidenceSource");
    }
  });

  it("rejects verified with verifiedAction < 10 chars", () => {
    const result = VerifyReformActionInputSchema.safeParse({
      actionId: "x",
      verificationStatus: "verified",
      verifiedAction: "short", // 5 chars
      evidenceSource: "valid-source",
    });
    expect(result.success).toBe(false);
  });

  it("accepts disputed with disputeReason + disputeEvidenceSource", () => {
    const result = VerifyReformActionInputSchema.parse({
      actionId: "x",
      verificationStatus: "disputed",
      disputeReason: "Action was reported complete but no gazette publication found.",
      disputeEvidenceSource: "audit-team-report-2025-04.pdf",
    });
    expect(result.verificationStatus).toBe("disputed");
  });

  it("rejects disputed WITHOUT disputeReason", () => {
    const result = VerifyReformActionInputSchema.safeParse({
      actionId: "x",
      verificationStatus: "disputed",
      disputeEvidenceSource: "src",
    });
    expect(result.success).toBe(false);
  });

  it("accepts pending without any F6 fields (initial state)", () => {
    const result = VerifyReformActionInputSchema.parse({
      actionId: "x",
      verificationStatus: "pending",
    });
    expect(result.verificationStatus).toBe("pending");
  });
});

// ============================================================
// CreateReformFeedbackLoopInputSchema — descriptive-only
// ============================================================
describe("CreateReformFeedbackLoopInputSchema — causal language rejection", () => {
  const validBase = {
    actionId: "x",
    descriptiveSummary:
      "The action was implemented on 2025-03-15; observation #X1 recorded inflation at 4.2% on 2025-04-30.",
  };

  it("accepts a descriptive summary without causal language", () => {
    const result = CreateReformFeedbackLoopInputSchema.parse(validBase);
    // attributionLevel is NOT in the schema — service hardcodes it to "descriptive".
    // The DB trigger enforces it at the row level.
    expect(result).toBeDefined();
  });

  it("rejects 'caused' as causal language", () => {
    const result = CreateReformFeedbackLoopInputSchema.safeParse({
      ...validBase,
      descriptiveSummary:
        "The action caused inflation to decrease from 5% to 4%.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 'as a result of' as causal language", () => {
    const result = CreateReformFeedbackLoopInputSchema.safeParse({
      ...validBase,
      descriptiveSummary:
        "As a result of the action, the indicator improved.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 'the impact of'", () => {
    const result = CreateReformFeedbackLoopInputSchema.safeParse({
      ...validBase,
      descriptiveSummary:
        "The impact of the reform was a 1pp reduction in inflation.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 'due to'", () => {
    const result = CreateReformFeedbackLoopInputSchema.safeParse({
      ...validBase,
      descriptiveSummary:
        "Due to the action, the metric improved by 1pp.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 'because of'", () => {
    const result = CreateReformFeedbackLoopInputSchema.safeParse({
      ...validBase,
      descriptiveSummary:
        "Because of the action, the metric improved by 1pp.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 'led to' / 'lead to'", () => {
    const result = CreateReformFeedbackLoopInputSchema.safeParse({
      ...validBase,
      descriptiveSummary:
        "The action led to a reduction in inflation of 1pp.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 'resulted in'", () => {
    const result = CreateReformFeedbackLoopInputSchema.safeParse({
      ...validBase,
      descriptiveSummary:
        "The reform resulted in a 1pp reduction in inflation.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 'contributed to'", () => {
    const result = CreateReformFeedbackLoopInputSchema.safeParse({
      ...validBase,
      descriptiveSummary:
        "The action contributed to a decrease in inflation.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 'attributable to'", () => {
    const result = CreateReformFeedbackLoopInputSchema.safeParse({
      ...validBase,
      descriptiveSummary:
        "The decrease is attributable to the action taken in March 2025.",
    });
    expect(result.success).toBe(false);
  });

  it("does NOT accept attributionLevel from client input (service hardcodes)", () => {
    const result = CreateReformFeedbackLoopInputSchema.safeParse({
      ...validBase,
      attributionLevel: "causal",
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional newAfterObservation", () => {
    const result = CreateReformFeedbackLoopInputSchema.parse({
      ...validBase,
      newAfterObservation: {
        indicatorDefinitionId: "ind_001",
        observationPeriodId: "period_001",
        observedValue: 4.2,
        originType: "observed",
        sourceId: "src_001",
        isSynthetic: false,
      },
    });
    expect(result.newAfterObservation?.indicatorDefinitionId).toBe("ind_001");
  });
});

// ============================================================
// CloseOriginatingAlertInputSchema
// ============================================================
describe("CloseOriginatingAlertInputSchema", () => {
  it("requires closureReason >= 20 chars", () => {
    expect(() =>
      CloseOriginatingAlertInputSchema.parse({
        proposalId: "x",
        closureReason: "short",
      })
    ).toThrow();
  });

  it("accepts a valid closure input", () => {
    const result = CloseOriginatingAlertInputSchema.parse({
      proposalId: "x",
      closureReason: "Reform action verified and feedback loop documented.",
    });
    expect(result.proposalId).toBe("x");
  });
});
