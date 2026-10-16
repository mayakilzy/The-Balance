// ============================================================
// evidence-service.ts — Evidence creation + vector search
// ------------------------------------------------------------
// Handles:
//   - Creating evidence with provenance
//   - Linking supporting/counter evidence
//   - Generating embeddings via LLMProvider
//   - pgvector similarity search
//   - Source dedup + independence counting
// ============================================================
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { getLLMProvider } from "@/lib/llm";
import { withAuthenticatedTenant } from "@/lib/security/tenant-context";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

// ============================================================
// SOURCE HELPERS
// ============================================================

export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/**
 * Find or create a source by URL.
 * Dedup: if a source with the same urlHash exists, return it.
 */
export async function findOrCreateSource(
  tx: Prisma.TransactionClient,
  params: {
    code: string;
    displayName: string;
    type: string;
    license?: string;
    url?: string;
    independenceGroup?: string;
  }
) {
  const urlHash = params.url ? hashUrl(params.url) : null;

  if (urlHash) {
    const existing = await tx.source.findUnique({ where: { urlHash } });
    if (existing) return existing;
  }

  return await tx.source.create({
    data: {
      code: params.code,
      displayName: params.displayName,
      type: params.type,
      license: params.license,
      url: params.url,
      urlHash,
      independenceGroup: params.independenceGroup,
    },
  });
}

// ============================================================
// EVIDENCE CREATION
// ============================================================

export interface CreateEvidenceInput {
  claim: string;
  summary?: string;
  type?: "supporting" | "counter" | "neutral";
  relatedEvidenceId?: string;
  verificationStatus?: "unverified" | "verified" | "disputed" | "refuted";
  observedAt?: Date;
  extractionMethod?: string;
  classification?: "public" | "classified" | "restricted";
  confidenceNotes?: string;
  metadata?: Record<string, unknown>;
  source?: {
    code: string;
    displayName: string;
    type: string;
    license?: string;
    url?: string;
    independenceGroup?: string;
  };
}

export async function createEvidence(
  session: Session,
  input: CreateEvidenceInput
): Promise<{ evidenceId: string; embeddingGenerated: boolean }> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // Find or create source (if provided)
    let sourceId: string | undefined;
    if (input.source) {
      const source = await findOrCreateSource(tx, input.source);
      sourceId = source.id;
    }

    // Create evidence
    const evidence = await tx.evidence.create({
      data: {
        tenantId,
        sourceId,
        claim: input.claim,
        summary: input.summary,
        type: input.type ?? "neutral",
        relatedEvidenceId: input.relatedEvidenceId,
        verificationStatus: input.verificationStatus ?? "unverified",
        observedAt: input.observedAt,
        extractionMethod: input.extractionMethod,
        classification: input.classification ?? "public",
        confidenceNotes: input.confidenceNotes,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });

    // Generate embedding via LLM provider
    const provider = getLLMProvider();
    const embedResult = await provider.embed({
      input: input.claim,
      dimensions: 384,
    });

    // Store embedding via raw SQL (Prisma doesn't support pgvector directly)
    const vectorLiteral = `[${embedResult.vectors[0]!.join(",")}]`;
    await tx.$executeRaw`
      INSERT INTO "evidence_embeddings" ("id", "evidenceId", "tenantId", "embedding", "model", "createdAt")
      VALUES (gen_random_uuid()::text, ${evidence.id}, ${tenantId}, ${vectorLiteral}::vector, ${provider.defaultEmbeddingModel}, NOW())
    `;

    return {
      evidenceId: evidence.id,
      embeddingGenerated: true,
    };
  });
}

// ============================================================
// VECTOR SEARCH
// ============================================================

export interface SearchResult {
  evidenceId: string;
  claim: string;
  summary: string | null;
  type: string;
  verificationStatus: string;
  sourceCode: string | null;
  sourceDisplayName: string | null;
  similarity: number;
}

/**
 * Search evidence via pgvector similarity.
 * Returns only evidence in the authenticated tenant's scope (RLS-enforced).
 */
export async function searchEvidence(
  session: Session,
  query: string,
  limit: number = 10
): Promise<SearchResult[]> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    // Generate embedding for the query
    const provider = getLLMProvider();
    const embedResult = await provider.embed({
      input: query,
      dimensions: 384,
    });
    const queryVector = `[${embedResult.vectors[0]!.join(",")}]`;

    // pgvector similarity search via raw SQL.
    // RLS on evidence + evidence_embeddings ensures tenant isolation.
    const results = await tx.$queryRaw<SearchResult[]>`
      SELECT
        e."id" AS "evidenceId",
        e."claim",
        e."summary",
        e."type",
        e."verificationStatus",
        s."code" AS "sourceCode",
        s."displayName" AS "sourceDisplayName",
        1 - (ee."embedding" <=> ${queryVector}::vector) AS "similarity"
      FROM "evidence" e
      JOIN "evidence_embeddings" ee ON ee."evidenceId" = e."id"
      LEFT JOIN "sources" s ON s."id" = e."sourceId"
      WHERE e."tenantId" = ${tenantId}
      ORDER BY ee."embedding" <=> ${queryVector}::vector
      LIMIT ${limit}
    `;

    return results;
  });
}

// ============================================================
// COUNTER-EVIDENCE
// ============================================================

export async function addCounterEvidence(
  session: Session,
  originalEvidenceId: string,
  input: Omit<CreateEvidenceInput, "relatedEvidenceId" | "type">
): Promise<{ evidenceId: string }> {
  return createEvidence(session, {
    ...input,
    type: "counter",
    relatedEvidenceId: originalEvidenceId,
  });
}

// ============================================================
// SOURCE INDEPENDENCE
// ============================================================

/**
 * Count INDEPENDENT sources for a set of evidence.
 * Sources in the same independenceGroup are counted as ONE.
 */
export async function countIndependentSources(
  session: Session,
  evidenceIds: string[]
): Promise<{ totalSources: number; independentSources: number }> {
  return withAuthenticatedTenant(session, async ({ tx, tenantId }) => {
    const evidence = await tx.evidence.findMany({
      where: {
        id: { in: evidenceIds },
        tenantId,
      },
      select: { sourceId: true, source: { select: { independenceGroup: true } } },
    });

    const sources = evidence.filter((e) => e.sourceId);
    const totalSources = new Set(sources.map((e) => e.sourceId)).size;

    // Group by independenceGroup; null = each is its own group
    const groups = new Set<string>();
    for (const e of sources) {
      const group = e.source?.independenceGroup ?? e.sourceId!;
      groups.add(group);
    }
    const independentSources = groups.size;

    return { totalSources, independentSources };
  });
}
