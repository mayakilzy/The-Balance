// ============================================================
// strategy-service.ts — Strategy + Version + Decision contracts
// ------------------------------------------------------------
// Handles:
//   - Creating strategies + versions
//   - Approving versions (immutable once approved)
//   - Creating decisions linked to evidence (snapshot at decision time)
//   - Decision lifecycle events (append-only audit trail)
// ============================================================
import { db } from "@/lib/db";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import { requirePermissionWithCurrentRole } from "@/lib/permissions";
import { writeAuditTx } from "@/lib/audit";  // 01-10: atomic audit write
import { NotFoundError } from "@/lib/reform/contracts";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

// ============================================================
// STRATEGY CREATION
// ============================================================

export async function createStrategy(
  session: Session,
  input: { title: string; description?: string; initialContent: string }
): Promise<{ strategyId: string; versionId: string }> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    await requirePermissionWithCurrentRole(session, "strategy:write");

    const strategy = await tx.strategy.create({
      data: {
        tenantId,
        title: input.title,
        description: input.description,
        status: "draft",
        createdBy: userId,
      },
    });

    // Create initial version (v1 draft)
    const version = await tx.strategyVersion.create({
      data: {
        strategyId: strategy.id,
        tenantId,
        versionNumber: 1,
        content: input.initialContent,
        status: "draft",
        createdBy: userId,
      },
    });

    // Record event
    await tx.event.create({
      data: {
        tenantId,
        eventType: "strategy.created",
        actor: userId,
        entityType: "strategy",
        entityId: strategy.id,
        metadata: { title: input.title, versionId: version.id } as Prisma.InputJsonValue,
      },
    });

    return { strategyId: strategy.id, versionId: version.id };
  });
}

// ============================================================
// STRATEGY VERSION CREATION (new version from existing)
// ============================================================

export async function createStrategyVersion(
  session: Session,
  strategyId: string,
  input: { content: string }
): Promise<{ versionId: string; versionNumber: number }> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    await requirePermissionWithCurrentRole(session, "strategy:write");

    // Get the latest version number
    const latestVersion = await tx.strategyVersion.findFirst({
      where: { strategyId, tenantId },
      orderBy: { versionNumber: "desc" },
    });
    if (!latestVersion) {
      throw new Error("Strategy not found or no versions exist");
    }

    const newVersionNumber = latestVersion.versionNumber + 1;

    const version = await tx.strategyVersion.create({
      data: {
        strategyId,
        tenantId,
        versionNumber: newVersionNumber,
        content: input.content,
        status: "draft",
        createdBy: userId,
      },
    });

    await tx.event.create({
      data: {
        tenantId,
        eventType: "strategy.version_created",
        actor: userId,
        entityType: "strategy_version",
        entityId: version.id,
        metadata: { strategyId, versionNumber: newVersionNumber } as Prisma.InputJsonValue,
      },
    });

    return { versionId: version.id, versionNumber: newVersionNumber };
  });
}

// ============================================================
// APPROVE STRATEGY VERSION (immutable once approved)
// ============================================================

export async function approveStrategyVersion(
  session: Session,
  versionId: string,
  approvalNotes?: string
): Promise<{ versionId: string; status: string; approvedBy: string }> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // Require strategy:approve permission (reviewer + admin)
    await requirePermissionWithCurrentRole(session, "strategy:approve");

    const version = await tx.strategyVersion.findFirst({
      where: { id: versionId, tenantId },
    });
    if (!version) {
      throw new Error("Strategy version not found in tenant scope");
    }
    if (version.status === "approved") {
      throw new Error("Version is already approved — approved versions are immutable");
    }

    // Mark this version as approved
    const approved = await tx.strategyVersion.update({
      where: { id: versionId },
      data: {
        status: "approved",
        approvedBy: userId,
        approvedAt: new Date(),
        approvalNotes,
      },
    });

    // Supersede any previously approved versions of this strategy
    await tx.strategyVersion.updateMany({
      where: {
        strategyId: version.strategyId,
        tenantId,
        status: "approved",
        id: { not: versionId },
      },
      data: { status: "superseded" },
    });

    // Update strategy status
    await tx.strategy.update({
      where: { id: version.strategyId },
      data: { status: "approved" },
    });

    // Record domain event (G00 behavior — domain timeline)
    await tx.event.create({
      data: {
        tenantId,
        eventType: "strategy.version_approved",
        actor: userId,
        entityType: "strategy_version",
        entityId: versionId,
        metadata: {
          strategyId: version.strategyId,
          versionNumber: version.versionNumber,
          approvalNotes: approvalNotes?.slice(0, 200),
        } as Prisma.InputJsonValue,
      },
    });

    // 01-10: ATOMIC audit_log write (per §13 Correction B)
    // This write is INSIDE the same transaction as the approval — if it fails,
    // the entire transaction rolls back (no approved version without audit).
    // This is the compliance-grade sovereign audit trail (independent from events).
    await writeAuditTx(tx, {
      tenantId,
      actor: userId,
      action: "strategy.version_approved",
      status: "ok",
      details: {
        strategyVersionId: approved.id,
        strategyId: version.strategyId,
        versionNumber: version.versionNumber,
        approvedBy: userId,
        approvalNotes: approvalNotes?.slice(0, 200),
      },
    });

    return {
      versionId: approved.id,
      status: approved.status,
      approvedBy: userId,
    };
  });
}

// ============================================================
// DECISION CREATION (linked to evidence — snapshot at decision time)
// ============================================================

export interface EvidenceSnapshot {
  evidenceId: string;
  claim: string;
  type: string;
  verificationStatus: string;
  sourceCode: string | null;
}

export async function createDecision(
  session: Session,
  input: {
    strategyVersionId?: string;
    title: string;
    rationale: string;
    supportingEvidenceIds?: string[];
    counterEvidenceIds?: string[];
  }
): Promise<{ decisionId: string }> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    await requirePermissionWithCurrentRole(session, "strategy:write");

    // Verify strategyVersionId belongs to same tenant (if provided)
    if (input.strategyVersionId) {
      const version = await tx.strategyVersion.findFirst({
        where: { id: input.strategyVersionId, tenantId },
      });
      if (!version) {
        throw new Error(
          `Strategy version ${input.strategyVersionId} not found in tenant scope — ` +
            "cannot link decision to a version from another tenant"
        );
      }
    }

    // EVIDENCE COMPLETENESS CHECK (founder directive 00-05 closure):
    // ALL requested evidence IDs must exist in tenant scope.
    // If any is missing or cross-tenant → reject the entire operation.
    let supportingSnapshots: EvidenceSnapshot[] = [];
    let counterSnapshots: EvidenceSnapshot[] = [];

    if (input.supportingEvidenceIds && input.supportingEvidenceIds.length > 0) {
      const evidence = await tx.evidence.findMany({
        where: {
          id: { in: input.supportingEvidenceIds },
          tenantId,
        },
        include: { source: { select: { code: true } } },
      });

      // VERIFY: all requested IDs were found
      if (evidence.length !== input.supportingEvidenceIds.length) {
        const found = new Set(evidence.map((e) => e.id));
        const missing = input.supportingEvidenceIds.filter((id) => !found.has(id));
        throw new Error(
          `Evidence completeness violation: ${missing.length} of ${input.supportingEvidenceIds.length} ` +
            `supporting evidence IDs not found in tenant scope. Missing: ${missing.join(", ")}. ` +
            "Decision creation rejected — no partial snapshots allowed."
        );
      }

      supportingSnapshots = evidence.map((e) => ({
        evidenceId: e.id,
        claim: e.claim,
        type: e.type,
        verificationStatus: e.verificationStatus,
        sourceCode: e.source?.code ?? null,
      }));
    }

    if (input.counterEvidenceIds && input.counterEvidenceIds.length > 0) {
      const evidence = await tx.evidence.findMany({
        where: {
          id: { in: input.counterEvidenceIds },
          tenantId,
        },
        include: { source: { select: { code: true } } },
      });

      // VERIFY: all requested IDs were found
      if (evidence.length !== input.counterEvidenceIds.length) {
        const found = new Set(evidence.map((e) => e.id));
        const missing = input.counterEvidenceIds.filter((id) => !found.has(id));
        throw new Error(
          `Evidence completeness violation: ${missing.length} of ${input.counterEvidenceIds.length} ` +
            `counter evidence IDs not found in tenant scope. Missing: ${missing.join(", ")}. ` +
            "Decision creation rejected — no partial snapshots allowed."
        );
      }

      counterSnapshots = evidence.map((e) => ({
        evidenceId: e.id,
        claim: e.claim,
        type: e.type,
        verificationStatus: e.verificationStatus,
        sourceCode: e.source?.code ?? null,
      }));
    }

    const decision = await tx.decision.create({
      data: {
        tenantId,
        strategyVersionId: input.strategyVersionId,
        title: input.title,
        rationale: input.rationale,
        decidedBy: userId,
        status: "proposed",
        supportingEvidence: supportingSnapshots as unknown as Prisma.InputJsonValue,
        counterEvidence: counterSnapshots as unknown as Prisma.InputJsonValue,
      },
    });

    // Record initial decision event (append-only)
    await tx.decisionEvent.create({
      data: {
        decisionId: decision.id,
        tenantId,
        eventType: "proposed",
        actor: userId,
        notes: `Decision proposed with ${supportingSnapshots.length} supporting and ${counterSnapshots.length} counter evidence items.`,
      },
    });

    return { decisionId: decision.id };
  });
}

// ============================================================
// DECISION STATE TRANSITIONS (founder directive 00-05 closure)
// ============================================================
// Allowed transitions:
//   proposed → reviewed
//   reviewed → approved
//   reviewed → proposed (send back for revision)
//   approved → implemented
//   approved → reversed
//   reversed → proposed (re-proposal, rare)
// All other transitions are rejected.
const VALID_TRANSITIONS: Record<string, string[]> = {
  proposed: ["reviewed"],
  reviewed: ["approved", "proposed"],
  approved: ["implemented", "reversed"],
  implemented: ["reversed"],
  reversed: ["proposed"],
};

function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

// ============================================================
// DECISION LIFECYCLE EVENTS
// ============================================================

export async function advanceDecision(
  session: Session,
  decisionId: string,
  newStatus: "reviewed" | "approved" | "implemented" | "reversed",
  notes?: string
): Promise<{ decisionId: string; status: string }> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId, userId }) => {
    // Approving a decision requires strategy:approve
    if (newStatus === "approved") {
      await requirePermissionWithCurrentRole(session, "strategy:approve");
    } else {
      await requirePermissionWithCurrentRole(session, "strategy:write");
    }

    const decision = await tx.decision.findFirst({
      where: { id: decisionId, tenantId },
    });
    if (!decision) {
      throw new NotFoundError("Decision not found in tenant scope");
    }

    // VALIDATE TRANSITION (founder directive 00-05 closure)
    if (!isValidTransition(decision.status, newStatus)) {
      throw new Error(
        `Invalid decision state transition: ${decision.status} → ${newStatus}. ` +
          `Allowed transitions from '${decision.status}': ${(VALID_TRANSITIONS[decision.status] ?? []).join(", ")}`
      );
    }

    const updated = await tx.decision.update({
      where: { id: decisionId },
      data: { status: newStatus },
    });

    // Record event (append-only — RLS blocks UPDATE/DELETE)
    await tx.decisionEvent.create({
      data: {
        decisionId,
        tenantId,
        eventType: newStatus,
        actor: userId,
        notes,
      },
    });

    return { decisionId: updated.id, status: updated.status };
  });
}

// ============================================================
// GET DECISION WITH EVIDENCE SNAPSHOT + EVENT TRAIL
// ============================================================

export async function getDecisionDetail(
  session: Session,
  decisionId: string
): Promise<{
  decision: {
    id: string;
    title: string;
    rationale: string;
    status: string;
    decidedBy: string;
    decidedAt: Date;
    supportingEvidence: EvidenceSnapshot[];
    counterEvidence: EvidenceSnapshot[];
  };
  events: Array<{
    id: string;
    eventType: string;
    actor: string;
    at: Date;
    notes: string | null;
  }>;
}> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    await requirePermissionWithCurrentRole(session, "strategy:read");

    const decision = await tx.decision.findFirst({
      where: { id: decisionId, tenantId },
    });
    if (!decision) {
      throw new NotFoundError("Decision not found");
    }

    const events = await tx.decisionEvent.findMany({
      where: { decisionId, tenantId },
      orderBy: { at: "asc" },
    });

    return {
      decision: {
        id: decision.id,
        title: decision.title,
        rationale: decision.rationale,
        status: decision.status,
        decidedBy: decision.decidedBy,
        decidedAt: decision.decidedAt,
        supportingEvidence: decision.supportingEvidence as unknown as EvidenceSnapshot[],
        counterEvidence: decision.counterEvidence as unknown as EvidenceSnapshot[],
      },
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        actor: e.actor,
        at: e.at,
        notes: e.notes,
      })),
    };
  });
}
