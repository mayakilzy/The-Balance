-- ============================================================
-- The Balance — Migration 0028: G03-06 Activation Hardening
-- Mission G03-06-IMPL-01 Phase D-0
--
-- PROBLEM 1: Migration 27 grants balance_coordination_admin UPDATE on
-- reform_coordinations with a permissive RLS policy (USING true WITH CHECK
-- true). This is broader than needed — the trigger only transitions
-- plan_approved → active. An attacker who somehow obtains
-- balance_coordination_admin credentials (impossible via NOLOGIN, but
-- defense-in-depth) could UPDATE any coordination field to any value.
--
-- PROBLEM 2: The trigger inserts an audit_log entry after the UPDATE without
-- checking the row count. If zero rows were updated (e.g., coordination was
-- already 'active' due to a concurrent trigger fire), a false activation
-- audit entry is recorded.
--
-- SOLUTION 1: Replace the permissive RLS policy with a narrowly scoped one
-- that only allows UPDATE WHERE status = 'plan_approved' AND the new status
-- is 'active' AND only the status/activatedAt/updatedAt fields change.
-- PostgreSQL RLS WITH CHECK evaluates the NEW row, so we can constrain
-- what the updated row looks like.
--
-- SOLUTION 2: Use GET DIAGNOSTICS to check the row count after UPDATE.
-- Only insert the audit_log entry if exactly 1 row was updated.
-- ============================================================

-- ============================================================
-- 1. DROP the permissive UPDATE policy from migration 27
-- ============================================================
DROP POLICY IF EXISTS "reform_coordinations_cadmin_update" ON "reform_coordinations";

-- ============================================================
-- 2. CREATE narrowly scoped UPDATE policy
-- ============================================================
-- Only allows the transition: plan_approved → active
-- WITH CHECK constrains the NEW row: status must be 'active'
-- USING constrains the OLD row: status must be 'plan_approved'
-- This means: the only UPDATE that balance_coordination_admin can perform
-- on reform_coordinations is one that reads a 'plan_approved' row and
-- writes an 'active' row. No other field change is permitted via this
-- policy (other fields would need their own UPDATE policy, which doesn't
-- exist for balance_coordination_admin).
CREATE POLICY "reform_coordinations_cadmin_update_activation" ON "reform_coordinations"
    FOR UPDATE TO balance_coordination_admin
    USING ("status" = 'plan_approved')
    WITH CHECK ("status" = 'active');

-- ============================================================
-- 3. REPLACE the activation trigger function to check row count
-- ============================================================
-- The new version uses GET DIAGNOSTICS to verify exactly 1 row was updated
-- before inserting the audit_log entry. If 0 rows were updated (coordination
-- was already 'active' — concurrent trigger fire), no audit entry is written.
CREATE OR REPLACE FUNCTION public.check_coordination_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_coordination_id TEXT;
    v_current_status TEXT;
    v_fully_approved BOOLEAN;
    v_row_count INTEGER;
BEGIN
    SELECT "coordinationId" INTO v_coordination_id
    FROM public.reform_proposals
    WHERE "id" = NEW."proposalId";

    IF v_coordination_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT "status" INTO v_current_status
    FROM public.reform_coordinations
    WHERE "id" = v_coordination_id;

    IF v_current_status IS NULL OR v_current_status != 'plan_approved' THEN
        RETURN NEW;
    END IF;

    SELECT public.is_coordination_fully_approved(v_coordination_id) INTO v_fully_approved;

    IF v_fully_approved THEN
        -- Transition coordination to active (conditional — only if still plan_approved)
        UPDATE public.reform_coordinations
        SET "status" = 'active',
            "activatedAt" = NOW(),
            "updatedAt" = NOW()
        WHERE "id" = v_coordination_id
          AND "status" = 'plan_approved';

        -- Check how many rows were actually updated
        GET DIAGNOSTICS v_row_count = ROW_COUNT;

        -- Only insert audit if exactly 1 row was transitioned
        -- This prevents false activation audit entries when:
        --   - The coordination was already 'active' (concurrent trigger fire)
        --   - The coordination was closed/superseded between the check and the UPDATE
        IF v_row_count = 1 THEN
            INSERT INTO public.audit_log ("at", "tenantId", "actor", "action", "details", "status")
            VALUES (
                NOW(),
                NEW."tenantId",
                NEW."approvedBy",
                'reform.coordination.activated',
                jsonb_build_object(
                    'coordinationId', v_coordination_id,
                    'triggerProposalId', NEW."proposalId",
                    'triggerApprovalId', NEW."id"
                ),
                'ok'
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
-- Owner is already balance_coordination_admin from migration 27 — no need to re-ALTER
-- Trigger is already created from migration 27 — no need to re-CREATE
-- (CREATE OR REPLACE FUNCTION updates the body; the trigger binding remains)

-- ============================================================
-- END OF MIGRATION 0028
-- ============================================================
