-- The Balance — Migration 00010: Allow balance_app to INSERT into sources
-- Evidence creation needs to create source records when they don't exist.
-- Sources are PUBLIC metadata — allowing tenants to add references is acceptable.

-- Grant INSERT on sources to balance_app
GRANT INSERT ON "sources" TO balance_app;

-- RLS: balance_app can INSERT (no tenant restriction — sources are global)
DROP POLICY IF EXISTS "public_insert_balance_app" ON "sources";
CREATE POLICY "public_insert_balance_app" ON "sources"
    FOR INSERT TO balance_app
    WITH CHECK (true);
