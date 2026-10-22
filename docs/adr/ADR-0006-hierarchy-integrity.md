# ADR-0006 — Country Hierarchy Integrity

**Date:** 2026-10-16
**Status:** Accepted (founder-mandated); updated 00-02 final integrity closure
**Mission:** 00-02 (initial + corrective + final closure)

## Updates in final integrity closure (00-02)

1. **Cycle detection**: triggers now prevent A → B → A cycles in both `state_hierarchy` and `institutions`. See §"Cycle detection" below.
2. **Country immutability with children**: changing `countryId` of a node that has children is blocked. See §"Country change with children" below.

## Context

The founder identified a data integrity gap in 00-02:

> "العلاقات الذاتية في StateHierarchy و Institution لا تفرض انتماء الأب والابن إلى الدولة نفسها. قد تسمح البيانات بربط مؤسسة في دولة بمؤسسة أم في دولة أخرى، مما يفسد النموذج الوطني."

(Translation: The self-referential relations in StateHierarchy and Institution don't enforce that parent and child belong to the same country. Data could link an institution in one country to a parent institution in another, breaking the national model.)

**The problem:** A `StateHierarchy` row has `countryId` and `parentId`. Nothing prevented inserting a row with `countryId='DML'` (Demolandia) but `parentId` pointing to a row in country `ZZT` (Testlandia). The same applied to `Institution`.

This breaks the national model: each country's administrative geography and institutional structure should be a closed tree.

## Decision

Enforce parent-child country consistency at the database level using triggers.

### Implementation (migration 20261016000003)

Two trigger functions + triggers:

```sql
-- StateHierarchy: parent must be in the same country as child
CREATE OR REPLACE FUNCTION enforce_state_hierarchy_country() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."parentId" IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "state_hierarchy"
            WHERE id = NEW."parentId" AND "countryId" = NEW."countryId"
        ) THEN
            RAISE EXCEPTION
                'StateHierarchy integrity violation: parent % is not in country %',
                NEW."parentId", NEW."countryId"
                USING HINT = 'Parent and child must belong to the same country.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "state_hierarchy_country_check"
    BEFORE INSERT OR UPDATE OF "parentId", "countryId" ON "state_hierarchy"
    FOR EACH ROW EXECUTE FUNCTION enforce_state_hierarchy_country();
```

The same pattern applies to `institutions` with `enforce_institution_country()`.

### Why triggers, not CHECK constraints?

PostgreSQL `CHECK` constraints cannot reference other rows. A CHECK like `CHECK (parentId IS NULL OR (SELECT countryId FROM state_hierarchy WHERE id = parentId) = countryId)` is invalid — subqueries are not allowed in CHECK.

Alternatives considered:
- **Application-level validation:** Rejected — founder explicitly requires DB-level enforcement. Application bugs or direct SQL access could bypass it.
- **Deferred constraint:** Not applicable — this is an intra-table consistency check, not a cross-table FK.
- **Trigger:** The standard PostgreSQL approach for row-level cross-row validation. Fires BEFORE INSERT/UPDATE, raises exception on violation.

### Trigger scope

The trigger fires on:
- `INSERT` — validates new rows.
- `UPDATE OF "parentId", "countryId"` — validates when either field changes. Does NOT fire on updates to other fields (e.g., `displayName`), avoiding unnecessary overhead.

### Error message

The exception includes:
- The parent ID that failed.
- The child's country ID.
- A hint: "Parent and child must belong to the same country."

This makes the error actionable for developers and DBAs.

## Verification (integration tests)

Tests 13 + 14 in `tests/integration/rls-isolation.integration.test.ts`:

- **Test 13:** "StateHierarchy cannot have parent in a different country"
  - Creates Testlandia country + province.
  - Attempts to create a Demolandia district with Testlandia parent.
  - Asserts the operation throws with `/same country/i`.

- **Test 14:** "Institution cannot have parent in a different country"
  - Same pattern for institutions.

Both tests use `balance_admin` (BYPASSRLS) to set up the cross-border scenario, since `balance_app` cannot write to PUBLIC tables.

## Consequences

- **Positive:** Database-enforced national integrity. No application bug or direct SQL access can create cross-country hierarchy links. The national model is preserved.
- **Negative:** Slight overhead on INSERT/UPDATE of `parentId` or `countryId` (one extra SELECT per write). Acceptable — these are low-frequency operations.
- **Future impact:** When `Evidence` (00-04) or `Strategy` (00-05) reference `StateHierarchy` or `Institution`, they inherit the integrity guarantee. No additional checks needed in those tables.

## Forward note for 00-03

The founder also noted:

> "متغير app.tenant_id ليس إثباتاً لهوية المستخدم بحد ذاته. يجب ربطه بعضوية موثوقة في المستأجر وصلاحيات فعلية، مع ضمان عدم قدرة العميل على اختيار مستأجر آخر بمجرد إرسال معرف مختلف."

(Translation: `app.tenant_id` is not proof of user identity by itself. It must be bound to a verified tenant membership + real permissions, with guarantee that a client cannot pick another tenant by sending a different ID.)

This is a 00-03 concern (Identity, Permissions, full Auth). The 00-02 corrective closure does NOT address it — it's out of scope. The 00-03 mission will:
1. Add `User` + `Membership` models (User ↔ Tenant with role).
2. Bind `app.tenant_id` to the authenticated session, not to client-supplied input.
3. Verify the user's membership in the tenant before setting `app.tenant_id`.
4. Reject requests where the client attempts to switch tenants without authorization.

## Cycle detection (final integrity closure)

**Problem identified by founder:** The migration 0003 triggers prevent cross-country parents, but do NOT prevent cycles (A → B → A). A cycle would make the hierarchy untraversable and break recursive queries.

**Solution (migration 20261016000004):**
Two trigger functions that walk up the parent chain from `NEW.parentId`:
- `enforce_state_hierarchy_no_cycles()` — for `state_hierarchy`.
- `enforce_institution_no_cycles()` — for `institutions`.

**Algorithm:**
1. Start at `NEW.parentId`.
2. Walk up via `SELECT parentId FROM <table> WHERE id = current_id`.
3. If we encounter `NEW.id`, it's a cycle → raise exception.
4. Safety bound: max 64 levels. If exceeded, raise exception (likely pre-existing corruption).

**Why walk-up, not recursive CTE?**
- Triggers cannot use recursive CTEs on the same table being modified (mutation in flight).
- Walk-up with a bounded loop is safe and simple.
- The 64-level bound is generous — real hierarchies are rarely deeper than 10.

**Verified by integration tests:**
- Test 16: "StateHierarchy rejects cycles (A → B → A)"
- Test 17: "Institution rejects cycles (A → B → A)"

## Country change with children (final integrity closure)

**Problem identified by founder:** The migration 0003 trigger on a child checks that its parent is in the same country. But if a parent's `countryId` is changed AFTER it has children, the children's parent reference becomes inconsistent (child in country X, parent now in country Y). The child trigger would reject future updates to children, but the damage is already done.

**Solution (migration 20261016000004):**
Two trigger functions that block `countryId` changes on nodes with children:
- `enforce_state_hierarchy_country_immutable_with_children()`
- `enforce_institution_country_immutable_with_children()`

**Behavior:**
- Fires on `BEFORE UPDATE OF "countryId"`.
- If `NEW.countryId IS DISTINCT FROM OLD.countryId` AND the node has children → raise exception.
- If the node has no children, the change is allowed (no inconsistency possible).

**Workaround for legitimate country changes:**
1. Re-parent or delete all children first.
2. Then change the parent's `countryId`.
3. Re-create children in the new country.

This is intentional friction — country changes are rare and should be deliberate.

**Verified by integration tests:**
- Test 18: "StateHierarchy blocks countryId change when node has children"
- Test 19: "Institution blocks countryId change when node has children"
