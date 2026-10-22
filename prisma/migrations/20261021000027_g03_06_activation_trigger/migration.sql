-- ============================================================
-- The Balance — Migration 0027: G03-06 Coordination Activation Trigger
-- Mission G03-06-BC-FIX-01: Trusted cross-tenant activation
--
-- PROBLEM: The inline activation check in approveReformProposal (TypeScript)
-- runs under balance_app RLS, which hides other tenants' events. A participant
-- approving their own proposal may see all proposals as approved (because they
-- can't see the other tenant's unapproved proposal), causing false activation.
--
-- SOLUTION: A SECURITY DEFINER trigger that fires AFTER INSERT on
-- reform_approvals, calls is_coordination_fully_approved (which the trigger
-- owner balance_coordination_admin can invoke implicitly), and transitions
-- the coordination to 'active' if TRUE — all within the same transaction.
--
-- The trigger runs as balance_coordination_admin (NOLOGIN, permissive RLS —
-- sees ALL events/participants/coordinations across tenants). balance_app
-- CANNOT invoke this trigger directly — triggers fire as a result of DML,
-- not via EXECUTE. The attacker cannot bypass RLS because the trigger
-- only reads and conditionally updates — it does not expose data.
--
-- The L-COORD advisory lock is already held by approveReformProposal
-- (acquired before L-PROP), so the trigger runs under the same lock —
-- no additional lock acquisition needed.
-- ============================================================

-- ============================================================
-- 0. GRANT UPDATE on reform_coordinations + INSERT on audit_log
-- ============================================================
GRANT UPDATE ON "reform_coordinations" TO balance_coordination_admin;
GRANT INSERT ON "audit_log" TO balance_coordination_admin;
GRANT USAGE, SELECT ON SEQUENCE "audit_log_id_seq" TO balance_coordination_admin;
CREATE POLICY "audit_log_cadmin_insert" ON "audit_log"
    FOR INSERT TO balance_coordination_admin WITH CHECK (true);
CREATE POLICY "reform_coordinations_cadmin_update" ON "reform_coordinations"
    FOR UPDATE TO balance_coordination_admin USING (true) WITH CHECK (true);

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
BEGIN
    -- Find the coordination for the approved proposal
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

    -- Call the trusted predicate — balance_coordination_admin has implicit
    -- EXECUTE as function owner. The trigger runs as balance_coordination_admin.
    -- This sees ALL events across tenants (permissive RLS), so the
    -- ALL-linked-proposals check is authoritative.
    SELECT public.is_coordination_fully_approved(v_coordination_id) INTO v_fully_approved;

    IF v_fully_approved THEN
        UPDATE public.reform_coordinations
        SET "status" = 'active',
            "activatedAt" = NOW(),
            "updatedAt" = NOW()
        WHERE "id" = v_coordination_id
          AND "status" = 'plan_approved';

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

    RETURN NEW;
END;
$$;
ALTER FUNCTION public.check_coordination_activation() OWNER TO balance_coordination_admin;

-- Name sorts AFTER reform_approval_to_events_trigger to ensure the 'approved'
-- event is inserted BEFORE the activation check runs.
CREATE TRIGGER reform_coordination_activation_trigger
    AFTER INSERT ON "reform_approvals"
    FOR EACH ROW EXECUTE FUNCTION public.check_coordination_activation();
