// ============================================================
// auth.ts — Auth.js v5 configuration (00-03)
// ------------------------------------------------------------
// CredentialsProvider with email + password.
// JWT carries userId, tenantId, roleCode, membershipStatus.
// Session exposes userId, tenantId, roleCode to the app.
//
// Security:
//   - signIn callback: reject users with status !== 'active'
//   - jwt callback: load active membership, store in token
//   - session callback: expose token claims to session
//   - No hard-coded admin backdoor
//
// Per ADR-0007 (auth design).
// ============================================================
import NextAuth, { type NextAuthConfig, type Session } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";

// Extend the session types
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      tenantId: string | null;
      roleCode: string | null;
      membershipStatus: string | null;
    };
  }
}

// Load active membership for a user. Returns the FIRST active membership.
async function loadActiveMembership(
  userId: string
): Promise<{
  tenantId: string;
  roleCode: string;
  status: string;
} | null> {
  const membership = await db.membership.findFirst({
    where: { userId, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  if (!membership) return null;
  return {
    tenantId: membership.tenantId,
    roleCode: membership.roleCode,
    status: membership.status,
  };
}

const config: NextAuthConfig = {
  trustHost: env.AUTH_TRUST_HOST,
  secret: env.AUTH_SECRET,
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 8, // 8 hours
  },
  providers: [
    Credentials({
      credentials: {
        email: { type: "email" },
        password: { type: "password" },
      },
      async authorize(credentials) {
        if (!credentials || typeof credentials !== "object") return null;

        const email = credentials.email as string;
        const password = credentials.password as string;
        if (typeof email !== "string" || typeof password !== "string") {
          return null;
        }
        if (email.length === 0 || password.length === 0) return null;

        // Load user by email (admin client — pre-auth bootstrap)
        const user = await db.user.findUnique({
          where: { email: email.toLowerCase() },
        });
        if (!user) return null;

        // Verify password
        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) return null;

        // Check user status
        if (user.status !== "active") return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      // On initial signin, `user` is populated.
      if (user && user.id) {
        token.userId = user.id;
        const membership = await loadActiveMembership(user.id);
        if (membership) {
          token.tenantId = membership.tenantId;
          token.roleCode = membership.roleCode;
          token.membershipStatus = membership.status;
        } else {
          token.tenantId = null;
          token.roleCode = null;
          token.membershipStatus = null;
        }
      }

      // On session refresh, reload membership.
      if (trigger === "update" && token.userId) {
        const userIdStr = token.userId as string;
        const membership = await loadActiveMembership(userIdStr);
        if (membership) {
          token.tenantId = membership.tenantId;
          token.roleCode = membership.roleCode;
          token.membershipStatus = membership.status;
        } else {
          token.tenantId = null;
          token.roleCode = null;
          token.membershipStatus = null;
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.userId as string) ?? "";
        session.user.tenantId = (token.tenantId as string | null) ?? null;
        session.user.roleCode = (token.roleCode as string | null) ?? null;
        session.user.membershipStatus = (token.membershipStatus as string | null) ?? null;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
};

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth(config);
export const { GET, POST } = handlers;
export type { Session };
