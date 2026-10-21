-- ============================================================
-- The Balance — Migration 0026: G03-06 Coordination Approval Events
-- Mission 03-06-IMPL-01: Append-only event model for coordination approval state
--
-- This migration implements:
--   1. reform_coordination_approval_events table (append-only event stream)
--   2. sequenceNumber IDENTITY column for deterministic event ordering
--   3. 3 trigger functions (SECURITY DEFINER, owned by balance_coordination_admin)
--      that INSERT events on proposal lifecycle changes
--   4. 2 append-only defense-in-depth triggers (reusing migration 24 functions)
--   5. is_coordination_fully_approved() derived function (SECURITY DEFINER)
--      with authorization gate, 5 conditions, and sequenceNumber ordering
--   6. ONE RLS policy modification on reform_coordination_participants
--      (additive OR clause for coordination leads)
--
-- PRE-05A + PHASE-A-FIX-01 corrections applied:
--   A. is_coordination_fully_approved is SECURITY DEFINER (not INVOKER).
--      Closes the cross-tenant visibility gap. Returns only a BOOLEAN.
--   B. Function uses sequenceNumber (IDENTITY) for deterministic ordering.
--   C. 5 conditions: includes Condition 3 (≥1 linked proposal — fixes
--      zero-proposal activation bug) and Condition 4 (participant coverage).
--   D. FKs use ON DELETE RESTRICT (not CASCADE) — preserves immutable
--      history; deletion of coordination/proposal with events fails with
--      a clean FK violation rather than triggering append-only triggers.
--
-- Frozen contracts preserved:
--   - 3 DORMANT DEFINER functions remain DORMANT (no GRANT EXECUTE)
--   - R2 trust boundary intact (migration 24 unchanged)
--   - All 25 prior migrations untouched
--   - prevent_historical_update / prevent_historical_deletion reused
--     (defined in migration 24 — NOT modified, just attached to new table)
--
-- Append-only guarantee (3 layers):
--   Layer 1 (GRANT): balance_app=SELECT, balance_coordination_admin=SELECT+INSERT,
--                    balance_admin=SELECT. NO GRANT UPDATE or GRANT DELETE.
--   Layer 2 (RLS FORCE): 4 policies. NO UPDATE or DELETE policy for ANY role.
--                        FORCE RLS applies to table owner.
--   Layer 3 (Triggers): reform_coord_approval_events_no_update + _no_delete
--                       reusing prevent_historical_* from migration 24.
-- ============================================================

-- ============================================================
-- 1. CREATE TABLE: reform_coordination_approval_events
-- ============================================================

CREATE TABLE "reform_coordination_approval_events" (
    "id" TEXT NOT NULL,
    "sequenceNumber" BIGINT GENERATED ALWAYS AS IDENTITY,
    "coordinationId" TEXT NOT NULL,
    "participantTenantId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventBy" TEXT NOT NULL,
    "supersededByProposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "reform_coord_approval_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reform_coord_approval_events_eventType_check"
        CHECK ("eventType" IN ('proposal_linked', 'approved', 'superseded', 'withdrawn'))
);

-- ============================================================
-- 2. INDEXES
-- ============================================================

CREATE INDEX "reform_coord_approval_events_coordId_proposalId_seq_idx"
    ON "reform_coordination_approval_events"("coordinationId", "proposalId", "sequenceNumber");

CREATE INDEX "reform_coord_approval_events_participantTenantId_seq_idx"
    ON "reform_coordination_approval_events"("participantTenantId", "sequenceNumber");

-- ============================================================
-- 3. FOREIGN KEYS — ON DELETE RESTRICT (PHASE-A-FIX-01 correction)
-- ============================================================
-- RESTRICT (not CASCADE) ensures:
--   - Deleting a coordination/proposal with events fails with a clean FK error
--   - Append-only triggers are NOT triggered by FK CASCADE
--   - Historical events survive lifecycle closure and supersession
--   - Emergency deletion requires disabling triggers (audited action)
-- ============================================================

ALTER TABLE "reform_coordination_approval_events" ADD CONSTRAINT "reform_coord_approval_events_coordId_fkey"
    FOREIGN KEY ("coordinationId") REFERENCES "reform_coordinations"("id") ON DELETE RESTRICT;

ALTER TABLE "reform_coordination_approval_events" ADD CONSTRAINT "reform_coord_approval_events_proposalId_fkey"
    FOREIGN KEY ("proposalId") REFERENCES "reform_proposals"("id") ON DELETE RESTRICT;

-- ============================================================
-- 4. RLS: ENABLE + FORCE
-- ============================================================

ALTER TABLE "reform_coordination_approval_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reform_coordination_approval_events" FORCE ROW LEVEL SECURITY;

-- ============================================================
-- 5. RLS POLICIES — NO FOR ALL. NO UPDATE/DELETE for ANY role.
-- ============================================================

-- balance_app: SELECT only — coordination-aware
CREATE POLICY "reform_coord_approval_events_select_app" ON "reform_coordination_approval_events"
    FOR SELECT TO balance_app
    USING (
        "participantTenantId" = current_setting('app.tenant_id', true)
        OR EXISTS (
            SELECT 1 FROM "reform_coordinations" c
            WHERE c."id" = "coordinationId"
              AND c."leadTenantId" = current_setting('app.tenant_id', true)
        )
    );

-- balance_coordination_admin: SELECT + INSERT only (for trigger functions)
CREATE POLICY "reform_coord_approval_events_cadmin_select" ON "reform_coordination_approval_events"
    FOR SELECT TO balance_coordination_admin USING (true);

CREATE POLICY "reform_coord_approval_events_cadmin_insert" ON "reform_coordination_approval_events"
    FOR INSERT TO balance_coordination_admin WITH CHECK (true);

-- balance_admin: SELECT only (inspection; no modification) — PRE-05 correction
CREATE POLICY "reform_coord_approval_events_admin_select" ON "reform_coordination_approval_events"
    FOR SELECT TO balance_admin USING (true);

-- ============================================================
-- 6. GRANTS — minimal, per-role. NO GRANT ALL.
-- ============================================================

GRANT SELECT ON "reform_coordination_approval_events" TO balance_app;
GRANT SELECT, INSERT ON "reform_coordination_approval_events" TO balance_coordination_admin;
GRANT SELECT ON "reform_coordination_approval_events" TO balance_admin;

-- ============================================================
-- 7. DEFENSE-IN-DEPTH: APPEND-ONLY TRIGGERS (Layer 3)
-- ============================================================
-- Reuse prevent_historical_update and prevent_historical_deletion
-- from migration 24 (G03-01 R2 — frozen infrastructure).
-- ============================================================

CREATE TRIGGER reform_coord_approval_events_no_update
    BEFORE UPDATE ON "reform_coordination_approval_events"
    FOR EACH ROW EXECUTE FUNCTION prevent_historical_update();

CREATE TRIGGER reform_coord_approval_events_no_delete
    BEFORE DELETE ON "reform_coordination_approval_events"
    FOR EACH ROW EXECUTE FUNCTION prevent_historical_deletion();

-- ============================================================
-- 8. TRIGGER FUNCTIONS (owned by balance_coordination_admin, SECURITY DEFINER)
-- ============================================================

-- Trigger 1: proposal_linked (on reform_proposals INSERT)
CREATE OR REPLACE FUNCTION public.propagate_proposal_link_to_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW."coordinationId" IS NULL THEN
        RETURN NEW;
    END IF;
    INSERT INTO "reform_coordination_approval_events" (
        "id", "coordinationId", "participantTenantId", "proposalId",
        "eventType", "eventBy"
    ) VALUES (
        gen_random_uuid()::text,
        NEW."coordinationId",
        NEW."tenantId",
        NEW."id",
        'proposal_linked',
        NEW."createdBy"
    );
    RETURN NEW;
END;
$$;
ALTER FUNCTION public.propagate_proposal_link_to_events() OWNER TO balance_coordination_admin;

CREATE TRIGGER reform_proposal_link_to_events_trigger
    AFTER INSERT ON "reform_proposals"
    FOR EACH ROW EXECUTE FUNCTION public.propagate_proposal_link_to_events();

-- Trigger 2: approved (on reform_approvals INSERT)
CREATE OR REPLACE FUNCTION public.propagate_reform_approval_to_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_proposal RECORD;
BEGIN
    SELECT "coordinationId", "tenantId", "status"
    INTO v_proposal
    FROM "reform_proposals"
    WHERE "id" = NEW."proposalId";
    IF v_proposal."coordinationId" IS NULL THEN
        RETURN NEW;
    END IF;
    INSERT INTO "reform_coordination_approval_events" (
        "id", "coordinationId", "participantTenantId", "proposalId",
        "eventType", "eventBy"
    ) VALUES (
        gen_random_uuid()::text,
        v_proposal."coordinationId",
        v_proposal."tenantId",
        NEW."proposalId",
        'approved',
        NEW."approvedBy"
    );
    RETURN NEW;
END;
$$;
ALTER FUNCTION public.propagate_reform_approval_to_events() OWNER TO balance_coordination_admin;

CREATE TRIGGER reform_approval_to_events_trigger
    AFTER INSERT ON "reform_approvals"
    FOR EACH ROW EXECUTE FUNCTION public.propagate_reform_approval_to_events();

-- Trigger 3: superseded / withdrawn (on reform_proposals UPDATE)
CREATE OR REPLACE FUNCTION public.propagate_proposal_status_change_to_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_event_type TEXT;
BEGIN
    IF NEW."coordinationId" IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW."status" = 'superseded' AND OLD."status" != 'superseded' THEN
        v_event_type := 'superseded';
    ELSIF NEW."status" IN ('rejected', 'withdrawn', 'archived')
          AND OLD."status" NOT IN ('rejected', 'withdrawn', 'archived') THEN
        v_event_type := 'withdrawn';
    ELSE
        RETURN NEW;
    END IF;

    INSERT INTO "reform_coordination_approval_events" (
        "id", "coordinationId", "participantTenantId", "proposalId",
        "eventType", "eventBy", "supersededByProposalId"
    ) VALUES (
        gen_random_uuid()::text,
        NEW."coordinationId",
        NEW."tenantId",
        NEW."id",
        v_event_type,
        COALESCE(current_setting('app.user_id', true), NEW."createdBy"),
        CASE WHEN v_event_type = 'superseded' THEN NEW."supersededById" ELSE NULL END
    );
    RETURN NEW;
END;
$$;
ALTER FUNCTION public.propagate_proposal_status_change_to_events() OWNER TO balance_coordination_admin;

CREATE TRIGGER reform_proposal_status_to_events_trigger
    AFTER UPDATE ON "reform_proposals"
    FOR EACH ROW EXECUTE FUNCTION public.propagate_proposal_status_change_to_events();

-- ============================================================
-- 9. DERIVED FUNCTION: is_coordination_fully_approved
-- ============================================================
-- SECURITY DEFINER (closes cross-tenant visibility gap — function sees ALL
-- events/participants/coordinations via balance_coordination_admin's permissive
-- RLS). Returns only a BOOLEAN — no private data exposed.
--
-- RESIDUAL RISK (PHASE-A-FIX-01 documentation):
--   The authorization gate uses current_setting('app.tenant_id', true) — a
--   PostgreSQL custom GUC. Custom GUCs offer NO integrity protection: any
--   role with normal connection privileges (including balance_app) can
--   set_config() any value. A direct DB caller who possesses balance_app
--   credentials can forge the tenant context and learn whether a coordination
--   is fully approved (one bit per call). This is the frozen C2 limitation
--   (G03_00_EMPIRICAL_VALIDATION_REV7.md:128). No proposal content is exposed.
--
-- EVENT ORDERING CONTRACT (PHASE-A-FIX-01):
--   sequenceNumber provides deterministic ordering ONLY when event-producing
--   operations are serialized through L-COORD (coordination-level advisory
--   lock). Production paths that MUST acquire L-COORD (Phase B/C):
--     - approveReformProposal (with coordinationId)
--     - withdrawReformProposal (with coordinationId)
--     - rejectReformProposal (with coordinationId)
--     - supersession via approveReformProposal
--     - proposal creation (with coordinationId)
--   The function itself does NOT acquire L-COORD. The caller must hold it.
--   Concurrency acceptance is NOT claimed until Phase D contention tests.
--
-- 5 conditions:
--   1. Authorization gate (lead OR active participant)
--   2. Coordination status = 'plan_approved'
--   3. ≥1 active participant
--   4. ≥1 linked proposal (PRE-05 fix — prevents zero-proposal activation)
--   5. Every active participant has ≥1 linked proposal (participant coverage)
--   6. Every linked proposal has a current approved state (ALL quantifier, OD-Q1.A)
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_coordination_fully_approved(
    p_coordination_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT
        -- Authorization gate
        EXISTS (
            SELECT 1 FROM public.reform_coordinations c
            WHERE c."id" = p_coordination_id
              AND (
                  c."leadTenantId" = current_setting('app.tenant_id', true)
                  OR EXISTS (
                      SELECT 1 FROM public.reform_coordination_participants p
                      WHERE p."coordinationId" = p_coordination_id
                        AND p."tenantId" = current_setting('app.tenant_id', true)
                        AND p."status" = 'active'
                  )
              )
        )
        AND EXISTS (
            SELECT 1 FROM public.reform_coordinations c
            WHERE c."id" = p_coordination_id
              AND c."status" = 'plan_approved'
        )
        AND EXISTS (
            SELECT 1 FROM public.reform_coordination_participants p
            WHERE p."coordinationId" = p_coordination_id
              AND p."status" = 'active'
        )
        AND EXISTS (
            SELECT 1 FROM public.reform_coordination_approval_events e
            WHERE e."coordinationId" = p_coordination_id
              AND e."eventType" = 'proposal_linked'
        )
        AND NOT EXISTS (
            SELECT 1
            FROM public.reform_coordination_participants part
            WHERE part."coordinationId" = p_coordination_id
              AND part."status" = 'active'
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.reform_coordination_approval_events e
                  WHERE e."coordinationId" = p_coordination_id
                    AND e."participantTenantId" = part."tenantId"
                    AND e."eventType" = 'proposal_linked'
              )
        )
        AND NOT EXISTS (
            SELECT 1
            FROM public.reform_coordination_approval_events linked
            WHERE linked."coordinationId" = p_coordination_id
              AND linked."eventType" = 'proposal_linked'
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.reform_coordination_approval_events approved
                  WHERE approved."proposalId" = linked."proposalId"
                    AND approved."coordinationId" = p_coordination_id
                    AND approved."eventType" = 'approved'
                    AND approved."sequenceNumber" > linked."sequenceNumber"
                    AND NOT EXISTS (
                        SELECT 1
                        FROM public.reform_coordination_approval_events invalidated
                        WHERE invalidated."proposalId" = linked."proposalId"
                          AND invalidated."coordinationId" = p_coordination_id
                          AND invalidated."eventType" IN ('superseded', 'withdrawn')
                          AND invalidated."sequenceNumber" > approved."sequenceNumber"
                    )
              )
        )
$$;
ALTER FUNCTION public.is_coordination_fully_approved(TEXT) OWNER TO balance_coordination_admin;
GRANT EXECUTE ON FUNCTION public.is_coordination_fully_approved(TEXT) TO balance_app;
GRANT EXECUTE ON FUNCTION public.is_coordination_fully_approved(TEXT) TO balance_admin;
REVOKE EXECUTE ON FUNCTION public.is_coordination_fully_approved(TEXT) FROM PUBLIC;

-- ============================================================
-- 10. RLS POLICY MODIFICATION on reform_coordination_participants
-- ============================================================
-- The ONLY frozen-contract modification in G03-06.
-- Additive OR clause — preserves the existing constraint.
-- Allows coordination leads to see participant rows for coordinations they lead.
-- INSERT, UPDATE, DELETE policies UNCHANGED.

DROP POLICY "reform_coord_participants_select_app" ON "reform_coordination_participants";

CREATE POLICY "reform_coord_participants_select_app" ON "reform_coordination_participants"
    FOR SELECT TO balance_app
    USING (
        "tenantId" = current_setting('app.tenant_id', true)
        OR EXISTS (
            SELECT 1 FROM "reform_coordinations" c
            WHERE c."id" = "coordinationId"
              AND c."leadTenantId" = current_setting('app.tenant_id', true)
        )
    );

-- ============================================================
-- END OF MIGRATION 0026
-- ============================================================
