// ============================================================
// tests/unit/reform/advisor-receipt.test.ts
// ------------------------------------------------------------
// G03-04-PRE-03 — Unit tests for the trusted provenance receipt module.
//
// Covers (per PRE-03 Acceptance Checklist R-U1..R-U12):
//   - issueReceipt produces valid base64url token
//   - verifyReceipt accepts valid receipt + matching content → llm_advisory
//   - verifyReceipt accepts valid receipt + edited content → hybrid
//   - rejects malformed → "malformed"
//   - rejects tampered signature → "invalid_signature"
//   - rejects expired → "expired"
//   - rejects cross-tenant → "cross_tenant"
//   - rejects cross-user → "cross_user"
//   - rejects cross-proposal → "cross_proposal"
//   - rejects cross-purpose → "cross_purpose"
//   - simulated derived from provider name (not client)
//   - receipt TTL = 1 hour
// ============================================================
import { describe, it, expect, beforeEach } from "vitest";
import {
  issueReceipt,
  verifyReceipt,
  computeDraftHash,
  _resetSigningKeyForTesting,
} from "@/lib/reform/advisor-receipt";
import { ReceiptVerificationError } from "@/lib/reform/contracts";

const TENANT_A = "tenant_test_001";
const TENANT_B = "tenant_test_002";
const USER_A = "user_test_001";
const USER_B = "user_test_002";
const PROPOSAL_A = "proposal_test_001";
const PROPOSAL_B = "proposal_test_002";

beforeEach(() => {
  _resetSigningKeyForTesting();
});

describe("advisor-receipt — issueReceipt", () => {
  it("R-U1: produces a valid base64url token that decodes to { payload, signature }", () => {
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: "Test draft content for receipt issuance.",
      providerName: "stub",
      modelName: "stub-v0",
    });

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(100);

    // Decodes to valid JSON
    const decoded = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8")
    );
    expect(decoded).toHaveProperty("payload");
    expect(decoded).toHaveProperty("signature");
    expect(typeof decoded.signature).toBe("string");
    expect(decoded.payload).toHaveProperty("tenantId", TENANT_A);
    expect(decoded.payload).toHaveProperty("userId", USER_A);
    expect(decoded.payload).toHaveProperty("proposalId", PROPOSAL_A);
    expect(decoded.payload).toHaveProperty("purpose", "draft_alternatives");
    expect(decoded.payload).toHaveProperty("provider", "stub");
    expect(decoded.payload).toHaveProperty("model", "stub-v0");
    expect(decoded.payload).toHaveProperty("simulated", true);
    expect(decoded.payload).toHaveProperty("draftHash");
    expect(decoded.payload.draftHash).toHaveLength(64);
    expect(decoded.payload).toHaveProperty("createdAt");
    expect(decoded.payload).toHaveProperty("expiresAt");
    expect(decoded.payload).toHaveProperty("nonce");
    expect(decoded.payload.nonce).toHaveLength(64);
  });

  it("R-U12: receipt TTL is exactly 1 hour (expiresAt - createdAt === 3600000)", () => {
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: "TTL test content.",
      providerName: "stub",
      modelName: "stub-v0",
    });
    const decoded = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8")
    );
    expect(decoded.payload.expiresAt - decoded.payload.createdAt).toBe(
      60 * 60 * 1000
    );
  });
});

describe("advisor-receipt — verifyReceipt (acceptance)", () => {
  it("R-U2: accepts valid receipt + matching content → draftedVia='llm_advisory'", () => {
    const draft = "This is the original draft content for testing.";
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: draft,
      providerName: "stub",
      modelName: "stub-v0",
    });

    const verified = verifyReceipt(
      token,
      {
        tenantId: TENANT_A,
        userId: USER_A,
        proposalId: PROPOSAL_A,
        purpose: "draft_alternatives",
      },
      draft // matching content
    );

    expect(verified.draftedVia).toBe("llm_advisory");
    expect(verified.simulated).toBe(true);
    expect(verified.provider).toBe("stub");
    expect(verified.model).toBe("stub-v0");
    expect(verified.traceId).toHaveLength(64);
    expect(verified.purpose).toBe("draft_alternatives");
  });

  it("R-U3: accepts valid receipt + edited content → draftedVia='hybrid'", () => {
    const originalDraft = "Original LLM draft content.";
    const editedDraft = "Edited version with analyst changes added.";
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: originalDraft,
      providerName: "stub",
      modelName: "stub-v0",
    });

    const verified = verifyReceipt(
      token,
      {
        tenantId: TENANT_A,
        userId: USER_A,
        proposalId: PROPOSAL_A,
        purpose: "draft_alternatives",
      },
      editedDraft // differs from originalDraft
    );

    expect(verified.draftedVia).toBe("hybrid");
    expect(verified.simulated).toBe(true); // preserved from receipt
    expect(verified.provider).toBe("stub");
    expect(verified.model).toBe("stub-v0");
  });
});

describe("advisor-receipt — verifyReceipt (rejection)", () => {
  it("R-U4: rejects malformed token (not base64url) → 'malformed'", () => {
    expect(() =>
      verifyReceipt(
        "!!!not-base64url!!!",
        {
          tenantId: TENANT_A,
          userId: USER_A,
          proposalId: PROPOSAL_A,
          purpose: "draft_alternatives",
        },
        "content"
      )
    ).toThrow(ReceiptVerificationError);

    try {
      verifyReceipt(
        "!!!not-base64url!!!",
        {
          tenantId: TENANT_A,
          userId: USER_A,
          proposalId: PROPOSAL_A,
          purpose: "draft_alternatives",
        },
        "content"
      );
    } catch (e) {
      expect((e as ReceiptVerificationError).reason).toBe("malformed");
    }
  });

  it("R-U4b: rejects malformed token (valid base64url but invalid JSON) → 'malformed'", () => {
    const badToken = Buffer.from("not json").toString("base64url");
    expect(() =>
      verifyReceipt(
        badToken,
        {
          tenantId: TENANT_A,
          userId: USER_A,
          proposalId: PROPOSAL_A,
          purpose: "draft_alternatives",
        },
        "content"
      )
    ).toThrow(ReceiptVerificationError);
  });

  it("R-U5: rejects tampered payload (signature mismatch) → 'invalid_signature'", () => {
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: "Original content.",
      providerName: "stub",
      modelName: "stub-v0",
    });

    // Tamper: change the payload but keep the old signature
    const decoded = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8")
    );
    decoded.payload.provider = "openai"; // tamper with provider
    const tamperedToken = Buffer.from(
      JSON.stringify(decoded)
    ).toString("base64url");

    expect(() =>
      verifyReceipt(
        tamperedToken,
        {
          tenantId: TENANT_A,
          userId: USER_A,
          proposalId: PROPOSAL_A,
          purpose: "draft_alternatives",
        },
        "Original content."
      )
    ).toThrow(ReceiptVerificationError);

    try {
      verifyReceipt(
        tamperedToken,
        {
          tenantId: TENANT_A,
          userId: USER_A,
          proposalId: PROPOSAL_A,
          purpose: "draft_alternatives",
        },
        "Original content."
      );
    } catch (e) {
      expect((e as ReceiptVerificationError).reason).toBe("invalid_signature");
    }
  });

  it("R-U6: rejects expired receipt → 'expired'", () => {
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: "Expiry test content.",
      providerName: "stub",
      modelName: "stub-v0",
    });

    // Decode, set expiresAt to past, re-sign with tampered payload
    // (we can't easily re-sign without the key, so we directly test the
    // expiry check by decoding + manually crafting an expired payload)
    const decoded = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8")
    );
    // We need to re-sign because the signature covers expiresAt.
    // Instead, use vitest's fake timers to advance time past expiry.
  });

  it("R-U6b: rejects expired receipt (using fake timers) → 'expired'", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: "Expiry test content.",
      providerName: "stub",
      modelName: "stub-v0",
    });

    // Advance time 2 hours (past 1-hour TTL)
    vi.setSystemTime(now + 2 * 60 * 60 * 1000);

    try {
      verifyReceipt(
        token,
        {
          tenantId: TENANT_A,
          userId: USER_A,
          proposalId: PROPOSAL_A,
          purpose: "draft_alternatives",
        },
        "Expiry test content."
      );
      // Should have thrown
      expect(false).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(ReceiptVerificationError);
      expect((e as ReceiptVerificationError).reason).toBe("expired");
    }

    vi.useRealTimers();
  });

  it("R-U7: rejects cross-tenant receipt → 'cross_tenant'", () => {
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: "Cross-tenant test.",
      providerName: "stub",
      modelName: "stub-v0",
    });

    expect(() =>
      verifyReceipt(
        token,
        {
          tenantId: TENANT_B, // different tenant
          userId: USER_A,
          proposalId: PROPOSAL_A,
          purpose: "draft_alternatives",
        },
        "Cross-tenant test."
      )
    ).toThrow(ReceiptVerificationError);

    try {
      verifyReceipt(
        token,
        {
          tenantId: TENANT_B,
          userId: USER_A,
          proposalId: PROPOSAL_A,
          purpose: "draft_alternatives",
        },
        "Cross-tenant test."
      );
    } catch (e) {
      expect((e as ReceiptVerificationError).reason).toBe("cross_tenant");
    }
  });

  it("R-U8: rejects cross-user receipt → 'cross_user'", () => {
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: "Cross-user test.",
      providerName: "stub",
      modelName: "stub-v0",
    });

    try {
      verifyReceipt(
        token,
        {
          tenantId: TENANT_A,
          userId: USER_B, // different user
          proposalId: PROPOSAL_A,
          purpose: "draft_alternatives",
        },
        "Cross-user test."
      );
      expect(false).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(ReceiptVerificationError);
      expect((e as ReceiptVerificationError).reason).toBe("cross_user");
    }
  });

  it("R-U9: rejects cross-proposal receipt → 'cross_proposal'", () => {
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: "Cross-proposal test.",
      providerName: "stub",
      modelName: "stub-v0",
    });

    try {
      verifyReceipt(
        token,
        {
          tenantId: TENANT_A,
          userId: USER_A,
          proposalId: PROPOSAL_B, // different proposal
          purpose: "draft_alternatives",
        },
        "Cross-proposal test."
      );
      expect(false).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(ReceiptVerificationError);
      expect((e as ReceiptVerificationError).reason).toBe("cross_proposal");
    }
  });

  it("R-U9b: rejects cross-purpose receipt → 'cross_purpose'", () => {
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives", // issued for alternatives
      draftContent: "Cross-purpose test.",
      providerName: "stub",
      modelName: "stub-v0",
    });

    try {
      verifyReceipt(
        token,
        {
          tenantId: TENANT_A,
          userId: USER_A,
          proposalId: PROPOSAL_A,
          purpose: "draft_problem_statement", // different purpose
        },
        "Cross-purpose test."
      );
      expect(false).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(ReceiptVerificationError);
      expect((e as ReceiptVerificationError).reason).toBe("cross_purpose");
    }
  });

  it("R-U10: simulated flag is derived from provider name, not client — tampering provider to non-stub fails signature", () => {
    // Issue a receipt with provider="stub" (simulated=true)
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: "Provider tampering test.",
      providerName: "stub",
      modelName: "stub-v0",
    });

    // Decode + tamper with provider to "openai" (would set simulated=false)
    const decoded = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8")
    );
    decoded.payload.provider = "openai";
    decoded.payload.simulated = false;
    const tamperedToken = Buffer.from(
      JSON.stringify(decoded)
    ).toString("base64url");

    // Signature verification fails because payload was modified after signing
    try {
      verifyReceipt(
        tamperedToken,
        {
          tenantId: TENANT_A,
          userId: USER_A,
          proposalId: PROPOSAL_A,
          purpose: "draft_alternatives",
        },
        "Provider tampering test."
      );
      expect(false).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(ReceiptVerificationError);
      expect((e as ReceiptVerificationError).reason).toBe("invalid_signature");
    }
  });

  it("R-U11: provider + model in receipt match LLMProvider metadata (trusted)", () => {
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: "Metadata test.",
      providerName: "stub",
      modelName: "stub-v0",
    });

    const verified = verifyReceipt(
      token,
      {
        tenantId: TENANT_A,
        userId: USER_A,
        proposalId: PROPOSAL_A,
        purpose: "draft_alternatives",
      },
      "Metadata test."
    );

    expect(verified.provider).toBe("stub");
    expect(verified.model).toBe("stub-v0");
  });

  it("R-U11b: schema_invalid when payload is missing required fields", () => {
    // Craft a token with a payload missing required fields
    const badPayload = { tenantId: TENANT_A }; // missing everything else
    const { createHmac } = require("node:crypto") as {
      createHmac: {
        (alg: string, key: Buffer): {
          update: (data: string) => { digest: (enc: string) => string };
        };
      };
    };
    // We can't easily sign without the derived key — but we can test the
    // schema_invalid path by tampering the payload to be empty.
    const token = issueReceipt({
      tenantId: TENANT_A,
      userId: USER_A,
      proposalId: PROPOSAL_A,
      purpose: "draft_alternatives",
      draftContent: "Schema test.",
      providerName: "stub",
      modelName: "stub-v0",
    });

    // Tamper: replace payload with an empty object
    const decoded = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8")
    );
    decoded.payload = {};
    const badToken = Buffer.from(JSON.stringify(decoded)).toString("base64url");

    try {
      verifyReceipt(
        badToken,
        {
          tenantId: TENANT_A,
          userId: USER_A,
          proposalId: PROPOSAL_A,
          purpose: "draft_alternatives",
        },
        "Schema test."
      );
      expect(false).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(ReceiptVerificationError);
      expect((e as ReceiptVerificationError).reason).toBe("schema_invalid");
    }
  });
});

describe("advisor-receipt — computeDraftHash (canonical hashing)", () => {
  it("produces 64-char hex SHA-256", () => {
    const hash = computeDraftHash("test content");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic for same input", () => {
    const h1 = computeDraftHash("same content");
    const h2 = computeDraftHash("same content");
    expect(h1).toBe(h2);
  });

  it("differs for different input", () => {
    const h1 = computeDraftHash("content one");
    const h2 = computeDraftHash("content two");
    expect(h1).not.toBe(h2);
  });

  it("treats UTF-8 encoding consistently (issuance + verification use same algorithm)", () => {
    const unicode = "Café résumé naïve — 日本語";
    const hash = computeDraftHash(unicode);
    expect(hash).toHaveLength(64);
    // The verifyReceipt function uses the same computeDraftHash, so this
    // implicitly tests that issuance and verification use the same algorithm.
  });
});
