// ============================================================
// /app/api/auth/[...nextauth]/route.ts — Auth.js mount point
// ------------------------------------------------------------
// Mounts the Auth.js v5 handlers at /api/auth/*.
// In 00-01 this is inert (no providers). In 00-03 it gains providers.
// ============================================================
export { GET, POST } from "@/lib/auth";
