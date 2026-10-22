# G04 — Government Reform Experience: Functional UI Map

**Date:** 2026-10-22
**Status:** Functional map — awaiting owner-approved visual references before implementation
**Author:** GLM (implementation agent)
**Owner:** Ayman
**Docs bridge:** `mayakilzy/repo-info/The-Balance-Doc`
**Code repo HEAD (G03-06 merged):** `e3e8071`
**Standard applied:** AgentCraft Universal Project Delivery & Visual Fidelity Standard v1.0 (pragmatic mode)

---

## 1. Target Journey

**Institution → Alert → Evidence → Reform Proposal → Human Approval → Multi-Institution Coordination → Status/Progress**

The user is a government official in a tenant (e.g., DML-MOP-TENANT — Ministry of Planning). They see a problem, examine its evidence, draft a reform proposal, get it approved, coordinate with another institution (DML-CB-TENANT — Central Bank), and track progress.

---

## 2. Five Connected Experiences

### Experience 1 — Reform Overview

**Purpose:** Landing page for the reform workflow. Shows the user's active proposals, open alerts, and coordinations in one glance.

**Existing reusable:**
- `GET /api/v1/reform/proposals` (list proposals for current tenant)
- `GET /api/v1/reform/coordinations` (list coordinations — lead or participant)
- `GET /api/v1/reform/actions` (list reform actions)

**API operations needed:**
- None new. Reuse the three list endpoints above.

**Missing UI:**
- A reform overview page (`/reform`) with three cards/sections: Open Alerts, Active Proposals, Coordinations.
- A simple stat row: counts of each.

**Backend additions:** None.

**User actions + data states:**
- Logged-in admin/analyst sees their tenant's reform portfolio at a glance.
- Empty state: "لا توجد مقترحات إصلاح بعد" with CTA to view alerts.
- Populated state: 3-5 cards showing title, status badge, last-updated date.

---

### Experience 2 — Alerts & Evidence

**Purpose:** Show alerts that signal problems needing reform. Each alert links to supporting evidence.

**Existing reusable:**
- `Alert` model + `alert-service.ts` (functions: `evaluateAndRaise`, `markReviewed`, `documentDecision`, `verifyExecution`, `closeAlert`)
- `GET /api/v1/evidence` (list evidence for current tenant)
- `GET /api/v1/evidence/search` (semantic search via pgvector)
- `GET /api/v1/evidence/:id/verify` (verify a source)

**API operations needed (small backend addition):**
- `GET /api/v1/alerts` — list alerts for current tenant (new route, reuses existing `alert-service.ts` query logic).
- `GET /api/v1/alerts/:id` — alert detail with linked evidence.

This is the **only genuinely necessary backend addition** in G04. The Alert model + service exist; there's just no HTTP route exposing them.

**Missing UI:**
- `/reform/alerts` — list of alerts (severity badge, title, lifecycle stage, date).
- Alert detail view: alert description, linked evidence list, "Create Reform Proposal" CTA.

**Backend additions:** 2 new route files (`/api/v1/alerts/route.ts` + `/api/v1/alerts/[id]/route.ts`). ~60 lines total. Reuses existing `Alert` model + `alert-service.ts`.

**User actions + data states:**
- Admin sees "Inflation above target" alert (severity: critical, stage: detected).
- Clicks alert → sees description + 2 supporting evidence items.
- Clicks "Create Reform Proposal" → navigates to proposal form with alert pre-linked.

---

### Experience 3 — Reform Proposals

**Purpose:** List + create reform proposals. Each proposal addresses an alert.

**Existing reusable:**
- `GET /api/v1/reform/proposals` (list)
- `POST /api/v1/reform/proposals` (create — supports `originatingAlertId` + `coordinationId`)
- `POST /api/v1/reform/proposals/[id]/submit` (submit for review)
- `POST /api/v1/reform/proposals/[id]/snapshot` (evidence snapshot)
- Reform advisor: `POST /api/v1/reform/advisor/draft-problem-statement`, `draft-alternatives`, `draft-comparison`, `draft-anticipated-outcomes` (Stub LLM — simulated drafts)

**API operations needed:** None new.

**Missing UI:**
- `/reform/proposals` — list of proposals (title, status badge, alert link, coordination link).
- "New Proposal" form: title, problem statement, optional alert link, optional coordination link.

**Backend additions:** None.

**User actions + data states:**
- Analyst creates a proposal linked to the alert from Experience 2.
- Proposal starts as `draft` → submit → `under_review`.
- Admin/reviewer sees pending proposals awaiting their decision.

---

### Experience 4 — Proposal Detail & Human Approval

**Purpose:** Single proposal view with problem statement, alternatives, and approve/reject actions.

**Existing reusable:**
- `GET /api/v1/reform/proposals/:id` (detail)
- `POST /api/v1/reform/proposals/:id/approve` (approve — requires `reform:proposal:approve`)
- `POST /api/v1/reform/proposals/:id/reject` (reject)
- `GET /api/v1/reform/proposals/:id/alternatives` (list alternatives)
- `POST /api/v1/reform/proposals/:id/alternatives` (add alternative)
- `POST /api/v1/reform/alternatives/:id/select` (select preferred alternative)
- `GET /api/v1/reform/proposals/:id/comparison` (advisor comparison)

**API operations needed:** None new.

**Missing UI:**
- `/reform/proposals/[id]` page with:
  - Proposal header: title, status badge, alert link, coordination link.
  - Problem statement section.
  - Alternatives list with "select" buttons (role-gated).
  - Approval actions: Approve / Reject buttons (visible only to `admin`/`reviewer`).
  - Audit trail: list of state transitions.

**Backend additions:** None.

**User actions + data states:**
- Admin reviews a `under_review` proposal.
- Reads problem statement + 2 alternatives.
- Clicks "Approve" → proposal transitions to `approved`.
- Audit log records the approval.

---

### Experience 5 — Coordination Workspace

**Purpose:** Multi-institution coordination view. Shows participants, shared snapshots, and coordination status — distinct from reform-action progress.

**Existing reusable:**
- `GET /api/v1/reform/coordinations` (list)
- `GET /api/v1/reform/coordinations/:id` (detail)
- `GET /api/v1/reform/coordinations/:id/shared-view` (cross-tenant shared view — coordination + participants + approved non-revoked snapshots)
- `POST /api/v1/reform/coordinations/:id/approve-plan` (action=submit|approve)
- `GET /api/v1/reform/coordinations/:id/snapshots` (list snapshots)
- `POST /api/v1/reform/coordinations/:id/snapshots/:snapId/approve` (privileged — uses `balance_snapshot_approver`)
- `POST /api/v1/reform/coordinations/:id/snapshots/:snapId/revoke`

**API operations needed:** None new. The shared-view already returns coordination + participants + snapshots.

**Missing UI:**
- `/reform/coordinations` — list of coordinations (title, status, lead tenant, participant count).
- `/reform/coordinations/[id]` — workspace page:
  - Coordination header: title, status badge, approval policy, lead tenant.
  - Participants list (tenant name, role, joined date).
  - Shared snapshots grid (title, summary, owner tenant, approved date).
  - Plan status: draft → plan_submitted → plan_approved → active → closed.
  - Linked proposals (filtered from shared-view — may need a small enrichment).

**Backend additions:** None for the core workspace. (Optional: enrich `shared-view` response to include linked proposal titles — currently returns snapshot IDs only. This is a 10-line service enhancement, not a new route.)

**User actions + data states:**
- Lead (Tenant A) sees their coordination with Tenant B as participant.
- Plan submitted → approved → coordination `active`.
- Shared snapshot created by Tenant A → approved → visible to Tenant B.
- Tenant B switches tenant → sees the same coordination from participant perspective.

---

## 3. Critical Distinction: Coordination Status vs. Reform-Action Progress

These are **two separate concepts** that the UI must NOT conflate:

| Concept | What it means | Data source | States |
|---------|---------------|-------------|--------|
| **Coordination status** | The multi-institution coordination lifecycle — has the plan been submitted and approved by all parties? | `reform_coordinations.status` | draft → plan_submitted → plan_approved → active → closed → superseded |
| **Reform-action progress** | The actual execution progress of a reform action — is the work being done? | `reform_actions.status` + `progressPercentage` + `reform_action_updates` | pending → in_progress → completed / cancelled |

**Why this matters:** A coordination can be `active` (plan approved, institutions aligned) while its reform actions are still `pending` (work hasn't started). Conversely, actions can be `in_progress` even before the coordination is `active` (parallel work). The UI must show both dimensions independently, not collapse them into a single "progress bar."

**UI rule:** The coordination workspace shows coordination status as the lifecycle badge. A separate "Actions" section (or sub-page) shows reform-action progress with its own status + percentage + updates timeline. Do NOT derive one from the other.

---

## 4. Reusable Infrastructure Summary

| Layer | What exists | What's missing |
|-------|-------------|----------------|
| **DB models** | Alert, Evidence, ReformProposal, ReformAlternative, ReformAction, ReformCoordination, ReformCoordinationSharedSnapshot, audit_log | Nothing new |
| **Services** | alert-service, evidence services, reform-proposal-service, reform-action-service, coordination-service (18 functions), reform-advisor-service | Nothing new |
| **API routes** | 55 active routes (auth, evidence, reform, coordination, tasks, capabilities) | 2 new routes for `/api/v1/alerts` (list + detail) |
| **UI pages** | `/`, `/login`, `/evidence`, `/tasks`, `/capabilities` | 5 new pages under `/reform/*` |
| **Components** | `home-client.tsx` (header + nav pattern) | Reusable header/sidebar will be extracted as shared component |

**Total new backend work:** 2 route files (~60 lines), reusing existing `alert-service.ts`.

**Total new UI work:** 5 pages + 1 nav update. All client components fetching from existing APIs.

---

## 5. Realistic Data States (Demo Fixtures)

The seed already includes:
- 2 tenants: DML-MOP-TENANT (Ministry of Planning), DML-CB-TENANT (Central Bank)
- 1 coordination: "Monetary Policy Alignment" (Tenant A lead, Tenant B participant)
- 1 reform proposal: "Monetary Discipline" (approved, no alert link)
- 1 reform action: "Publish Inflation Targeting Mandate" (in_progress, 40%)
- 1 approved shared snapshot

**Seed gap to close in G04:**
- Add 1-2 alerts in DML-MOP-TENANT (linked to a strategy version — or make `strategyVersionId` nullable for manual alerts).
- Link the existing seed proposal to an alert via `originatingAlertId`.
- Add 1 reform action update to show progress tracking.

This is a seed-script update, not a migration.

---

## 6. Implementation Sequence (after visual references are approved)

Per AgentCraft standard §6 (Visual-first, source-driven implementation):

1. **Owner + ChatGPT** approve visual direction + create HTML/CSS references in `The-Balance-Doc/UI_UX_DESIGN/IMPLEMENTATION_READY/`.
2. **GLM** imports each page's HTML/CSS into Next.js/React, connects real APIs.
3. **Per-page acceptance loop** (standard §8): Design Lock → Source Build → Source Screenshot → Source Comparison → Developer Import → Browser Verification → App Comparison → Corrections → Dual Repo Delivery → Owner Verdict.
4. **G04 closes** when all 5 pages pass the four quality gates (Visual Fidelity, Functional Fidelity, Responsive/A11y/Language, Evidence & Delivery Integrity).

---

## 7. What I Will NOT Do (until visual references are ready)

- Independently invent or finalize the G04 interface design.
- Start comprehensive UI implementation.
- Create a hierarchy of new sub-missions.
- Build new backend services beyond the 2 alert routes.
- Reopen G03-06 security decisions.

---

## 8. Next Step

**Awaiting:** Owner-approved visual references (HTML/CSS) published to `The-Balance-Doc/UI_UX_DESIGN/IMPLEMENTATION_READY/`.

Once references are ready, G04 implementation begins with Experience 1 (Reform Overview) and proceeds sequentially through the 5 experiences, each following the per-page acceptance loop.

---

**End of functional map. Do not start implementation without approved visual references.**
