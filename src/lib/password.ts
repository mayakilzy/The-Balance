// ============================================================
// password.ts — Password hashing + verification (bcrypt)
// ------------------------------------------------------------
// Uses bcrypt with cost factor 12 (reasonable for 2026).
// Never store plaintext passwords. Never log passwordHash.
// ============================================================
import bcrypt from "bcryptjs";

const COST_FACTOR = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string" || plaintext.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (plaintext.length > 1024) {
    throw new Error("Password exceeds 1024 characters");
  }
  return bcrypt.hash(plaintext, COST_FACTOR);
}

export async function verifyPassword(
  plaintext: string,
  hash: string
): Promise<boolean> {
  if (typeof plaintext !== "string" || typeof hash !== "string") {
    return false;
  }
  try {
    return bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}
