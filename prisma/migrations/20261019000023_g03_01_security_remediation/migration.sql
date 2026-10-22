-- The Balance — Migration 0023: G03-01 Security Remediation
-- Mission 03-01: Security Remediation (S1-S6 from independent review)
--
-- This migration is a FORWARD-ONLY corrective migration that fixes
-- security issues found in migration 0022 without rewriting history.
--
-- Fixes:
--   S1: Restrict UPDATE on reform_coordination_participants to prevent
--       direct modification of institutional authority fields.
--   S2: Add app.service_context guard to SECURITY DEFINER functions.
--   S3: Add triggers to protect approved snapshots and append-only tables.
-- ============================================================

-- ============================================================
-- S1: Institutional Authority Escalation Prevention
-- ============================================================

-- Drop the permissive UPDATE policy on reform_coordination_participants
DROP POLICY IF EXISTS "reform_coord_participants_update_app" ON "reform_coordination_participants";

-- Create a RESTRICTED UPDATE policy:
-- balance_app can only UPDATE their own participant row (for self-withdrawal)
-- Sensitive fields are protected by trigger below
CREATE POLICY "reform_coord_participants_update_app_restricted" ON "reform_coordination_participants"
    FOR UPDATE TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Trigger: block direct UPDATE on sensitive institutional authority fields by balance_app
CREATE OR REPLACE FUNCTION enforce_participant_authority_field_protection()
RETURNS TRIGGER AS $$
BEGIN
    IF current_user = 'balance_app' THEN
        IF NEW."canApproveCommitments" IS DISTINCT FROM OLD."canApproveCommitments" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify canApproveCommitments. Use grant_commitment_approval().';
        END IF;
        IF NEW."verifiedInstitutionId" IS DISTINCT FROM OLD."verifiedInstitutionId" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify verifiedInstitutionId. Use verify_institutional_authority().';
        END IF;
        IF NEW."verifiedBy" IS DISTINCT FROM OLD."verifiedBy" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify verifiedBy.';
        END IF;
        IF NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify verifiedAt.';
        END IF;
        IF NEW."verificationMethod" IS DISTINCT FROM OLD."verificationMethod" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify verificationMethod.';
        END IF;
        IF NEW."verificationNotes" IS DISTINCT FROM OLD."verificationNotes" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify verificationNotes.';
        END IF;
        IF NEW."approvalAuthorityGrantedBy" IS DISTINCT FROM OLD."approvalAuthorityGrantedBy" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify approvalAuthorityGrantedBy.';
        END IF;
        IF NEW."approvalAuthorityGrantedAt" IS DISTINCT FROM OLD."approvalAuthorityGrantedAt" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify approvalAuthorityGrantedAt.';
        END IF;
        IF NEW."approvalAuthorityReason" IS DISTINCT FROM OLD."approvalAuthorityReason" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify approvalAuthorityReason.';
        END IF;
        IF NEW."role" IS DISTINCT FROM OLD."role" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify role.';
        END IF;
        IF NEW."institutionId" IS DISTINCT FROM OLD."institutionId" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify institutionId.';
        END IF;
        IF NEW."addedBy" IS DISTINCT FROM OLD."addedBy" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify addedBy.';
        END IF;
        IF NEW."removedAt" IS DISTINCT FROM OLD."removedAt" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify removedAt. Use remove_coordination_participant().';
        END IF;
        IF NEW."removedBy" IS DISTINCT FROM OLD."removedBy" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify removedBy. Use remove_coordination_participant().';
        END IF;
        IF NEW."removalReason" IS DISTINCT FROM OLD."removalReason" THEN
            RAISE EXCEPTION 'S1 VIOLATION: balance_app cannot modify removalReason. Use remove_coordination_participant().';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER participant_authority_field_protection_trigger
    BEFORE UPDATE ON "reform_coordination_participants"
    FOR EACH ROW EXECUTE FUNCTION enforce_participant_authority_field_protection();

-- ============================================================
-- S2: Guard against direct function invocation without service context
-- ============================================================

-- SECURITY DEFINER functions now require app.service_context = 'authenticated'
-- This GUC is set ONLY by withAuthenticatedTenant in the application layer.
-- Direct SQL invocation without this context will fail (function returns FALSE).

CREATE OR REPLACE FUNCTION public.remove_coordination_participant(
    p_coordination_id TEXT, p_participant_id TEXT, p_reason TEXT
) RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH updated AS (
        UPDATE public.reform_coordination_participants p
        SET "status" = 'removed', "removedAt" = NOW(),
            "removedBy" = current_setting('app.user_id', true),
            "removalReason" = p_reason
        WHERE p."coordinationId" = p_coordination_id
          AND p."id" = p_participant_id AND p."status" = 'active'
          AND EXISTS (SELECT 1 FROM public.reform_coordinations c
                      WHERE c."id" = p_coordination_id
                        AND c."leadTenantId" = current_setting('app.tenant_id', true))
          AND current_setting('app.service_context', true) = 'authenticated'
        RETURNING 1
    ) SELECT EXISTS (SELECT 1 FROM updated);
$$;
ALTER FUNCTION public.remove_coordination_participant(TEXT, TEXT, TEXT) OWNER TO balance_coordination_admin;
GRANT EXECUTE ON FUNCTION public.remove_coordination_participant(TEXT, TEXT, TEXT) TO balance_app;
REVOKE EXECUTE ON FUNCTION public.remove_coordination_participant(TEXT, TEXT, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.grant_commitment_approval(
    p_coordination_id TEXT, p_participant_id TEXT, p_reason TEXT
) RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH updated AS (
        UPDATE public.reform_coordination_participants p
        SET "canApproveCommitments" = TRUE,
            "approvalAuthorityGrantedBy" = current_setting('app.user_id', true),
            "approvalAuthorityGrantedAt" = NOW(),
            "approvalAuthorityReason" = p_reason
        WHERE p."coordinationId" = p_coordination_id
          AND p."id" = p_participant_id AND p."status" = 'active'
          AND EXISTS (SELECT 1 FROM public.reform_coordinations c
                      WHERE c."id" = p_coordination_id
                        AND c."leadTenantId" = current_setting('app.tenant_id', true))
          AND current_setting('app.service_context', true) = 'authenticated'
        RETURNING 1
    ) SELECT EXISTS (SELECT 1 FROM updated);
$$;
ALTER FUNCTION public.grant_commitment_approval(TEXT, TEXT, TEXT) OWNER TO balance_coordination_admin;
GRANT EXECUTE ON FUNCTION public.grant_commitment_approval(TEXT, TEXT, TEXT) TO balance_app;
REVOKE EXECUTE ON FUNCTION public.grant_commitment_approval(TEXT, TEXT, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.verify_institutional_authority(
    p_coordination_id TEXT, p_participant_id TEXT, p_institution_id TEXT, p_method TEXT
) RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH updated AS (
        UPDATE public.reform_coordination_participants p
        SET "verifiedInstitutionId" = p_institution_id, "verifiedAt" = NOW(),
            "verifiedBy" = current_setting('app.user_id', true),
            "verificationMethod" = p_method
        WHERE p."coordinationId" = p_coordination_id
          AND p."id" = p_participant_id
          AND current_setting('app.role', true) = 'admin'
          AND EXISTS (SELECT 1 FROM public.reform_coordinations c
                      WHERE c."id" = p_coordination_id
                        AND c."leadTenantId" = current_setting('app.tenant_id', true))
          AND current_setting('app.service_context', true) = 'authenticated'
        RETURNING 1
    ) SELECT EXISTS (SELECT 1 FROM updated);
$$;
ALTER FUNCTION public.verify_institutional_authority(TEXT, TEXT, TEXT, TEXT) OWNER TO balance_coordination_admin;
GRANT EXECUTE ON FUNCTION public.verify_institutional_authority(TEXT, TEXT, TEXT, TEXT) TO balance_app;
REVOKE EXECUTE ON FUNCTION public.verify_institutional_authority(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

-- ============================================================
-- S3: Snapshot and Historical Integrity
-- ============================================================

-- Trigger: prevent UPDATE on content fields of approved shared snapshots
CREATE OR REPLACE FUNCTION enforce_shared_snapshot_immutable_after_approval()
RETURNS TRIGGER AS $$
BEGIN
    IF current_user = 'balance_app' AND OLD."approvedAt" IS NOT NULL THEN
        IF NEW."title" IS DISTINCT FROM OLD."title"
           OR NEW."summary" IS DISTINCT FROM OLD."summary"
           OR NEW."snapshotType" IS DISTINCT FROM OLD."snapshotType"
           OR NEW."classification" IS DISTINCT FROM OLD."classification"
           OR NEW."proposalId" IS DISTINCT FROM OLD."proposalId"
           OR NEW."actionId" IS DISTINCT FROM OLD."actionId" THEN
            RAISE EXCEPTION 'S3 VIOLATION: cannot modify content of approved shared snapshot.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER shared_snapshot_immutable_after_approval_trigger
    BEFORE UPDATE ON "reform_coordination_shared_snapshots"
    FOR EACH ROW EXECUTE FUNCTION enforce_shared_snapshot_immutable_after_approval();

-- Triggers: prevent DELETE and UPDATE on append-only tables (even by balance_admin)
CREATE OR REPLACE FUNCTION prevent_historical_deletion()
RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('app.migration_mode', true) IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'S3 VIOLATION: DELETE not permitted on append-only table %.', TG_TABLE_NAME;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_delete_reform_approvals BEFORE DELETE ON "reform_approvals"
    FOR EACH ROW EXECUTE FUNCTION prevent_historical_deletion();
CREATE TRIGGER prevent_delete_reform_action_updates BEFORE DELETE ON "reform_action_updates"
    FOR EACH ROW EXECUTE FUNCTION prevent_historical_deletion();
CREATE TRIGGER prevent_delete_reform_feedback_loops BEFORE DELETE ON "reform_feedback_loops"
    FOR EACH ROW EXECUTE FUNCTION prevent_historical_deletion();
CREATE TRIGGER prevent_delete_reform_coord_revocations BEFORE DELETE ON "reform_coordination_shared_snapshot_revocations"
    FOR EACH ROW EXECUTE FUNCTION prevent_historical_deletion();

CREATE OR REPLACE FUNCTION prevent_historical_update()
RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('app.migration_mode', true) IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'S3 VIOLATION: UPDATE not permitted on append-only table %.', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_update_reform_approvals BEFORE UPDATE ON "reform_approvals"
    FOR EACH ROW EXECUTE FUNCTION prevent_historical_update();
CREATE TRIGGER prevent_update_reform_action_updates BEFORE UPDATE ON "reform_action_updates"
    FOR EACH ROW EXECUTE FUNCTION prevent_historical_update();
CREATE TRIGGER prevent_update_reform_feedback_loops BEFORE UPDATE ON "reform_feedback_loops"
    FOR EACH ROW EXECUTE FUNCTION prevent_historical_update();
CREATE TRIGGER prevent_update_reform_coord_revocations BEFORE UPDATE ON "reform_coordination_shared_snapshot_revocations"
    FOR EACH ROW EXECUTE FUNCTION prevent_historical_update();
