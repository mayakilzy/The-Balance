// ============================================================
// src/lib/reform/advisor-receipt.ts
// ------------------------------------------------------------
// G03-04-PRE-03 — Trusted AI Provenance Receipt Module
//
// Implements the signed-receipt pattern for advisor provenance.
// Per OD-5 final design + reviewer security clarifications:
//
//   1. Bounded reuse (not single-use):
//      A nonce and TTL alone do not enforce one-time use. This
//      module implements bounded reuse: every save independently
//      satisfies authorization, proposal status, alternative
//      limits, locking, and atomic audit. The receipt is a
//      trustworthy provenance WITNESS, not the sole security
//      gate. Replay is bounded by TTL (1 hour); the nonce
//      identifies the receipt uniquely for observability.
//
//   2. Hybrid attribution precision:
//      When the submitted content's SHA-256 differs from the
//      receipt's draftHash, the receipt proves only that a valid
//      AI-generated draft was ASSOCIATED with the human
//      submission. It does NOT claim that every word originated
//      from the model or that the edit was semantically derived
//      from the original. draftedVia = "hybrid" is a
//      provenance marker, not a semantic guarantee.
//
//   3. Dedicated purpose-separated signing key:
//      Uses HKDF-SHA256 to derive a sub-key from AUTH_SECRET
//      with context "g03-04-advisor-receipt-v1". This avoids
//      reusing AUTH_SECRET directly across multiple security
//      purposes (session signing, receipt signing, etc.).
//
//   4. Timing-safe comparison:
//      HMAC verification uses crypto.timingSafeEqual to prevent
//      timing-based signature oracle attacks.
//
//   5. Strictly validated payload schema:
//      After JSON parse, the payload is validated via Zod
//      before any field is trusted.
//
//   6. Canonical content hashing:
//      SHA-256 of UTF-8 encoded string, computed identically
//      at issuance and verification.
//
//   7. Cross-purpose reuse prevention:
//      Receipt includes a `purpose` field (e.g.,
//      "draft_alternatives"). Verified at save time to match
//      the expected purpose for the save endpoint.
// ============================================================
import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/env";
import {
  AdvisorReceiptPurposeSchema,
  type AdvisorReceiptPurpose,
  ReceiptVerificationError,
} from "./contracts";

// ============================================================
// Constants
// ============================================================

const RECEIPT_TTL_MS = 60 * 60 * 1000; // 1 hour
const SIGNING_KEY_INFO = "g03-04-advisor-receipt-v1"; // HKDF context
const SIGNING_KEY_LENGTH = 32; // 256-bit HMAC key

// ============================================================
// Payload schema (strict Zod validation)
// ============================================================

export const AdvisorReceiptPayloadSchema = z
  .object({
    // Binding fields (verified at save time)
    tenantId: z.string().min(1),
    userId: z.string().min(1),
    proposalId: z.string().min(1),
    purpose: AdvisorReceiptPurposeSchema, // cross-purpose reuse prevention

    // Provenance fields (trusted: from LLMProvider metadata at advisor call time)
    provider: z.string().min(1),
    model: z.string().min(1),
    simulated: z.boolean(),

    // Integrity field (for draftHash comparison)
    draftHash: z.string().length(64), // SHA-256 hex

    // Temporal fields (for expiry + nonce tracking)
    createdAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    nonce: z.string().length(64), // 32-byte hex
  })
  .strict();

export type AdvisorReceiptPayload = z.infer<
  typeof AdvisorReceiptPayloadSchema
>;

// ============================================================
// Verified receipt (returned to caller after successful verification)
// ============================================================

export interface VerifiedReceipt {
  draftedVia: "llm_advisory" | "hybrid";
  simulated: boolean;
  provider: string;
  model: string;
  traceId: string; // receipt.nonce
  purpose: AdvisorReceiptPurpose;
}

// ============================================================
// Key derivation (HKDF-SHA256 from AUTH_SECRET)
// ============================================================

/**
 * Derive a purpose-separated signing key from AUTH_SECRET using HKDF-SHA256.
 *
 * Per reviewer directive: "It is preferable to use a dedicated key derived
 * and dedicated to signing receipts, not to use AUTH_SECRET directly for
 * multiple security purposes."
 *
 * This key is derived once at module load (lazy singleton) and reused for
 * all receipt signing/verification. The derivation is deterministic: the
 * same AUTH_SECRET always produces the same signing key.
 */
let _signingKey: Buffer | null = null;

function getSigningKey(): Buffer {
  if (_signingKey === null) {
    // HKDF-SHA256: extract+expand in one step using Node's hkdf
    const { hkdfSync } = require("node:crypto") as {
      hkdfSync: (
        digest: string,
        ikm: string | Buffer,
        salt: string | Buffer,
        info: string | Buffer,
        keylen: number
      ) => Buffer;
    };
    const ikm = Buffer.from(env.AUTH_SECRET, "utf8");
    const salt = Buffer.alloc(0); // empty salt — ikm is already high-entropy
    const info = Buffer.from(SIGNING_KEY_INFO, "utf8");
    _signingKey = Buffer.from(hkdfSync("sha256", ikm, salt, info, SIGNING_KEY_LENGTH));
  }
  return _signingKey;
}

// ============================================================
// Canonical content hashing (identical at issuance + verification)
// ============================================================

export function computeDraftHash(draftContent: string): string {
  return createHash("sha256").update(draftContent, "utf8").digest("hex");
}

// ============================================================
// Receipt issuance (server-side, signed)
// ============================================================

/**
 * Issue a signed receipt for an advisor draft.
 *
 * Must be called from an authenticated server-side advisor operation
 * AFTER the LLM returns and the output passes causal-language validation.
 *
 * The receipt binds the draft to:
 *   - tenantId (caller's tenant)
 *   - userId (caller's user)
 *   - proposalId (the proposal the draft is for)
 *   - purpose (the advisor endpoint that issued it)
 *
 * The receipt records trusted provenance:
 *   - provider (from LLMProvider.name — set in code, trustworthy)
 *   - model (from LLMCompleteResult.model — returned by provider, not model)
 *   - simulated (derived from provider === "stub" — trustworthy)
 *   - draftHash (SHA-256 of draft content — for content integrity comparison)
 *
 * The receipt is HMAC-SHA256 signed with a derived purpose-separated key.
 *
 * Returns: base64url-encoded JSON { payload, signature } — opaque to client.
 */
export function issueReceipt(opts: {
  tenantId: string;
  userId: string;
  proposalId: string;
  purpose: AdvisorReceiptPurpose;
  draftContent: string;
  providerName: string;
  modelName: string;
}): string {
  const now = Date.now();
  const payload: AdvisorReceiptPayload = {
    tenantId: opts.tenantId,
    userId: opts.userId,
    proposalId: opts.proposalId,
    purpose: opts.purpose,
    provider: opts.providerName, // trusted: from LLMProvider.name
    model: opts.modelName, // trusted: from LLMCompleteResult.model
    simulated: opts.providerName === "stub", // trusted: derived
    draftHash: computeDraftHash(opts.draftContent),
    createdAt: now,
    expiresAt: now + RECEIPT_TTL_MS,
    nonce: randomBytes(32).toString("hex"),
  };

  const signingKey = getSigningKey();
  const payloadJson = JSON.stringify(payload);
  const signature = createHmac("sha256", signingKey)
    .update(payloadJson, "utf8")
    .digest("hex");

  const token = Buffer.from(
    JSON.stringify({ payload, signature })
  ).toString("base64url");

  return token;
}

// ============================================================
// Receipt verification (at save time)
// ============================================================

/**
 * Verify an advisor receipt token and derive provenance.
 *
 * Throws ReceiptVerificationError on any failure:
 *   - "malformed" — token is not valid base64url or JSON
 *   - "schema_invalid" — payload fails Zod validation
 *   - "invalid_signature" — HMAC mismatch (tampered)
 *   - "expired" — current time > expiresAt
 *   - "cross_tenant" — payload.tenantId !== expectedTenantId
 *   - "cross_user" — payload.userId !== expectedUserId
 *   - "cross_proposal" — payload.proposalId !== expectedProposalId
 *   - "cross_purpose" — payload.purpose !== expectedPurpose
 *
 * On success, returns VerifiedReceipt with derived provenance:
 *   - draftedVia: "llm_advisory" if draftHash matches submitted content,
 *                 "hybrid" if draftHash differs (edited by human)
 *   - simulated: from receipt (trusted)
 *   - provider: from receipt (trusted)
 *   - model: from receipt (trusted)
 *   - traceId: receipt.nonce (for observability)
 *   - purpose: from receipt (trusted)
 *
 * NOTE on replay (per reviewer directive):
 *   A nonce and TTL alone do not enforce one-time use. This verification
 *   does NOT track consumed receipts. Bounded reuse is permitted: a
 *   receipt MAY be submitted multiple times within its TTL. Every save
 *   independently satisfies all G03-03 constraints (authorization,
 *   proposal status, alternative limits, locking, atomic audit). The
 *   receipt is a provenance witness, not the sole security gate.
 *
 * NOTE on hybrid attribution (per reviewer directive):
 *   When draftedVia = "hybrid", the receipt proves only that a valid
 *   AI-generated draft was ASSOCIATED with the human submission. It
 *   does NOT claim that every word originated from the model or that
 *   the edit was semantically derived from the original.
 */
export function verifyReceipt(
  token: string,
  expected: {
    tenantId: string;
    userId: string;
    proposalId: string;
    purpose: AdvisorReceiptPurpose;
  },
  submittedContent: string
): VerifiedReceipt {
  // 1. Decode token (base64url → JSON)
  let decoded: { payload: unknown; signature: string };
  try {
    const jsonStr = Buffer.from(token, "base64url").toString("utf8");
    decoded = JSON.parse(jsonStr);
  } catch {
    throw new ReceiptVerificationError("malformed");
  }

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof decoded.signature !== "string" ||
    typeof decoded.payload !== "object" ||
    decoded.payload === null
  ) {
    throw new ReceiptVerificationError("malformed");
  }

  // 2. Strictly validate payload schema (Zod)
  const payloadResult = AdvisorReceiptPayloadSchema.safeParse(
    decoded.payload
  );
  if (!payloadResult.success) {
    throw new ReceiptVerificationError("schema_invalid");
  }
  const payload = payloadResult.data;

  // 3. Verify HMAC signature (timing-safe comparison)
  const signingKey = getSigningKey();
  const expectedSignature = createHmac("sha256", signingKey)
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");

  const providedSig = Buffer.from(decoded.signature, "utf8");
  const expectedSig = Buffer.from(expectedSignature, "utf8");
  if (
    providedSig.length !== expectedSig.length ||
    !timingSafeEqual(providedSig, expectedSig)
  ) {
    throw new ReceiptVerificationError("invalid_signature");
  }

  // 4. Verify expiry (TTL)
  if (Date.now() > payload.expiresAt) {
    throw new ReceiptVerificationError("expired");
  }

  // 5. Verify tenant binding
  if (payload.tenantId !== expected.tenantId) {
    throw new ReceiptVerificationError("cross_tenant");
  }

  // 6. Verify user binding
  if (payload.userId !== expected.userId) {
    throw new ReceiptVerificationError("cross_user");
  }

  // 7. Verify proposal binding
  if (payload.proposalId !== expected.proposalId) {
    throw new ReceiptVerificationError("cross_proposal");
  }

  // 8. Verify purpose binding (cross-purpose reuse prevention)
  if (payload.purpose !== expected.purpose) {
    throw new ReceiptVerificationError("cross_purpose");
  }

  // 9. Compare draftHash to determine llm_advisory vs hybrid
  //    NOTE: "hybrid" means an AI-generated draft was ASSOCIATED with the
  //    human submission. It does NOT claim every word originated from the
  //    model. The submitted content is what the analyst chose to save;
  //    the receipt proves only that they had a valid AI draft available.
  const submittedHash = computeDraftHash(submittedContent);
  const draftedVia: "llm_advisory" | "hybrid" =
    submittedHash === payload.draftHash ? "llm_advisory" : "hybrid";

  return {
    draftedVia,
    simulated: payload.simulated, // trusted: from receipt
    provider: payload.provider, // trusted: from receipt
    model: payload.model, // trusted: from receipt
    traceId: payload.nonce,
    purpose: payload.purpose,
  };
}

// ============================================================
// Testing helper: reset the signing key cache (for unit tests
// that mutate AUTH_SECRET via env var)
// ============================================================
export function _resetSigningKeyForTesting(): void {
  _signingKey = null;
}
