-- The Balance — Migration 0024: G03-01 Security Remediation R2
-- Mission 03-01: Trust Boundary Enforcement (S2 + S3 fixes)
--
-- S2: REVOKE EXECUTE on SECURITY DEFINER functions FROM balance_app (DORMANT)
-- S3: Remove app.migration_mode — triggers block ALL roles unconditionally
-- ============================================================

-- ============================================================
-- S2: Make SECURITY DEFINER functions UNAVAILABLE to balance_app
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.remove_coordination_participant(TEXT, TEXT, TEXT) FROM balance_app;
REVOKE EXECUTE ON FUNCTION public.grant_commitment_approval(TEXT, TEXT, TEXT) FROM balance_app;
REVOKE EXECUTE ON FUNCTION public.verify_institutional_authority(TEXT, TEXT, TEXT, TEXT) FROM balance_app;

-- Remove the spoofable app.service_context check
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
        RETURNING 1
    ) SELECT EXISTS (SELECT 1 FROM updated);
$$;
ALTER FUNCTION public.remove_coordination_participant(TEXT, TEXT, TEXT) OWNER TO balance_coordination_admin;
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
        RETURNING 1
    ) SELECT EXISTS (SELECT 1 FROM updated);
$$;
ALTER FUNCTION public.grant_commitment_approval(TEXT, TEXT, TEXT) OWNER TO balance_coordination_admin;
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
        RETURNING 1
    ) SELECT EXISTS (SELECT 1 FROM updated);
$$;
ALTER FUNCTION public.verify_institutional_authority(TEXT, TEXT, TEXT, TEXT) OWNER TO balance_coordination_admin;
REVOKE EXECUTE ON FUNCTION public.verify_institutional_authority(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

-- ============================================================
-- S3: Remove app.migration_mode bypass — UNCONDITIONAL block
-- ============================================================

CREATE OR REPLACE FUNCTION prevent_historical_deletion()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'S3 VIOLATION: DELETE not permitted on append-only table %.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_historical_update()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'S3 VIOLATION: UPDATE not permitted on append-only table %.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
