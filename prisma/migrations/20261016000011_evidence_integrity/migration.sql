-- The Balance — Migration 0011: Evidence Integrity Closure
-- Mission 00-04 evidence integrity closure (3 founder gaps).
--
-- 1. Cross-tenant evidence relations: prevent relatedEvidenceId pointing to different tenant
-- 2. evidence_embeddings tenant consistency: prevent tenantId != evidence.tenantId
-- 3. Source review status: separate candidate (tenant-submitted) from approved (global)
-- 4. Sources RLS: balance_app sees approved sources; can INSERT candidate only

-- ============================================================
-- 1. CROSS-TENANT EVIDENCE RELATIONS (trigger)
-- ============================================================
-- Prevent evidence.relatedEvidenceId from pointing to a different tenant's evidence.

CREATE OR REPLACE FUNCTION enforce_evidence_same_tenant_relation() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."relatedEvidenceId" IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "evidence"
            WHERE id = NEW."relatedEvidenceId" AND "tenantId" = NEW."tenantId"
        ) THEN
            RAISE EXCEPTION
                'Evidence relation violation: related evidence % is not in tenant %',
                NEW."relatedEvidenceId", NEW."tenantId"
                USING HINT = 'Counter-evidence can only link to evidence in the same tenant.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "evidence_same_tenant_relation_check" ON "evidence";
CREATE TRIGGER "evidence_same_tenant_relation_check"
    BEFORE INSERT OR UPDATE OF "relatedEvidenceId", "tenantId" ON "evidence"
    FOR EACH ROW EXECUTE FUNCTION enforce_evidence_same_tenant_relation();

-- ============================================================
-- 2. EVIDENCE_EMBEDDINGS TENANT CONSISTENCY (trigger)
-- ============================================================
-- Prevent evidence_embeddings.tenantId from differing from the evidence's tenantId.

CREATE OR REPLACE FUNCTION enforce_embedding_tenant_consistency() RETURNS TRIGGER AS $$
DECLARE
    evidence_tenant TEXT;
BEGIN
    SELECT "tenantId" INTO evidence_tenant FROM "evidence" WHERE id = NEW."evidenceId";
    IF evidence_tenant IS NULL THEN
        RAISE EXCEPTION 'Embedding consistency: evidence % not found', NEW."evidenceId";
    END IF;
    IF evidence_tenant != NEW."tenantId" THEN
        RAISE EXCEPTION
            'Embedding tenant mismatch: evidence % is in tenant %, but embedding claims tenant %',
            NEW."evidenceId", evidence_tenant, NEW."tenantId"
            USING HINT = 'Embedding tenantId must match the evidence tenantId.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "embedding_tenant_consistency_check" ON "evidence_embeddings";
CREATE TRIGGER "embedding_tenant_consistency_check"
    BEFORE INSERT OR UPDATE OF "evidenceId", "tenantId" ON "evidence_embeddings"
    FOR EACH ROW EXECUTE FUNCTION enforce_embedding_tenant_consistency();

-- ============================================================
-- 3. SOURCE REVIEW STATUS
-- ============================================================
-- Add reviewStatus + submittedByTenantId to sources.
-- reviewStatus: 'candidate' (tenant-submitted, not yet reviewed) | 'approved' (global reference)
-- submittedByTenantId: which tenant submitted this candidate (NULL for admin-curated)

ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "reviewStatus" TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "submittedByTenantId" TEXT;

CREATE INDEX IF NOT EXISTS "sources_reviewStatus_idx" ON "sources"("reviewStatus");

-- Existing sources (from seed) are 'approved' by default (admin-curated).
-- New sources created by balance_app will be 'candidate'.

-- FK: submittedByTenantId → tenants.id (nullable)
ALTER TABLE "sources"
    DROP CONSTRAINT IF EXISTS "sources_submittedByTenantId_fkey";
ALTER TABLE "sources"
    ADD CONSTRAINT "sources_submittedByTenantId_fkey"
    FOREIGN KEY ("submittedByTenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 4. SOURCES RLS UPDATE
-- ============================================================
-- Old policy: balance_app can SELECT all sources.
-- New policy: balance_app can SELECT approved sources + own candidate sources.
-- INSERT: balance_app creates candidate sources only (enforced via WITH CHECK).

DROP POLICY IF EXISTS "public_read_balance_app" ON "sources";
CREATE POLICY "public_read_balance_app" ON "sources"
    FOR SELECT TO balance_app
    USING (
        "reviewStatus" = 'approved'
        OR "submittedByTenantId" = current_setting('app.tenant_id', true)
    );

-- INSERT: balance_app can only create candidate sources (WITH CHECK enforces reviewStatus)
DROP POLICY IF EXISTS "public_insert_balance_app" ON "sources";
CREATE POLICY "public_insert_balance_app" ON "sources"
    FOR INSERT TO balance_app
    WITH CHECK ("reviewStatus" = 'candidate');

-- balance_app CANNOT UPDATE sources (can't approve own candidates)
-- (No UPDATE policy for balance_app — denied by default)

DROP POLICY IF EXISTS "public_read_balance_auth" ON "sources";
CREATE POLICY "public_read_balance_auth" ON "sources"
    FOR SELECT TO balance_auth USING (true);

-- ============================================================
-- 5. VERIFY
-- ============================================================
DO $$
DECLARE
    has_update_policy BOOLEAN;
BEGIN
    -- balance_app should NOT have UPDATE policy on sources
    SELECT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'sources'
          AND roles @> ARRAY['balance_app']::name[]
          AND cmd = 'UPDATE'
    ) INTO has_update_policy;

    IF has_update_policy THEN
        RAISE EXCEPTION 'balance_app has UPDATE policy on sources — should not (admin-only approval)';
    END IF;

    RAISE NOTICE 'Evidence integrity: triggers + source review status + RLS updated.';
END $$;
