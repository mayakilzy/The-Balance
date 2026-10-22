-- ============================================================
-- The Balance — Migration 0029: G03-06 Column-Level UPDATE Boundary
-- Mission G03-06-D2-D3-CLOSURE: Part A — narrow UPDATE to specific columns
--
-- PROBLEM: Migration 28's RLS policy restricts OLD/NEW status values
-- (USING plan_approved, WITH CHECK active), but RLS does NOT prevent
-- updating other columns in the same UPDATE statement. An UPDATE that
-- sets status='active' AND title='modified' would pass the RLS check.
--
-- SOLUTION: REVOKE the broad table-level UPDATE, then GRANT UPDATE
-- on ONLY the columns the activation trigger needs: status, activatedAt, updatedAt.
-- ============================================================

REVOKE UPDATE ON "reform_coordinations" FROM balance_coordination_admin;
GRANT UPDATE ("status", "activatedAt", "updatedAt") ON "reform_coordinations" TO balance_coordination_admin;
