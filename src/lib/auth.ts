// ============================================================
// auth.ts — Auth.js v5 configuration (skeleton)
// ------------------------------------------------------------
// In 00-01 we ship ONLY the skeleton: NextAuth handler mounted, session
// strategy defined, but NO authentication providers enabled. This makes
// the API surface stable so 00-03 can add providers (credentials, OIDC)
// without changing route handlers.
//
// Why Auth.js v5 (not NextAuth v4)?
//   - v5 is the current version with first-class Next.js 16 support.
//   - v4 is in maintenance mode.
//   - v5's `auth()` helper works in Server Components + Route Handlers
//     with a single import.
// ============================================================
import NextAuth from "next-auth";
import { env } from "@/lib/env";

// In 00-01: no providers. Session is JWT-based but always anonymous.
// In 00-03: add CredentialsProvider / OIDC providers here.
export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: env.AUTH_TRUST_HOST,
  secret: env.AUTH_SECRET,
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 8, // 8 hours
  },
  // No providers in 00-01 — auth is intentionally inert.
  providers: [],
  callbacks: {
    // In 00-03 we will inject tenantId into the JWT here.
    async jwt({ token }) {
      return token;
    },
    async session({ session, token }) {
      // In 00-03: session.user.tenantId = token.tenantId
      return session;
    },
  },
  // Catch-all error handler — never leak auth internals to the client.
  // Note: Auth.js v5 events object does not include an `error` key in its
  // public type; we surface auth errors via middleware + route handlers
  // instead. This comment is intentionally left as a marker for 00-03.
});

export const { GET, POST } = handlers;
