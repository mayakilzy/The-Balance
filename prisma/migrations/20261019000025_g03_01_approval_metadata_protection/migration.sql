-- The Balance — Migration 0025: G03-01 Approval Metadata Protection
-- Mission 03-01: Reviewer directive A — Independent Approval Metadata Tests
--
-- FORWARD-ONLY corrective migration. Does NOT rewrite 0022/0023/0024.
--
-- Background (independent reviewer finding):
--   Migration 0023 introduced enforce_shared_snapshot_immutable_after_approval()
--   but the trigger only protects 6 CONTENT fields (title, summary, snapshotType,
--   classification, proposalId, actionId). It does NOT independently protect:
--     - approvedBy        (approval metadata — who approved)
--     - approvedAt        (approval metadata — when approved)
--     - status            (transition INTO 'approved' = unauthorized human approval)
--     - ownerTenantId     (snapshot ownership is immutable identity)
--     - coordinationId    (coordination association is immutable identity)
--
--   Because the previous SA-03 test modified title + approvedBy + approvedAt in
--   a single UPDATE, the trigger fired on `title` alone and "passed" without
--   ever proving that `approvedBy` or `approvedAt` are independently protected.
--
-- Smallest forward-only correction (per reviewer directive):
--   Replace the trigger function with one that independently blocks:
--     (a) balance_app modifying approvedBy / approvedAt / ownerTenantId /
--         coordinationId on ANY row (these are institutional-sovereignty fields)
--     (b) balance_app transitioning status INTO 'approved' (human approval flow)
--     (c) balance_app modifying content fields of an already-approved snapshot
--         (existing protection preserved verbatim)
--
--   No new tables, no policy changes, no privilege grants/revokes.
--   SECURITY DEFINER functions remain DORMANT (REVOKE from balance_app stays).
--   app.service_context / app.migration_mode are NOT used as authorization
--   mechanisms (per R2 trust boundary decision).
--
-- Design alignment:
--   D12: draft → under_review → approved → revoked (revocation via separate
--        record in reform_coordination_shared_snapshot_revocations, NOT via
--        status update on the snapshot itself)
--   D15: institutional authority separation — balance_app cannot self-approve
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_shared_snapshot_immutable_after_approval()
RETURNS TRIGGER AS $$
BEGIN
    -- Apply ONLY to balance_app. balance_admin (BYPASSRLS) and postgres
    -- superuser bypass triggers via ALTER TABLE DISABLE TRIGGER for maintenance.
    IF current_user = 'balance_app' THEN

        -- (a) Identity / ownership / association fields — immutable for balance_app
        --     regardless of approval state. These define WHO owns the snapshot
        --     and WHICH coordination it belongs to.
        IF NEW."ownerTenantId" IS DISTINCT FROM OLD."ownerTenantId" THEN
            RAISE EXCEPTION 'S3 VIOLATION: balance_app cannot modify ownerTenantId (snapshot ownership is immutable).';
        END IF;
        IF NEW."coordinationId" IS DISTINCT FROM OLD."coordinationId" THEN
            RAISE EXCEPTION 'S3 VIOLATION: balance_app cannot modify coordinationId (coordination association is immutable).';
        END IF;

        -- (b) Approval metadata — immutable for balance_app regardless of state.
        --     Setting approvedBy/approvedAt is an institutional-sovereignty action
        --     reserved for the human approval workflow (admin/reviewer role or
        --     future verified service layer — currently DORMANT).
        IF NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy" THEN
            RAISE EXCEPTION 'S3 VIOLATION: balance_app cannot modify approvedBy (use the human approval workflow).';
        END IF;
        IF NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" THEN
            RAISE EXCEPTION 'S3 VIOLATION: balance_app cannot modify approvedAt (use the human approval workflow).';
        END IF;

        -- (c) Status transition INTO 'approved' — blocked for balance_app.
        --     This catches the case where the snapshot is in draft/under_review
        --     and balance_app tries to flip status='approved' directly.
        --     (When OLD.approvedAt is NULL but NEW.status='approved', that is
        --     an unauthorized approval attempt.)
        IF OLD."status" IS DISTINCT FROM 'approved' AND NEW."status" = 'approved' THEN
            RAISE EXCEPTION 'S3 VIOLATION: balance_app cannot transition status to approved (use the human approval workflow).';
        END IF;

        -- (d) Content immutability AFTER approval (existing protection from
        --     migration 0023, preserved verbatim). Once approvedAt is set,
        --     the snapshot is frozen: title/summary/snapshotType/classification/
        --     proposalId/actionId cannot be modified.
        IF OLD."approvedAt" IS NOT NULL THEN
            IF NEW."title" IS DISTINCT FROM OLD."title"
               OR NEW."summary" IS DISTINCT FROM OLD."summary"
               OR NEW."snapshotType" IS DISTINCT FROM OLD."snapshotType"
               OR NEW."classification" IS DISTINCT FROM OLD."classification"
               OR NEW."proposalId" IS DISTINCT FROM OLD."proposalId"
               OR NEW."actionId" IS DISTINCT FROM OLD."actionId" THEN
                RAISE EXCEPTION 'S3 VIOLATION: cannot modify content of approved shared snapshot.';
            END IF;
            -- Status of an approved snapshot is also immutable (revocation
            -- happens via reform_coordination_shared_snapshot_revocations).
            IF NEW."status" IS DISTINCT FROM OLD."status" THEN
                RAISE EXCEPTION 'S3 VIOLATION: balance_app cannot modify status of approved shared snapshot (revocation is recorded separately).';
            END IF;
        END IF;

    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger itself stays in place (function body replaced via CREATE OR REPLACE).
-- No DROP/CREATE TRIGGER needed — the existing trigger automatically picks up
-- the new function definition.

-- ============================================================
-- Verification (idempotent — safe to re-run on already-applied migrations)
-- ============================================================
DO $$
DECLARE
    v_fn TEXT;
    v_has_approvedBy BOOLEAN := FALSE;
    v_has_approvedAt BOOLEAN := FALSE;
    v_has_ownerTenant BOOLEAN := FALSE;
    v_has_coordinationId BOOLEAN := FALSE;
    v_has_status_transition BOOLEAN := FALSE;
BEGIN
    SELECT pg_get_functiondef('public.enforce_shared_snapshot_immutable_after_approval()'::regprocedure)
    INTO v_fn;
    v_has_approvedBy      := v_fn LIKE '%cannot modify approvedBy%';
    v_has_approvedAt      := v_fn LIKE '%cannot modify approvedAt%';
    v_has_ownerTenant     := v_fn LIKE '%cannot modify ownerTenantId%';
    v_has_coordinationId  := v_fn LIKE '%cannot modify coordinationId%';
    v_has_status_transition := v_fn LIKE '%cannot transition status to approved%';

    IF NOT (v_has_approvedBy AND v_has_approvedAt AND v_has_ownerTenant
            AND v_has_coordinationId AND v_has_status_transition) THEN
        RAISE EXCEPTION 'Migration 0025 verification FAILED: trigger function missing required protections (approvedBy=%, approvedAt=%, ownerTenantId=%, coordinationId=%, status_transition=%)',
            v_has_approvedBy, v_has_approvedAt, v_has_ownerTenant, v_has_coordinationId, v_has_status_transition;
    END IF;
    RAISE NOTICE 'Migration 0025 verification OK: trigger function protects approvedBy, approvedAt, ownerTenantId, coordinationId, and status transition INTO approved.';
END $$;
