# NEXT_FUNCTIONAL_DELIVERY

**Date:** 2026-10-22
**Author:** GLM (implementation agent)
**Owner:** Ayman
**Status:** Proposal — awaiting owner's functional scope approval

---

## 1. What Already Works (Backend)

G03-06 closed with 32 migrations, 51 HTTP tests passing, CI + Recovery green at `a88050e`. The backend is substantially complete:

| Capability | API Routes | Status |
|-----------|------------|--------|
| Auth (signin/signout/switch-tenant/me) | 4 | ✅ Working |
| Evidence (create/list/search/verify) | 4 | ✅ Working |
| Reform proposals (create/submit/approve/reject/close-alert/snapshot) | 9 | ✅ Working |
| Reform alternatives (select/withdraw) | 2 | ✅ Working |
| Reform actions (start/complete/verify/updates/feedback) | 8 | ✅ Working |
| Reform advisor (draft problem/alternatives/comparison/outcomes) | 4 | ✅ Working (Stub LLM) |
| Reform coordinations (create/list/get/close/participants/invitations/plan/snapshots/shared-view) | 16 | ✅ Working (G03-06) |
| Tasks (create/list/get/update) | 2 | ✅ Working |
| Capabilities (list/invoke) | 2 | ✅ Working |
| Countries, Meta, Health, Metrics | 4 | ✅ Working |

**Total: 55 active HTTP routes** — all RLS-enforced, audit-logged, with the privileged snapshot approval path now running through a dedicated `balance_snapshot_approver` connection.

## 2. What the User Can Currently Do

A logged-in admin/analyst/reviewer/observer can:

- **View system health + tenant context** on the home page
- **Manage evidence** (create, list, verify) — `/evidence`
- **Manage tasks** (create, list, update) — `/tasks`
- **View capabilities registry** — `/capabilities`

A user **cannot currently**:
- See alerts or the observatory
- Create or view reform proposals via UI
- Draft reform alternatives via UI
- Approve/reject proposals via UI
- View or manage coordinations via UI
- Track reform action progress via UI

The entire reform workflow (proposals → alternatives → actions → coordinations) is backend-only — no UI exists.

## 3. What's Missing for the End-to-End Workflow

The target user experience:

**Institution → Problem/Alert → Analysis → Reform Proposal → Human Approval → Multi-Institution Coordination → Progress View**

### Gap analysis

| Step | Backend | UI | Seed Data |
|------|---------|-----|-----------|
| Institution context | ✅ (tenant + membership) | ✅ (home page) | ✅ (DML-MOP + DML-CB) |
| Alert/problem | ⚠️ (Alert model exists; no API route) | ❌ | ❌ (no DML alerts) |
| Analysis (advisor) | ✅ (4 advisor routes) | ❌ | — |
| Reform proposal | ✅ (9 routes) | ❌ | ⚠️ (1 seed, no alert link) |
| Human approval | ✅ (approve/reject routes) | ❌ | — |
| Multi-institution coordination | ✅ (16 routes, G03-06) | ❌ | ✅ (1 seed coordination) |
| Progress view (actions) | ✅ (8 routes) | ❌ | ✅ (1 seed action, 40%) |

### Three gaps to close

1. **No alerts API + no seed alerts** — the workflow entry point doesn't exist as an API. Alert model + observatory services exist, but there's no `/api/v1/alerts` route.
2. **No reform UI** — the entire reform lifecycle (proposals, alternatives, actions, coordinations) has no pages.
3. **Seed data gap** — the DML tenant has no alerts linked to reform proposals. The existing seed proposal has no `originatingAlertId`.

## 4. Minimum UI + API Integration Work

### Phase A: Alerts API + seed (small)

- **Add** `GET /api/v1/alerts` (list alerts for current tenant) + `GET /api/v1/alerts/:id` (detail)
- **Add** seed: 1 alert in DML-MOP-TENANT linked to a strategy version (or make `strategyVersionId` nullable for manual alerts)
- **Effort:** ~1 route file + seed update. Reuses existing `Alert` model + observatory query service.

### Phase B: Reform UI — 4 pages (medium)

Create these pages under `src/app/reform/`:

1. **`/reform/alerts`** — list alerts; click → detail
2. **`/reform/proposals`** — list proposals; "New Proposal" button (links alert → proposal)
3. **`/reform/proposals/[id]`** — proposal detail: problem statement, alternatives, approve/reject buttons (role-gated)
4. **`/reform/coordinations`** — list coordinations; click → shared-view (participants, approved snapshots)

Each page is a client component that fetches from the existing API routes. No new backend work needed for Phase B — all 16 coordination routes + 9 proposal routes already exist.

### Phase C: Coordination progress view (small)

- **Add** `/reform/coordinations/[id]` page showing: coordination status, participants, approved snapshots, linked proposals
- Reuses `GET /coordinations/:id/shared-view` (already exists)

### Phase D: Home page nav update (trivial)

- Add "الإصلاح" (Reform) card to home page linking to `/reform/alerts`

### Not included (deferred)

- Reform action progress tracking UI (actions API works; UI can be added later)
- Advisor drafting UI (advisor API works; can be invoked from proposal page later)
- Variance/observatory dashboards (observatory services exist; UI is a larger effort)

## 5. Acceptance Scenario (Demonstrable)

After this delivery, the owner can demonstrate:

1. **Sign in** as `admin@demolandia.test` (DML-MOP-TENANT admin)
2. **View alerts** at `/reform/alerts` — see "Inflation above target" alert
3. **Click alert** → see detail → click "Create Reform Proposal"
4. **Create proposal** — title, problem statement, link to alert
5. **Submit proposal** → status: `under_review`
6. **Approve proposal** (as admin) → status: `approved`
7. **View coordination** at `/reform/coordinations` — see "Monetary Policy Alignment" coordination
8. **Open coordination** → see Tenant A (lead) + Tenant B (participant) + approved shared snapshot
9. **Switch tenant** to DML-CB-TENANT → see the same coordination from Tenant B's perspective

This demonstrates the full chain: **Institution → Alert → Proposal → Approval → Coordination → Shared View** — all backed by real PostgreSQL + RLS + audit logs.

## 6. Proposed Next Development Mission

**Mission:** `G04-01-REFORM-UI` — Product-First Reform Workflow

**Scope:**
- Phase A: Alerts API (2 routes) + seed update
- Phase B: 4 reform UI pages (alerts, proposals list, proposal detail, coordinations list)
- Phase C: Coordination detail page (shared-view)
- Phase D: Home nav update

**Out of scope:**
- New backend services (reuse all existing 55 routes)
- New security missions (G03-06 closed)
- Action progress UI, advisor drafting UI, observatory dashboards

**Expected user-visible result:** A government official can sign in, see a real alert, create a reform proposal, approve it, and view the multi-institution coordination — all in the running application, with real data persistence and tenant isolation.

**Estimated effort:** 1 development session (UI-heavy, minimal backend)

**Acceptance test:** Manual walkthrough of the 9-step scenario above + existing 51 HTTP tests remain green.

---

## Development Principles (adopted)

- Working functionality first.
- Simple, maintainable implementation.
- Essential security and automated testing included.
- Fix ordinary implementation defects without requesting a separate mission.
- Report progress through working features, not document counts.
- Escalate only decisions that materially change scope, security or architecture.

---

**Do not start the next development group until the owner approves its functional scope.**
