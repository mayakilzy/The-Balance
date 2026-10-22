# ADR-0009 — Evidence Fabric Design

**Date:** 2026-10-16
**Status:** Accepted
**Mission:** 00-04

## Context

The Balance requires a scientific evidence fabric — the foundation of trust for all conclusions about a state. The founder directed:
- Full provenance (source, claim, timing, extraction method)
- Supporting + counter-evidence linked to claims
- Source independence (don't count syndicated articles as independent)
- RLS on private evidence, public evidence shareable per policy
- Real vector search via pgvector
- Separate verified vs experimental

## Decision

### Three-table model

1. **`sources`** (PUBLIC) — global source registry
   - `code` (unique), `displayName`, `type`, `license`, `url`, `urlHash`
   - `independenceGroup` — sources in the same group are NOT independent (syndication)
   - RLS: balance_app SELECT only; balance_admin write

2. **`evidence`** (PRIVATE, tenant-scoped) — claims + provenance
   - `claim`, `summary`, `type` (supporting/counter/neutral)
   - `relatedEvidenceId` — links counter-evidence to original
   - `verificationStatus` (unverified/verified/disputed/refuted)
   - `observedAt` (when the event happened) vs `retrievedAt` (when recorded)
   - `extractionMethod`, `classification`, `confidenceNotes`
   - RLS: tenant-scoped (`tenantId = app.tenant_id`)

3. **`evidence_embeddings`** (PRIVATE, tenant-scoped) — pgvector for RAG
   - `embedding` column: `vector(384)` (pgvector)
   - `model` — which embedding model produced this
   - RLS: tenant-scoped
   - IVFFlat index for scalability

### Provenance fields

Every evidence record carries:
- **Source**: link to `sources` table (provenance origin)
- **Claim**: the assertion extracted from the source
- **observedAt**: when the real-world event occurred
- **retrievedAt**: when the evidence was recorded in the system
- **extractionMethod**: how the claim was extracted (manual, api, interview, wire)
- **confidenceNotes**: qualitative assessment (NOT a fake percentage)

### Supporting vs counter-evidence

- `type: "supporting"` — evidence that supports a conclusion
- `type: "counter"` — evidence that contradicts; links via `relatedEvidenceId`
- `type: "neutral"` — factual observation, no stance

Counter-evidence is a first-class citizen — the system doesn't hide it.

### Source independence

- `independenceGroup` column on `sources`
- Sources in the same group (e.g., syndicated news feeds) are counted as ONE independent source
- `countIndependentSources()` helper: groups by `independenceGroup`, counts unique groups
- This prevents "20 articles from the same wire service = 20 independent sources"

### Vector search

- pgvector `vector(384)` column (384-dim matches common embedding models)
- IVFFlat index for approximate nearest neighbor search
- `searchEvidence()` uses cosine similarity (`<=>` operator)
- RLS ensures cross-tenant search is blocked
- Returns `similarity` score (0-1) for traceability

### Embedding generation

- Uses `LLMProvider.embed()` from the provider abstraction (ADR-0002)
- In 00-04: `StubProvider` (deterministic, SIMULATED — not real embeddings)
- In 00-06: `ZaiProvider` will provide real embeddings
- The interface is stable; only the provider changes

### RLS policies

- `sources`: PUBLIC read (any tenant can see source metadata)
- `evidence`: tenant-scoped (PRIVATE — only own tenant's evidence)
- `evidence_embeddings`: tenant-scoped (PRIVATE)

### API endpoints

- `POST /api/v1/evidence` — create evidence (requires `evidence:write`)
- `GET /api/v1/evidence` — list own tenant's evidence (requires `evidence:read`)
- `GET /api/v1/evidence/search?q=...` — vector search (requires `evidence:read`)

### Permission additions

- `evidence:read` — observer, analyst, reviewer, admin
- `evidence:write` — analyst, admin
- `evidence:verify` — reviewer, admin (change verification status)
- `evidence:delete` — admin only

## Alternatives considered

### Full-text search instead of vector search
- **Rejected**: Full-text search can't capture semantic similarity. "Agricultural growth" and "farming expansion" would not match. Vector search does.

### External vector DB (Pinecone, Weaviate)
- **Rejected for 00-04**: Adds operational complexity. pgvector handles 00-04's scale. Revisit if evidence count exceeds millions.

### Real embeddings in 00-04
- **Deferred to 00-06**: StubProvider is sufficient to test the pipeline. Real embeddings require the ZaiProvider (mission 00-06).

### AgentCraft-Toolkit Python service
- **Not used in 00-04**: No proven need. The TypeScript LLMProvider abstraction handles embeddings. AgentCraft-Toolkit's `vectorization/` Python modules are a reference for patterns but not imported.

## Consequences

- **Positive**: Real vector search. Counter-evidence is first-class. Source independence prevents false confidence. RLS enforces tenant isolation.
- **Negative**: pgvector adds a dependency (pgvector extension). IVFFlat index needs periodic reindexing as evidence grows.
- **Future impact**: When `Strategy` (00-05) references evidence, it can use the same vector search for evidence-backed strategy formulation.

## Verification (00-04)

1. Create evidence with full provenance → all fields persisted
2. Create counter-evidence → linked via `relatedEvidenceId`
3. Vector search → returns results with similarity scores
4. Source dedup → syndicated sources counted as one independent
5. Cross-tenant search → blocked by RLS
6. Embedding generated for every evidence
7. `observedAt` vs `retrievedAt` are distinct

## Honest classification

- **Embeddings are SIMULATED** (StubProvider — deterministic, not real semantic embeddings)
- **Real embeddings** will be added in 00-06 when ZaiProvider is implemented
- The vector search pipeline is REAL (pgvector + cosine similarity) — only the embedding quality is simulated
- This is honestly disclosed in the seed output and UI footer
