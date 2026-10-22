// ============================================================
// auth.ts — Auth.js v5 configuration (00-03, auth closure)
// ------------------------------------------------------------
// CredentialsProvider with email + password.
// JWT carries userId, tenantId, roleCode, membershipStatus.
//
// AUTH BOOTSTRAP (fixed):
//   - authorize() uses auth-bootstrap.ts (balance_admin, BYPASSRLS)
//     for user lookup + initial membership load.
//   - All other app code uses `db` (balance_app) with RLS.
//
// TENANT SWITCHING (fixed):
//   - switch-tenant passes specific tenantId + roleCode via unstable_update.
//   - jwt callback's "update" branch RE-VERIFIES current tenantId
//     (doesn't reload first membership).
//
// Per ADR-0007 (updated: auth bootstrap + tenant switching).
// ============================================================
import NextAuth, { type NextAuthConfig, type Session } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { env } from "@/lib/env";
import { verifyPassword } from "@/lib/password";
import {
  findUserByEmail,
  loadFirstActiveMembership,
  loadMembershipForTenant,
  verifyUserActive,
} from "@/lib/auth-bootstrap";

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

        // AUTH BOOTSTRAP: use auth-bootstrap client (balance_admin) for user lookup.
        // RLS on `users` requires app.user_id, which we don't have yet.
        const user = await findUserByEmail(email);
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
    async jwt({ token, user, trigger, session: updateData }) {
      // On initial signin, `user` is populated.
      if (user && user.id) {
        token.userId = user.id;
        // Load FIRST active membership for initial session.
        const membership = await loadFirstActiveMembership(user.id);
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

      // On session refresh (trigger === "update"):
      // If updateData carries a specific tenantId (from switch-tenant),
      // use it. RE-VERIFY the membership is still active, but DON'T
      // reload first membership (that would override a deliberate switch).
      if (trigger === "update" && token.userId) {
        const userId = token.userId as string;

        // Re-verify user is still active
        const userActive = await verifyUserActive(userId);
        if (!userActive) {
          token.tenantId = null;
          token.roleCode = null;
          token.membershipStatus = null;
          return token;
        }

        // Check if updateData carries a specific tenantId (from switch-tenant)
        const updateTenantId = (updateData as { user?: { tenantId?: string } })?.user?.tenantId;
        const effectiveTenantId = updateTenantId ?? (token.tenantId as string | null);

        if (effectiveTenantId) {
          // RE-VERIFY the specific membership is still active.
          const membership = await loadMembershipForTenant(userId, effectiveTenantId);
          if (membership) {
            token.tenantId = membership.tenantId;
            token.roleCode = membership.roleCode;
            token.membershipStatus = membership.status;
          } else {
            // Membership revoked — clear tenant context
            token.tenantId = null;
            token.roleCode = null;
            token.membershipStatus = null;
          }
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
