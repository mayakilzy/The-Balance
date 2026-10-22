-- The Balance — Migration 0022: G03 State Reform Bootstrap
-- Mission 03-01: G03 Schema Bootstrap & Security Foundation
--
-- This migration creates 12 new PRIVATE tables (all tenant-scoped, RLS ENABLE + FORCE):
--   Core reform (7):
--     a. reform_proposals              — top-level reform container
--     b. reform_alternatives           — multiple options per proposal
--     c. reform_approvals             — atomic approval + evidence snapshot (immutable)
--     d. reform_actions                — implementation tracking
--     e. reform_action_updates        — append-only progress log
--     f. reform_verifications         — F6-pattern execution verification
--     g. reform_feedback_loops        — descriptive outcome measurement (attributionLevel="descriptive")
--
--   Coordination (5):
--     h. reform_coordinations                       — coordination metadata (lead tenant + participants)
--     i. reform_coordination_participants           — M:N coordination↔tenant
--     j. reform_coordination_invitations            — pending invitations (append-only)
--     k. reform_coordination_shared_snapshots       — explicitly shared, reviewer-approved snapshots
--     l. reform_coordination_shared_snapshot_revocations — append-only revocations
--
-- Per G03-00 FINAL PASS (REV 8 — frozen):
--   - SECURITY INVOKER for visibility checks (is_coordination_participant, is_snapshot_revoked)
--   - SECURITY DEFINER for administrative cross-tenant UPDATE only (remove_coordination_participant, etc.)
--   - C1 FIX: balance_coordination_admin has SELECT + UPDATE on participants (PostgreSQL requires SELECT for WHERE)
--   - C2 LIMITATION: set_config('app.tenant_id') is NOT a DB-level identity guarantee
--   - D5: Four distinct lifecycle states (approval / implementation / verification / measurement)
--   - D11: Supersession preserves historical links (no silent rewrite)
--   - D12: Shared snapshots support draft mode (draft → under_review → approved → revoked)
--   - D15: Institutional authority separation (claimed vs verified vs participation vs approval)
--
-- All 12 new tables are PRIVATE (tenant-scoped). No PUBLIC tables are created.

-- ============================================================
-- 1. CREATE TABLES
-- ============================================================

-- 1a. reform_proposals
CREATE TABLE "reform_proposals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "originatingAlertId" TEXT,
    "originatingVarianceRecordId" TEXT,
    "strategyVersionId" TEXT,
    "objectiveId" TEXT,
    "coordinationId" TEXT,
    "title" TEXT NOT NULL,
    "problemStatement" TEXT NOT NULL,
    "hypothesizedCauses" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "context" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "archivedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "reform_proposals_pkey" PRIMARY KEY ("id")
);

-- 1b. reform_alternatives
CREATE TABLE "reform_alternatives" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "costEstimateMin" DECIMAL(20,2),
    "costEstimateMax" DECIMAL(20,2),
    "costCurrency" TEXT NOT NULL DEFAULT 'USD',
    "costAssumptions" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "riskLevel" TEXT NOT NULL DEFAULT 'medium',
    "riskNotes" TEXT,
    "feasibilityScore" TEXT NOT NULL DEFAULT 'unknown',
    "feasibilityNotes" TEXT,
    "anticipatedOutcomes" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "assumptions" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "selectedAt" TIMESTAMP(3),
    "selectedBy" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnBy" TEXT,
    "withdrawalReason" TEXT,
    "draftedVia" TEXT NOT NULL DEFAULT 'human',
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reform_alternatives_pkey" PRIMARY KEY ("id")
);

-- 1c. reform_approvals (immutable post-approval — RLS blocks UPDATE/DELETE)
CREATE TABLE "reform_approvals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "alternativeId" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvalNotes" TEXT,
    "supportingEvidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "counterEvidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "rationale" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "reform_approvals_pkey" PRIMARY KEY ("id")
);

-- 1d. reform_actions
CREATE TABLE "reform_actions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "alternativeId" TEXT NOT NULL,
    "programId" TEXT,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assignedTo" TEXT,
    "assignedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'planned',
    "startDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "completedDate" TIMESTAMP(3),
    "cancelledDate" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancellationReason" TEXT,
    "progressPercentage" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reform_actions_pkey" PRIMARY KEY ("id")
);

-- 1e. reform_action_updates (append-only — RLS blocks UPDATE/DELETE)
CREATE TABLE "reform_action_updates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "updateType" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "progressPercentage" INTEGER,
    "evidenceIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "reform_action_updates_pkey" PRIMARY KEY ("id")
);

-- 1f. reform_verifications
CREATE TABLE "reform_verifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL DEFAULT 'pending',
    "verifiedAction" TEXT,
    "evidenceSource" TEXT,
    "disputeReason" TEXT,
    "disputeEvidenceSource" TEXT,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "notes" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reform_verifications_pkey" PRIMARY KEY ("id")
);

-- 1g. reform_feedback_loops (immutable — RLS blocks UPDATE/DELETE)
CREATE TABLE "reform_feedback_loops" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "beforeObservationId" TEXT,
    "afterObservationId" TEXT,
    "comparisonType" TEXT NOT NULL DEFAULT 'none',
    "descriptiveSummary" TEXT NOT NULL,
    "attributionLevel" TEXT NOT NULL DEFAULT 'descriptive',
    "newVarianceRecordId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "reform_feedback_loops_pkey" PRIMARY KEY ("id")
);

-- 1h. reform_coordinations
CREATE TABLE "reform_coordinations" (
    "id" TEXT NOT NULL,
    "leadTenantId" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "originatingAlertId" TEXT,
    "originatingVarianceRecordId" TEXT,
    "approvalPolicy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "planSubmittedAt" TIMESTAMP(3),
    "planApprovedAt" TIMESTAMP(3),
    "planApprovedBy" TEXT,
    "activatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "closureReason" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "reform_coordinations_pkey" PRIMARY KEY ("id")
);

-- 1i. reform_coordination_participants
CREATE TABLE "reform_coordination_participants" (
    "id" TEXT NOT NULL,
    "coordinationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "institutionId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'contributor',
    "status" TEXT NOT NULL DEFAULT 'pending_invitation',
    "joinedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,
    "removalReason" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawalReason" TEXT,
    "verifiedInstitutionId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "verificationMethod" TEXT,
    "verificationNotes" TEXT,
    "canApproveCommitments" BOOLEAN NOT NULL DEFAULT false,
    "approvalAuthorityGrantedBy" TEXT,
    "approvalAuthorityGrantedAt" TIMESTAMP(3),
    "approvalAuthorityReason" TEXT,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "reform_coordination_participants_pkey" PRIMARY KEY ("id")
);

-- 1j. reform_coordination_invitations (append-only — DELETE blocked)
CREATE TABLE "reform_coordination_invitations" (
    "id" TEXT NOT NULL,
    "coordinationId" TEXT NOT NULL,
    "invitedTenantId" TEXT NOT NULL,
    "invitedInstitutionId" TEXT,
    "invitedRole" TEXT NOT NULL DEFAULT 'contributor',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedBy" TEXT,
    "declinedAt" TIMESTAMP(3),
    "declinedBy" TEXT,
    "declinedReason" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revocationReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "reform_coordination_invitations_pkey" PRIMARY KEY ("id")
);

-- 1k. reform_coordination_shared_snapshots
CREATE TABLE "reform_coordination_shared_snapshots" (
    "id" TEXT NOT NULL,
    "coordinationId" TEXT NOT NULL,
    "ownerTenantId" TEXT NOT NULL,
    "snapshotType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "classification" TEXT NOT NULL DEFAULT 'shared_within_coordination',
    "proposalId" TEXT,
    "actionId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "reform_coordination_shared_snapshots_pkey" PRIMARY KEY ("id")
);

-- 1l. reform_coordination_shared_snapshot_revocations (append-only)
CREATE TABLE "reform_coordination_shared_snapshot_revocations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "coordinationId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "revokedBy" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "reform_coordination_shared_snapshot_revocations_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- 2. FOREIGN KEYS
-- ============================================================

-- reform_proposals
ALTER TABLE "reform_proposals" ADD CONSTRAINT "reform_proposals_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "reform_proposals" ADD CONSTRAINT "reform_proposals_originatingAlertId_fkey"
    FOREIGN KEY ("originatingAlertId") REFERENCES "alerts"("id") ON DELETE SET NULL;
ALTER TABLE "reform_proposals" ADD CONSTRAINT "reform_proposals_originatingVarianceRecordId_fkey"
    FOREIGN KEY ("originatingVarianceRecordId") REFERENCES "variance_records"("id") ON DELETE SET NULL;
ALTER TABLE "reform_proposals" ADD CONSTRAINT "reform_proposals_strategyVersionId_fkey"
    FOREIGN KEY ("strategyVersionId") REFERENCES "strategy_versions"("id") ON DELETE SET NULL;
ALTER TABLE "reform_proposals" ADD CONSTRAINT "reform_proposals_objectiveId_fkey"
    FOREIGN KEY ("objectiveId") REFERENCES "objectives"("id") ON DELETE SET NULL;
ALTER TABLE "reform_proposals" ADD CONSTRAINT "reform_proposals_coordinationId_fkey"
    FOREIGN KEY ("coordinationId") REFERENCES "reform_coordinations"("id") ON DELETE SET NULL;
ALTER TABLE "reform_proposals" ADD CONSTRAINT "reform_proposals_supersededById_fkey"
    FOREIGN KEY ("supersededById") REFERENCES "reform_proposals"("id") ON DELETE SET NULL;

-- reform_alternatives
ALTER TABLE "reform_alternatives" ADD CONSTRAINT "reform_alternatives_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "reform_alternatives" ADD CONSTRAINT "reform_alternatives_proposalId_fkey"
    FOREIGN KEY ("proposalId") REFERENCES "reform_proposals"("id") ON DELETE CASCADE;

-- reform_approvals
ALTER TABLE "reform_approvals" ADD CONSTRAINT "reform_approvals_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "reform_approvals" ADD CONSTRAINT "reform_approvals_proposalId_fkey"
    FOREIGN KEY ("proposalId") REFERENCES "reform_proposals"("id") ON DELETE CASCADE;
ALTER TABLE "reform_approvals" ADD CONSTRAINT "reform_approvals_alternativeId_fkey"
    FOREIGN KEY ("alternativeId") REFERENCES "reform_alternatives"("id") ON DELETE CASCADE;

-- reform_actions
ALTER TABLE "reform_actions" ADD CONSTRAINT "reform_actions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "reform_actions" ADD CONSTRAINT "reform_actions_proposalId_fkey"
    FOREIGN KEY ("proposalId") REFERENCES "reform_proposals"("id") ON DELETE CASCADE;
ALTER TABLE "reform_actions" ADD CONSTRAINT "reform_actions_alternativeId_fkey"
    FOREIGN KEY ("alternativeId") REFERENCES "reform_alternatives"("id") ON DELETE CASCADE;
ALTER TABLE "reform_actions" ADD CONSTRAINT "reform_actions_programId_fkey"
    FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE SET NULL;
ALTER TABLE "reform_actions" ADD CONSTRAINT "reform_actions_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL;

-- reform_action_updates
ALTER TABLE "reform_action_updates" ADD CONSTRAINT "reform_action_updates_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "reform_action_updates" ADD CONSTRAINT "reform_action_updates_actionId_fkey"
    FOREIGN KEY ("actionId") REFERENCES "reform_actions"("id") ON DELETE CASCADE;

-- reform_verifications
ALTER TABLE "reform_verifications" ADD CONSTRAINT "reform_verifications_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "reform_verifications" ADD CONSTRAINT "reform_verifications_actionId_fkey"
    FOREIGN KEY ("actionId") REFERENCES "reform_actions"("id") ON DELETE CASCADE;

-- reform_feedback_loops
ALTER TABLE "reform_feedback_loops" ADD CONSTRAINT "reform_feedback_loops_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "reform_feedback_loops" ADD CONSTRAINT "reform_feedback_loops_actionId_fkey"
    FOREIGN KEY ("actionId") REFERENCES "reform_actions"("id") ON DELETE CASCADE;

-- reform_coordinations
ALTER TABLE "reform_coordinations" ADD CONSTRAINT "reform_coordinations_leadTenantId_fkey"
    FOREIGN KEY ("leadTenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "reform_coordinations" ADD CONSTRAINT "reform_coordinations_countryId_fkey"
    FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT;
ALTER TABLE "reform_coordinations" ADD CONSTRAINT "reform_coordinations_originatingAlertId_fkey"
    FOREIGN KEY ("originatingAlertId") REFERENCES "alerts"("id") ON DELETE SET NULL;
ALTER TABLE "reform_coordinations" ADD CONSTRAINT "reform_coordinations_originatingVarianceRecordId_fkey"
    FOREIGN KEY ("originatingVarianceRecordId") REFERENCES "variance_records"("id") ON DELETE SET NULL;
ALTER TABLE "reform_coordinations" ADD CONSTRAINT "reform_coordinations_supersededById_fkey"
    FOREIGN KEY ("supersededById") REFERENCES "reform_coordinations"("id") ON DELETE SET NULL;

-- reform_coordination_participants
ALTER TABLE "reform_coordination_participants" ADD CONSTRAINT "reform_coord_participants_coordId_fkey"
    FOREIGN KEY ("coordinationId") REFERENCES "reform_coordinations"("id") ON DELETE CASCADE;
ALTER TABLE "reform_coordination_participants" ADD CONSTRAINT "reform_coord_participants_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;

-- reform_coordination_invitations
ALTER TABLE "reform_coordination_invitations" ADD CONSTRAINT "reform_coord_invitations_coordId_fkey"
    FOREIGN KEY ("coordinationId") REFERENCES "reform_coordinations"("id") ON DELETE CASCADE;

-- reform_coordination_shared_snapshots
ALTER TABLE "reform_coordination_shared_snapshots" ADD CONSTRAINT "reform_coord_snapshots_coordId_fkey"
    FOREIGN KEY ("coordinationId") REFERENCES "reform_coordinations"("id") ON DELETE CASCADE;
ALTER TABLE "reform_coordination_shared_snapshots" ADD CONSTRAINT "reform_coord_snapshots_ownerTenantId_fkey"
    FOREIGN KEY ("ownerTenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "reform_coordination_shared_snapshots" ADD CONSTRAINT "reform_coord_snapshots_proposalId_fkey"
    FOREIGN KEY ("proposalId") REFERENCES "reform_proposals"("id") ON DELETE SET NULL;
ALTER TABLE "reform_coordination_shared_snapshots" ADD CONSTRAINT "reform_coord_snapshots_actionId_fkey"
    FOREIGN KEY ("actionId") REFERENCES "reform_actions"("id") ON DELETE SET NULL;

-- reform_coordination_shared_snapshot_revocations
ALTER TABLE "reform_coordination_shared_snapshot_revocations" ADD CONSTRAINT "reform_coord_revocations_snapshotId_fkey"
    FOREIGN KEY ("snapshotId") REFERENCES "reform_coordination_shared_snapshots"("id") ON DELETE CASCADE;

-- ============================================================
-- 3. UNIQUE CONSTRAINTS
-- ============================================================

CREATE UNIQUE INDEX "reform_alternatives_tenantId_proposalId_title_key"
    ON "reform_alternatives"("tenantId", "proposalId", "title");
CREATE UNIQUE INDEX "reform_approvals_proposalId_key"
    ON "reform_approvals"("proposalId");
CREATE UNIQUE INDEX "reform_approvals_tenantId_proposalId_key"
    ON "reform_approvals"("tenantId", "proposalId");
CREATE UNIQUE INDEX "reform_verifications_actionId_key"
    ON "reform_verifications"("actionId");
CREATE UNIQUE INDEX "reform_verifications_tenantId_actionId_key"
    ON "reform_verifications"("tenantId", "actionId");
CREATE UNIQUE INDEX "reform_feedback_loops_actionId_key"
    ON "reform_feedback_loops"("actionId");
CREATE UNIQUE INDEX "reform_feedback_loops_tenantId_actionId_key"
    ON "reform_feedback_loops"("tenantId", "actionId");
CREATE UNIQUE INDEX "reform_coordination_participants_coordId_tenantId_key"
    ON "reform_coordination_participants"("coordinationId", "tenantId");

-- Partial unique index: only ONE selected alternative per proposal
CREATE UNIQUE INDEX "reform_alternatives_one_selected_per_proposal"
    ON "reform_alternatives"("tenantId", "proposalId")
    WHERE "status" = 'selected';

-- One revocation per snapshot
CREATE UNIQUE INDEX "reform_coord_revocations_snapshotId_key"
    ON "reform_coordination_shared_snapshot_revocations"("snapshotId");

-- ============================================================
-- 4. INDEXES
-- ============================================================

CREATE INDEX "reform_proposals_tenantId_status_idx" ON "reform_proposals"("tenantId", "status");
CREATE INDEX "reform_proposals_tenantId_originatingAlertId_idx" ON "reform_proposals"("tenantId", "originatingAlertId");
CREATE INDEX "reform_proposals_tenantId_strategyVersionId_idx" ON "reform_proposals"("tenantId", "strategyVersionId");
CREATE INDEX "reform_proposals_tenantId_objectiveId_idx" ON "reform_proposals"("tenantId", "objectiveId");
CREATE INDEX "reform_proposals_tenantId_createdAt_idx" ON "reform_proposals"("tenantId", "createdAt");
CREATE INDEX "reform_proposals_coordinationId_idx" ON "reform_proposals"("coordinationId");

CREATE INDEX "reform_alternatives_tenantId_proposalId_status_idx" ON "reform_alternatives"("tenantId", "proposalId", "status");

CREATE INDEX "reform_approvals_tenantId_approvedAt_idx" ON "reform_approvals"("tenantId", "approvedAt");

CREATE INDEX "reform_actions_tenantId_proposalId_status_idx" ON "reform_actions"("tenantId", "proposalId", "status");
CREATE INDEX "reform_actions_tenantId_assignedTo_status_idx" ON "reform_actions"("tenantId", "assignedTo", "status");
CREATE INDEX "reform_actions_tenantId_status_dueDate_idx" ON "reform_actions"("tenantId", "status", "dueDate");
CREATE INDEX "reform_actions_tenantId_programId_idx" ON "reform_actions"("tenantId", "programId");
CREATE INDEX "reform_actions_tenantId_projectId_idx" ON "reform_actions"("tenantId", "projectId");

CREATE INDEX "reform_action_updates_actionId_at_idx" ON "reform_action_updates"("actionId", "at");
CREATE INDEX "reform_action_updates_tenantId_at_idx" ON "reform_action_updates"("tenantId", "at");
CREATE INDEX "reform_action_updates_tenantId_actionId_updateType_idx" ON "reform_action_updates"("tenantId", "actionId", "updateType");

CREATE INDEX "reform_verifications_tenantId_verificationStatus_idx" ON "reform_verifications"("tenantId", "verificationStatus");
CREATE INDEX "reform_verifications_tenantId_verifiedAt_idx" ON "reform_verifications"("tenantId", "verifiedAt");

CREATE INDEX "reform_feedback_loops_tenantId_createdAt_idx" ON "reform_feedback_loops"("tenantId", "createdAt");

CREATE INDEX "reform_coordinations_leadTenantId_status_idx" ON "reform_coordinations"("leadTenantId", "status");
CREATE INDEX "reform_coordinations_countryId_status_idx" ON "reform_coordinations"("countryId", "status");
CREATE INDEX "reform_coordinations_originatingAlertId_idx" ON "reform_coordinations"("originatingAlertId");

CREATE INDEX "reform_coordination_participants_tenantId_status_idx" ON "reform_coordination_participants"("tenantId", "status");

CREATE INDEX "reform_coordination_invitations_coordinationId_status_idx" ON "reform_coordination_invitations"("coordinationId", "status");
CREATE INDEX "reform_coordination_invitations_invitedTenantId_status_idx" ON "reform_coordination_invitations"("invitedTenantId", "status");
CREATE INDEX "reform_coordination_invitations_expiresAt_idx" ON "reform_coordination_invitations"("expiresAt");

CREATE INDEX "reform_coordination_shared_snapshots_coordinationId_status_idx" ON "reform_coordination_shared_snapshots"("coordinationId", "status");
CREATE INDEX "reform_coordination_shared_snapshots_ownerTenantId_status_idx" ON "reform_coordination_shared_snapshots"("ownerTenantId", "status");

CREATE INDEX "reform_coordination_shared_snapshot_revocations_coordinationId_idx" ON "reform_coordination_shared_snapshot_revocations"("coordinationId");

-- ============================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================

-- Enable + Force RLS on all 12 new tables
ALTER TABLE "reform_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_proposals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reform_alternatives" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_alternatives" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reform_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_approvals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reform_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_actions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reform_action_updates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_action_updates" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reform_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_verifications" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reform_feedback_loops" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_feedback_loops" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reform_coordinations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_coordinations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reform_coordination_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_coordination_participants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reform_coordination_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_coordination_invitations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reform_coordination_shared_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_coordination_shared_snapshots" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reform_coordination_shared_snapshot_revocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_coordination_shared_snapshot_revocations" FORCE ROW LEVEL SECURITY;

-- ============================================================
-- 6. RLS POLICIES — balance_app (standard tenant isolation for 7 core tables)
-- ============================================================

-- reform_proposals
CREATE POLICY "reform_proposals_tenant_isolation" ON "reform_proposals"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_proposals_admin_all" ON "reform_proposals"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- reform_alternatives
CREATE POLICY "reform_alternatives_tenant_isolation" ON "reform_alternatives"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_alternatives_admin_all" ON "reform_alternatives"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- reform_approvals (immutable post-approval: INSERT + SELECT only, NO UPDATE/DELETE)
CREATE POLICY "reform_approvals_tenant_isolation" ON "reform_approvals"
    FOR SELECT TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_approvals_tenant_insert" ON "reform_approvals"
    FOR INSERT TO balance_app
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
-- NOTE: No UPDATE or DELETE policy → RLS denies by default (immutable post-approval)
CREATE POLICY "reform_approvals_admin_all" ON "reform_approvals"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- reform_actions
CREATE POLICY "reform_actions_tenant_isolation" ON "reform_actions"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_actions_admin_all" ON "reform_actions"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- reform_action_updates (append-only: INSERT + SELECT only, NO UPDATE/DELETE)
CREATE POLICY "reform_action_updates_tenant_select" ON "reform_action_updates"
    FOR SELECT TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_action_updates_tenant_insert" ON "reform_action_updates"
    FOR INSERT TO balance_app
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
-- NOTE: No UPDATE or DELETE policy → append-only enforced by RLS
CREATE POLICY "reform_action_updates_admin_all" ON "reform_action_updates"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- reform_verifications
CREATE POLICY "reform_verifications_tenant_isolation" ON "reform_verifications"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_verifications_admin_all" ON "reform_verifications"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- reform_feedback_loops (immutable: INSERT + SELECT only, NO UPDATE/DELETE)
CREATE POLICY "reform_feedback_loops_tenant_select" ON "reform_feedback_loops"
    FOR SELECT TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_feedback_loops_tenant_insert" ON "reform_feedback_loops"
    FOR INSERT TO balance_app
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
-- NOTE: No UPDATE or DELETE policy → immutable enforced by RLS
CREATE POLICY "reform_feedback_loops_admin_all" ON "reform_feedback_loops"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- ============================================================
-- 6b. HELPER FUNCTIONS — SECURITY INVOKER (visibility checks)
-- ============================================================
-- Must be created BEFORE coordination RLS policies that reference them.

-- is_coordination_participant: returns TRUE if current tenant is active participant
CREATE OR REPLACE FUNCTION public.is_coordination_participant(p_coordination_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.reform_coordination_participants
        WHERE "coordinationId" = p_coordination_id
          AND "tenantId" = current_setting('app.tenant_id', true)
          AND "status" = 'active'
    );
$$;
GRANT EXECUTE ON FUNCTION public.is_coordination_participant(TEXT) TO balance_app;
GRANT EXECUTE ON FUNCTION public.is_coordination_participant(TEXT) TO balance_admin;

-- is_snapshot_revoked: returns TRUE if snapshot has a revocation record
CREATE OR REPLACE FUNCTION public.is_snapshot_revoked(p_snapshot_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.reform_coordination_shared_snapshot_revocations
        WHERE "snapshotId" = p_snapshot_id
    );
$$;
GRANT EXECUTE ON FUNCTION public.is_snapshot_revoked(TEXT) TO balance_app;
GRANT EXECUTE ON FUNCTION public.is_snapshot_revoked(TEXT) TO balance_admin;

-- ============================================================

-- 7. RLS POLICIES — Coordination tables (coordination-aware)
-- ============================================================

-- reform_coordinations: visible to lead OR active participant
CREATE POLICY "reform_coordinations_select_app" ON "reform_coordinations"
    FOR SELECT TO balance_app
    USING (
        "leadTenantId" = current_setting('app.tenant_id', true)
        OR public.is_coordination_participant("id"::text)
    );
CREATE POLICY "reform_coordinations_insert_app" ON "reform_coordinations"
    FOR INSERT TO balance_app
    WITH CHECK ("leadTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_coordinations_update_app" ON "reform_coordinations"
    FOR UPDATE TO balance_app
    USING ("leadTenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("leadTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_coordinations_admin_all" ON "reform_coordinations"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- reform_coordination_participants: own row only for SELECT
CREATE POLICY "reform_coord_participants_select_app" ON "reform_coordination_participants"
    FOR SELECT TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_coord_participants_insert_app" ON "reform_coordination_participants"
    FOR INSERT TO balance_app
    WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)
        AND EXISTS (
            SELECT 1 FROM "reform_coordinations" c
            WHERE c."id" = "coordinationId"
              AND c."leadTenantId" = current_setting('app.tenant_id', true)
        )
    );
CREATE POLICY "reform_coord_participants_update_app" ON "reform_coordination_participants"
    FOR UPDATE TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_coord_participants_admin_all" ON "reform_coordination_participants"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- reform_coordination_invitations: visible to recipient OR lead
CREATE POLICY "reform_coord_invitations_select_app" ON "reform_coordination_invitations"
    FOR SELECT TO balance_app
    USING (
        "invitedTenantId" = current_setting('app.tenant_id', true)
        OR EXISTS (
            SELECT 1 FROM "reform_coordinations" c
            WHERE c."id" = "coordinationId"
              AND c."leadTenantId" = current_setting('app.tenant_id', true)
        )
    );
CREATE POLICY "reform_coord_invitations_insert_app" ON "reform_coordination_invitations"
    FOR INSERT TO balance_app
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM "reform_coordinations" c
            WHERE c."id" = "coordinationId"
              AND c."leadTenantId" = current_setting('app.tenant_id', true)
        )
    );
CREATE POLICY "reform_coord_invitations_update_app" ON "reform_coordination_invitations"
    FOR UPDATE TO balance_app
    USING ("invitedTenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("invitedTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_coord_invitations_admin_all" ON "reform_coordination_invitations"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- reform_coordination_shared_snapshots: owner sees all; others see approved + non-revoked
CREATE POLICY "reform_coord_snapshots_select_app" ON "reform_coordination_shared_snapshots"
    FOR SELECT TO balance_app
    USING (
        "ownerTenantId" = current_setting('app.tenant_id', true)
        OR (
            "approvedAt" IS NOT NULL
            AND public.is_coordination_participant("coordinationId"::text)
            AND NOT public.is_snapshot_revoked("id"::text)
        )
    );
CREATE POLICY "reform_coord_snapshots_insert_app" ON "reform_coordination_shared_snapshots"
    FOR INSERT TO balance_app
    WITH CHECK ("ownerTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_coord_snapshots_update_app" ON "reform_coordination_shared_snapshots"
    FOR UPDATE TO balance_app
    USING ("ownerTenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("ownerTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "reform_coord_snapshots_admin_all" ON "reform_coordination_shared_snapshots"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- reform_coordination_shared_snapshot_revocations: append-only (INSERT + SELECT)
CREATE POLICY "reform_coord_revocations_select_app" ON "reform_coordination_shared_snapshot_revocations"
    FOR SELECT TO balance_app
    USING (
        "tenantId" = current_setting('app.tenant_id', true)
        OR public.is_coordination_participant("coordinationId"::text)
    );
CREATE POLICY "reform_coord_revocations_insert_app" ON "reform_coordination_shared_snapshot_revocations"
    FOR INSERT TO balance_app
    WITH CHECK (
        "tenantId" = current_setting('app.tenant_id', true)
        AND EXISTS (
            SELECT 1 FROM "reform_coordination_shared_snapshots" s
            WHERE s."id" = "snapshotId"
              AND s."ownerTenantId" = current_setting('app.tenant_id', true)
        )
    );
-- NOTE: No UPDATE or DELETE policy → append-only enforced by RLS
CREATE POLICY "reform_coord_revocations_admin_all" ON "reform_coordination_shared_snapshot_revocations"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- ============================================================
-- 8. GRANTS
-- ============================================================

-- Core tables: full DML for balance_app
GRANT SELECT, INSERT, UPDATE, DELETE ON "reform_proposals" TO balance_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "reform_alternatives" TO balance_app;
GRANT SELECT, INSERT ON "reform_approvals" TO balance_app;  -- immutable: no UPDATE/DELETE
GRANT SELECT, INSERT, UPDATE, DELETE ON "reform_actions" TO balance_app;
GRANT SELECT, INSERT ON "reform_action_updates" TO balance_app;  -- append-only
GRANT SELECT, INSERT, UPDATE ON "reform_verifications" TO balance_app;
GRANT SELECT, INSERT ON "reform_feedback_loops" TO balance_app;  -- immutable

-- Coordination tables
GRANT SELECT, INSERT, UPDATE ON "reform_coordinations" TO balance_app;
GRANT SELECT, INSERT, UPDATE ON "reform_coordination_participants" TO balance_app;
GRANT SELECT, INSERT, UPDATE ON "reform_coordination_invitations" TO balance_app;
GRANT SELECT, INSERT, UPDATE ON "reform_coordination_shared_snapshots" TO balance_app;
GRANT SELECT, INSERT ON "reform_coordination_shared_snapshot_revocations" TO balance_app;  -- append-only

-- balance_admin: full access
GRANT ALL ON "reform_proposals" TO balance_admin;
GRANT ALL ON "reform_alternatives" TO balance_admin;
GRANT ALL ON "reform_approvals" TO balance_admin;
GRANT ALL ON "reform_actions" TO balance_admin;
GRANT ALL ON "reform_action_updates" TO balance_admin;
GRANT ALL ON "reform_verifications" TO balance_admin;
GRANT ALL ON "reform_feedback_loops" TO balance_admin;
GRANT ALL ON "reform_coordinations" TO balance_admin;
GRANT ALL ON "reform_coordination_participants" TO balance_admin;
GRANT ALL ON "reform_coordination_invitations" TO balance_admin;
GRANT ALL ON "reform_coordination_shared_snapshots" TO balance_admin;
GRANT ALL ON "reform_coordination_shared_snapshot_revocations" TO balance_admin;

-- ============================================================
-- 9. DEDICATED ROLE — balance_coordination_admin (NOLOGIN, no BYPASSRLS)
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'balance_coordination_admin') THEN
        CREATE ROLE balance_coordination_admin NOLOGIN;
    END IF;
END $$;

-- C1 FIX: Grant SELECT + UPDATE (PostgreSQL requires SELECT for WHERE clause column reads)
GRANT SELECT ON "reform_coordinations" TO balance_coordination_admin;
GRANT SELECT, UPDATE ON "reform_coordination_participants" TO balance_coordination_admin;
GRANT SELECT, UPDATE ON "reform_proposals" TO balance_coordination_admin;
GRANT SELECT, UPDATE ON "reform_alternatives" TO balance_coordination_admin;
GRANT SELECT ON "reform_coordination_shared_snapshots" TO balance_coordination_admin;
GRANT SELECT ON "reform_coordination_shared_snapshot_revocations" TO balance_coordination_admin;

-- RLS policies for balance_coordination_admin (permissive — function WHERE clause is the gate)
CREATE POLICY "reform_coordinations_cadmin_select" ON "reform_coordinations"
    FOR SELECT TO balance_coordination_admin USING (true);
CREATE POLICY "reform_coord_participants_cadmin_select" ON "reform_coordination_participants"
    FOR SELECT TO balance_coordination_admin USING (true);
CREATE POLICY "reform_coord_participants_cadmin_update" ON "reform_coordination_participants"
    FOR UPDATE TO balance_coordination_admin USING (true) WITH CHECK (true);
CREATE POLICY "reform_proposals_cadmin_select" ON "reform_proposals"
    FOR SELECT TO balance_coordination_admin USING (true);
CREATE POLICY "reform_proposals_cadmin_update" ON "reform_proposals"
    FOR UPDATE TO balance_coordination_admin USING (true) WITH CHECK (true);
CREATE POLICY "reform_alternatives_cadmin_select" ON "reform_alternatives"
    FOR SELECT TO balance_coordination_admin USING (true);
CREATE POLICY "reform_alternatives_cadmin_update" ON "reform_alternatives"
    FOR UPDATE TO balance_coordination_admin USING (true) WITH CHECK (true);
CREATE POLICY "reform_coord_snapshots_cadmin_select" ON "reform_coordination_shared_snapshots"
    FOR SELECT TO balance_coordination_admin USING (true);
CREATE POLICY "reform_coord_revocations_cadmin_select" ON "reform_coordination_shared_snapshot_revocations"
    FOR SELECT TO balance_coordination_admin USING (true);

-- ============================================================
-- 10. SECURITY DEFINER — Administrative functions
-- ============================================================

-- remove_coordination_participant: lead removes a participant
-- C1 FIX: lead check is INSIDE the UPDATE's WHERE clause (not a separate CTE)
-- Returns BOOLEAN: TRUE iff exactly one row was modified
CREATE OR REPLACE FUNCTION public.remove_coordination_participant(
    p_coordination_id TEXT,
    p_participant_id TEXT,
    p_reason TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH updated AS (
        UPDATE public.reform_coordination_participants p
        SET "status" = 'removed',
            "removedAt" = NOW(),
            "removedBy" = current_setting('app.user_id', true),
            "removalReason" = p_reason
        WHERE p."coordinationId" = p_coordination_id
          AND p."id" = p_participant_id
          AND p."status" = 'active'
          AND EXISTS (
              SELECT 1 FROM public.reform_coordinations c
              WHERE c."id" = p_coordination_id
                AND c."leadTenantId" = current_setting('app.tenant_id', true)
          )
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM updated);
$$;
ALTER FUNCTION public.remove_coordination_participant(TEXT, TEXT, TEXT) OWNER TO balance_coordination_admin;
GRANT EXECUTE ON FUNCTION public.remove_coordination_participant(TEXT, TEXT, TEXT) TO balance_app;
REVOKE EXECUTE ON FUNCTION public.remove_coordination_participant(TEXT, TEXT, TEXT) FROM PUBLIC;

-- grant_commitment_approval: lead grants commitment approval authority
CREATE OR REPLACE FUNCTION public.grant_commitment_approval(
    p_coordination_id TEXT,
    p_participant_id TEXT,
    p_reason TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH updated AS (
        UPDATE public.reform_coordination_participants p
        SET "canApproveCommitments" = TRUE,
            "approvalAuthorityGrantedBy" = current_setting('app.user_id', true),
            "approvalAuthorityGrantedAt" = NOW(),
            "approvalAuthorityReason" = p_reason
        WHERE p."coordinationId" = p_coordination_id
          AND p."id" = p_participant_id
          AND p."status" = 'active'
          AND EXISTS (
              SELECT 1 FROM public.reform_coordinations c
              WHERE c."id" = p_coordination_id
                AND c."leadTenantId" = current_setting('app.tenant_id', true)
          )
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM updated);
$$;
ALTER FUNCTION public.grant_commitment_approval(TEXT, TEXT, TEXT) OWNER TO balance_coordination_admin;
GRANT EXECUTE ON FUNCTION public.grant_commitment_approval(TEXT, TEXT, TEXT) TO balance_app;
REVOKE EXECUTE ON FUNCTION public.grant_commitment_approval(TEXT, TEXT, TEXT) FROM PUBLIC;

-- verify_institutional_authority: admin verifies institutional representation
-- Checks BOTH app.role='admin' AND leadTenantId match
CREATE OR REPLACE FUNCTION public.verify_institutional_authority(
    p_coordination_id TEXT,
    p_participant_id TEXT,
    p_institution_id TEXT,
    p_method TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH updated AS (
        UPDATE public.reform_coordination_participants p
        SET "verifiedInstitutionId" = p_institution_id,
            "verifiedAt" = NOW(),
            "verifiedBy" = current_setting('app.user_id', true),
            "verificationMethod" = p_method
        WHERE p."coordinationId" = p_coordination_id
          AND p."id" = p_participant_id
          AND current_setting('app.role', true) = 'admin'
          AND EXISTS (
              SELECT 1 FROM public.reform_coordinations c
              WHERE c."id" = p_coordination_id
                AND c."leadTenantId" = current_setting('app.tenant_id', true)
          )
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM updated);
$$;
ALTER FUNCTION public.verify_institutional_authority(TEXT, TEXT, TEXT, TEXT) OWNER TO balance_coordination_admin;
GRANT EXECUTE ON FUNCTION public.verify_institutional_authority(TEXT, TEXT, TEXT, TEXT) TO balance_app;
REVOKE EXECUTE ON FUNCTION public.verify_institutional_authority(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

-- ============================================================
-- 11. TRIGGERS
-- ============================================================

-- F6: reform_verifications — verifiedAction + evidenceSource required when verificationStatus = 'verified'
CREATE OR REPLACE FUNCTION enforce_reform_verification_f6()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."verificationStatus" = 'verified' THEN
        IF NEW."verifiedAction" IS NULL OR btrim(NEW."verifiedAction") = '' THEN
            RAISE EXCEPTION 'F6 violation: verifiedAction is required when verificationStatus = verified. Describe the SPECIFIC action verified, NOT a policy outcome.';
        END IF;
        IF NEW."evidenceSource" IS NULL OR btrim(NEW."evidenceSource") = '' THEN
            RAISE EXCEPTION 'F6 violation: evidenceSource is required when verificationStatus = verified.';
        END IF;
    END IF;
    IF NEW."verificationStatus" = 'disputed' THEN
        IF NEW."disputeReason" IS NULL OR btrim(NEW."disputeReason") = '' THEN
            RAISE EXCEPTION 'F6 violation: disputeReason is required when verificationStatus = disputed.';
        END IF;
        IF NEW."disputeEvidenceSource" IS NULL OR btrim(NEW."disputeEvidenceSource") = '' THEN
            RAISE EXCEPTION 'F6 violation: disputeEvidenceSource is required when verificationStatus = disputed.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reform_verification_f6_trigger
    BEFORE INSERT OR UPDATE ON "reform_verifications"
    FOR EACH ROW EXECUTE FUNCTION enforce_reform_verification_f6();

-- Attribution: reform_feedback_loops — attributionLevel must always be 'descriptive'
CREATE OR REPLACE FUNCTION enforce_reform_feedback_attribution_descriptive()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."attributionLevel" IS DISTINCT FROM 'descriptive' THEN
        RAISE EXCEPTION 'Invariant violation: ReformFeedbackLoop.attributionLevel must always be "descriptive". Causal claims are forbidden.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reform_feedback_attribution_trigger
    BEFORE INSERT OR UPDATE ON "reform_feedback_loops"
    FOR EACH ROW EXECUTE FUNCTION enforce_reform_feedback_attribution_descriptive();

-- Supersession: reform_proposals — set supersededAt when status changes to 'superseded'
CREATE OR REPLACE FUNCTION enforce_reform_proposal_supersession()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."status" = 'superseded' AND OLD."status" != 'superseded' THEN
        IF NEW."supersededById" IS NULL THEN
            RAISE EXCEPTION 'supersededById is required when status = superseded';
        END IF;
        IF NEW."supersededAt" IS NULL THEN
            NEW."supersededAt" := NOW();
        END IF;
        -- D11: Do NOT modify coordinationId, strategyVersionId, or other historical links.
        -- The old proposal's context stays as it was when approved.
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reform_proposal_supersession_trigger
    BEFORE UPDATE ON "reform_proposals"
    FOR EACH ROW EXECUTE FUNCTION enforce_reform_proposal_supersession();

-- Coordination supersession: same historical-preservation rule
CREATE OR REPLACE FUNCTION enforce_reform_coordination_supersession()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."status" = 'superseded' AND OLD."status" != 'superseded' THEN
        IF NEW."supersededById" IS NULL THEN
            RAISE EXCEPTION 'supersededById is required when coordination status = superseded';
        END IF;
        IF NEW."supersededAt" IS NULL THEN
            NEW."supersededAt" := NOW();
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reform_coordination_supersession_trigger
    BEFORE UPDATE ON "reform_coordinations"
    FOR EACH ROW EXECUTE FUNCTION enforce_reform_coordination_supersession();

-- Revocation coordinationId match: ensure coordinationId on revocation matches snapshot's
CREATE OR REPLACE FUNCTION enforce_revocation_coordination_match()
RETURNS TRIGGER AS $$
DECLARE v_snapshot_coord_id TEXT;
BEGIN
    SELECT "coordinationId" INTO v_snapshot_coord_id
    FROM "reform_coordination_shared_snapshots" WHERE "id" = NEW."snapshotId";
    IF v_snapshot_coord_id IS NULL THEN
        RAISE EXCEPTION 'Cannot revoke: snapshot % does not exist', NEW."snapshotId";
    END IF;
    IF v_snapshot_coord_id != NEW."coordinationId" THEN
        RAISE EXCEPTION 'Coordination mismatch: revocation % does not match snapshot %', NEW."coordinationId", v_snapshot_coord_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER revocation_coordination_match_trigger
    BEFORE INSERT ON "reform_coordination_shared_snapshot_revocations"
    FOR EACH ROW EXECUTE FUNCTION enforce_revocation_coordination_match();

-- Cross-tenant FK integrity: reform_alternatives
CREATE OR REPLACE FUNCTION enforce_reform_alternative_same_tenant()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM 1 FROM "reform_proposals"
    WHERE "id" = NEW."proposalId" AND "tenantId" = NEW."tenantId";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cross-tenant violation: ReformAlternative.tenantId must match ReformProposal.tenantId';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER enforce_reform_alternative_same_tenant_trigger
    BEFORE INSERT OR UPDATE ON "reform_alternatives"
    FOR EACH ROW EXECUTE FUNCTION enforce_reform_alternative_same_tenant();

-- Cross-tenant FK integrity: reform_approvals
CREATE OR REPLACE FUNCTION enforce_reform_approval_same_tenant()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM 1 FROM "reform_proposals"
    WHERE "id" = NEW."proposalId" AND "tenantId" = NEW."tenantId";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cross-tenant violation: ReformApproval.tenantId must match ReformProposal.tenantId';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER enforce_reform_approval_same_tenant_trigger
    BEFORE INSERT OR UPDATE ON "reform_approvals"
    FOR EACH ROW EXECUTE FUNCTION enforce_reform_approval_same_tenant();

-- Cross-tenant FK integrity: reform_actions
CREATE OR REPLACE FUNCTION enforce_reform_action_same_tenant()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM 1 FROM "reform_proposals"
    WHERE "id" = NEW."proposalId" AND "tenantId" = NEW."tenantId";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cross-tenant violation: ReformAction.tenantId must match ReformProposal.tenantId';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER enforce_reform_action_same_tenant_trigger
    BEFORE INSERT OR UPDATE ON "reform_actions"
    FOR EACH ROW EXECUTE FUNCTION enforce_reform_action_same_tenant();

-- Cross-tenant FK integrity: reform_action_updates
CREATE OR REPLACE FUNCTION enforce_reform_action_update_same_tenant()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM 1 FROM "reform_actions"
    WHERE "id" = NEW."actionId" AND "tenantId" = NEW."tenantId";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cross-tenant violation: ReformActionUpdate.tenantId must match ReformAction.tenantId';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER enforce_reform_action_update_same_tenant_trigger
    BEFORE INSERT OR UPDATE ON "reform_action_updates"
    FOR EACH ROW EXECUTE FUNCTION enforce_reform_action_update_same_tenant();

-- Cross-tenant FK integrity: reform_verifications
CREATE OR REPLACE FUNCTION enforce_reform_verification_same_tenant()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM 1 FROM "reform_actions"
    WHERE "id" = NEW."actionId" AND "tenantId" = NEW."tenantId";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cross-tenant violation: ReformVerification.tenantId must match ReformAction.tenantId';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER enforce_reform_verification_same_tenant_trigger
    BEFORE INSERT OR UPDATE ON "reform_verifications"
    FOR EACH ROW EXECUTE FUNCTION enforce_reform_verification_same_tenant();

-- Cross-tenant FK integrity: reform_feedback_loops
CREATE OR REPLACE FUNCTION enforce_reform_feedback_loop_same_tenant()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM 1 FROM "reform_actions"
    WHERE "id" = NEW."actionId" AND "tenantId" = NEW."tenantId";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cross-tenant violation: ReformFeedbackLoop.tenantId must match ReformAction.tenantId';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER enforce_reform_feedback_loop_same_tenant_trigger
    BEFORE INSERT OR UPDATE ON "reform_feedback_loops"
    FOR EACH ROW EXECUTE FUNCTION enforce_reform_feedback_loop_same_tenant();

-- ============================================================
-- 12. MIGRATION LOCK
-- ============================================================
-- Prisma manages migration_lock.toml separately
