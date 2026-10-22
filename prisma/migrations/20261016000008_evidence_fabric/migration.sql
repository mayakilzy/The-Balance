-- The Balance — Migration 20261016000008: Evidence Fabric + pre-setup fixes
-- Mission 00-04: Evidence and Scientific Source Fabric
--
-- This migration:
--   1. PRE-SETUP: Tighten balance_auth (remove table-level SELECT)
--   2. Create `sources` table (PUBLIC — global source registry)
--   3. Create `evidence` table (PRIVATE — tenant-scoped)
--   4. Create `evidence_embeddings` table (PRIVATE — pgvector for RAG)
--   5. RLS policies
--
-- Per ADR-0009 (evidence fabric design).

-- ============================================================
-- 1. PRE-SETUP: Tighten balance_auth
-- ============================================================
-- Founder note: "GRANT SELECT ON table" gave full column access,
-- overriding the column-level grants. Revoke table-level, keep column-level.
REVOKE SELECT ON "users" FROM balance_auth;
REVOKE SELECT ON "memberships" FROM balance_auth;
REVOKE SELECT ON "tenants" FROM balance_auth;

-- Column-level grants remain from migration 0007:
--   users: id, email, name, passwordHash, status
--   memberships: userId, tenantId, roleCode, status
--   tenants: id
-- These are sufficient for auth bootstrap queries.

-- ============================================================
-- 2. SOURCES TABLE (PUBLIC — global source registry)
-- ============================================================
-- A Source is a provenance record: where evidence came from.
-- PUBLIC because source metadata (name, URL, license) is shared.
-- Tenants reference sources in their private evidence.

CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "license" TEXT,
    "url" TEXT,
    "urlHash" TEXT,
    "independenceGroup" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sources_code_key" ON "sources"("code");
CREATE UNIQUE INDEX "sources_urlHash_key" ON "sources"("urlHash") WHERE "urlHash" IS NOT NULL;
CREATE INDEX "sources_type_idx" ON "sources"("type");
CREATE INDEX "sources_independenceGroup_idx" ON "sources"("independenceGroup");

-- ============================================================
-- 3. EVIDENCE TABLE (PRIVATE — tenant-scoped)
-- ============================================================
-- Evidence is a claim + provenance + verification status.
-- PRIVATE: each tenant's evidence is isolated via RLS.

CREATE TABLE "evidence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceId" TEXT,
    "claim" TEXT NOT NULL,
    "summary" TEXT,
    -- Type: 'supporting' | 'counter' | 'neutral'
    "type" TEXT NOT NULL DEFAULT 'neutral',
    -- Links to another evidence this supports/contradicts (for counter-evidence)
    "relatedEvidenceId" TEXT,
    -- Verification: 'unverified' | 'verified' | 'disputed' | 'refuted'
    "verificationStatus" TEXT NOT NULL DEFAULT 'unverified',
    -- Provenance: when was this observed vs when recorded
    "observedAt" TIMESTAMP(3),
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Extraction method: how the claim was extracted
    "extractionMethod" TEXT,
    -- Classification: 'public' | 'classified' | 'restricted'
    "classification" TEXT NOT NULL DEFAULT 'public',
    -- Confidence notes (qualitative, not a fake percentage)
    "confidenceNotes" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "evidence_tenantId_type_idx" ON "evidence"("tenantId", "type");
CREATE INDEX "evidence_tenantId_verificationStatus_idx" ON "evidence"("tenantId", "verificationStatus");
CREATE INDEX "evidence_tenantId_classified_idx" ON "evidence"("tenantId", "classification");
CREATE INDEX "evidence_relatedEvidenceId_idx" ON "evidence"("relatedEvidenceId") WHERE "relatedEvidenceId" IS NOT NULL;

ALTER TABLE "evidence"
    ADD CONSTRAINT "evidence_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "evidence"
    ADD CONSTRAINT "evidence_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "evidence"
    ADD CONSTRAINT "evidence_relatedEvidenceId_fkey"
    FOREIGN KEY ("relatedEvidenceId") REFERENCES "evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- 4. EVIDENCE_EMBEDDINGS TABLE (PRIVATE — pgvector for RAG)
-- ============================================================
-- Stores vector embeddings of evidence claims for similarity search.
-- PRIVATE: tenant-scoped (cross-tenant search blocked via RLS).

CREATE TABLE "evidence_embeddings" (
    "id" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "embedding" vector(384) NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "evidence_embeddings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "evidence_embeddings_evidenceId_key" ON "evidence_embeddings"("evidenceId");
CREATE INDEX "evidence_embeddings_tenantId_idx" ON "evidence_embeddings"("tenantId");

-- pgvector similarity index (IVFFlat for scalability)
CREATE INDEX "evidence_embeddings_embedding_idx"
    ON "evidence_embeddings"
    USING ivfflat ("embedding" vector_cosine_ops)
    WITH (lists = 100);

ALTER TABLE "evidence_embeddings"
    ADD CONSTRAINT "evidence_embeddings_evidenceId_fkey"
    FOREIGN KEY ("evidenceId") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "evidence_embeddings"
    ADD CONSTRAINT "evidence_embeddings_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 5. OWNERSHIP + GRANTS
-- ============================================================
ALTER TABLE "sources" OWNER TO balance_admin;
ALTER TABLE "evidence" OWNER TO balance_admin;
ALTER TABLE "evidence_embeddings" OWNER TO balance_admin;

-- Grant balance_app DML on evidence + evidence_embeddings (tenant-scoped)
GRANT SELECT, INSERT, UPDATE, DELETE ON "evidence", "evidence_embeddings" TO balance_app;
GRANT SELECT ON "sources" TO balance_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO balance_app;

-- balance_auth gets SELECT on sources (for evidence creation lookups)
GRANT SELECT (id, code, "displayName", type, license, url, "urlHash", "independenceGroup") ON "sources" TO balance_auth;

-- ============================================================
-- 6. ROW LEVEL SECURITY
-- ============================================================

-- sources: PUBLIC read for balance_app; admin write
ALTER TABLE "sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sources" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_balance_app" ON "sources";
CREATE POLICY "public_read_balance_app" ON "sources"
    FOR SELECT TO balance_app USING (true);

DROP POLICY IF EXISTS "public_read_balance_auth" ON "sources";
CREATE POLICY "public_read_balance_auth" ON "sources"
    FOR SELECT TO balance_auth USING (true);

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "sources";
CREATE POLICY "admin_all_balance_admin" ON "sources"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- evidence: tenant-scoped (PRIVATE)
ALTER TABLE "evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "evidence";
CREATE POLICY "tenant_isolation_balance_app" ON "evidence"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "evidence";
CREATE POLICY "admin_all_balance_admin" ON "evidence"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- evidence_embeddings: tenant-scoped (PRIVATE)
ALTER TABLE "evidence_embeddings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_embeddings" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_balance_app" ON "evidence_embeddings";
CREATE POLICY "tenant_isolation_balance_app" ON "evidence_embeddings"
    FOR ALL TO balance_app
    USING ("tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "admin_all_balance_admin" ON "evidence_embeddings";
CREATE POLICY "admin_all_balance_admin" ON "evidence_embeddings"
    FOR ALL TO balance_admin USING (true) WITH CHECK (true);

-- ============================================================
-- 7. VERIFY
-- ============================================================
DO $$
DECLARE
    rls_ok BOOLEAN;
    has_table_select BOOLEAN;
BEGIN
    -- RLS enabled + forced on all 3 new tables
    SELECT c.relrowsecurity AND c.relforcerowsecurity INTO rls_ok
    FROM pg_class c WHERE c.relname = 'sources';
    IF NOT rls_ok THEN RAISE EXCEPTION 'RLS not FORCE-enabled on sources'; END IF;

    SELECT c.relrowsecurity AND c.relforcerowsecurity INTO rls_ok
    FROM pg_class c WHERE c.relname = 'evidence';
    IF NOT rls_ok THEN RAISE EXCEPTION 'RLS not FORCE-enabled on evidence'; END IF;

    SELECT c.relrowsecurity AND c.relforcerowsecurity INTO rls_ok
    FROM pg_class c WHERE c.relname = 'evidence_embeddings';
    IF NOT rls_ok THEN RAISE EXCEPTION 'RLS not FORCE-enabled on evidence_embeddings'; END IF;

    -- balance_auth does NOT have table-level SELECT on users/memberships/tenants
    SELECT has_table_privilege('balance_auth', 'users', 'SELECT')
      INTO has_table_select;
    IF has_table_select THEN
        RAISE EXCEPTION 'balance_auth still has table-level SELECT on users — should be column-level only';
    END IF;

    RAISE NOTICE 'Evidence fabric tables created + balance_auth tightened (column-level only).';
END $$;
