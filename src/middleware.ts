// ============================================================
// middleware.ts — Security headers, rate limiting, request tracing
// ------------------------------------------------------------
// Applied to all routes via Next.js middleware.
//
// 00-09 closure:
//   - Client IP extraction is gated on TRUSTED_PROXY env var.
//     When unset/false, x-forwarded-for is NEVER trusted — the
//     client cannot bypass rate limits by sending a fake header.
//   - In-process metrics (request count, latency, rate-limited
//     count) are recorded here so /api/v1/_metrics reflects real
//     traffic, not a static snapshot.
// ============================================================
import { NextRequest, NextResponse } from "next/server";
import {
  recordRequest,
  recordRateLimitedRequest,
} from "@/lib/metrics";

// ============================================================
// 1. SECURITY HEADERS
// ============================================================
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-XSS-Protection": "1; mode=block",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
};

// ============================================================
// 2. TRUSTED CLIENT IP EXTRACTION
// ------------------------------------------------------------
// When the app is deployed behind a known reverse proxy (nginx,
// Cloudflare, AWS ALB), set TRUSTED_PROXY=true so the proxy-set
// x-forwarded-for header is honored. The left-most IP in the
// comma-separated list is the original client.
//
// When TRUSTED_PROXY is unset or "false", we deliberately DO NOT
// trust x-forwarded-for — any client can set that header. In that
// case we fall back to "unknown", which means all clients share a
// single rate-limit bucket. This is fail-closed: better to
// over-share a bucket than to let an attacker spoof IPs to bypass
// per-IP limits.
// ============================================================
function isTrustedProxy(): boolean {
  const v = process.env.TRUSTED_PROXY;
  return v === "true" || v === "1" || v === "yes";
}

/**
 * Extract a client IP from a NextRequest, honoring the TRUSTED_PROXY
 * setting. Exported for unit testing.
 *
 * Trust policy:
 *   - TRUSTED_PROXY=true → read left-most entry from x-forwarded-for
 *   - otherwise          → return "unknown" (no header trusted)
 */
export function extractClientIp(headers: Headers): string {
  if (!isTrustedProxy()) {
    return "unknown";
  }
  const xff = headers.get("x-forwarded-for");
  if (!xff) return "unknown";
  const first = xff.split(",")[0]?.trim();
  if (!first) return "unknown";
  // Basic IPv4 / IPv6 shape check — reject malformed values that
  // could be used for log injection.
  if (!/^[0-9a-fA-F.:]+$/.test(first)) return "unknown";
  return first;
}

// ============================================================
// 3. RATE LIMITING (in-memory, per-IP)
// ============================================================
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}, 300_000);

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  "/api/v1/auth/signin": { maxRequests: 20, windowMs: 60_000 },
  "/api/v1/auth/signout": { maxRequests: 20, windowMs: 60_000 },
  "/api/v1/tasks": { maxRequests: 30, windowMs: 60_000 },
  "/api/v1/capabilities": { maxRequests: 20, windowMs: 60_000 },
};

function findRateLimitConfig(path: string): RateLimitConfig | undefined {
  for (const route of Object.keys(RATE_LIMITS)) {
    if (path.startsWith(route)) {
      return RATE_LIMITS[route];
    }
  }
  return undefined;
}

function checkRateLimit(
  path: string,
  method: string,
  ip: string
): { allowed: boolean; remaining: number; resetAt: number; maxRequests: number } {
  if (method !== "POST" && method !== "PUT" && method !== "DELETE") {
    return { allowed: true, remaining: Infinity, resetAt: 0, maxRequests: 0 };
  }

  const config = findRateLimitConfig(path);
  if (!config) {
    return { allowed: true, remaining: Infinity, resetAt: 0, maxRequests: 0 };
  }

  const key = `${ip}:${path}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || entry.resetAt < now) {
    rateLimitStore.set(key, {
      count: 1,
      resetAt: now + config.windowMs,
    });
    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetAt: now + config.windowMs,
      maxRequests: config.maxRequests,
    };
  }

  entry.count++;
  if (entry.count > config.maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt, maxRequests: config.maxRequests };
  }

  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetAt: entry.resetAt,
    maxRequests: config.maxRequests,
  };
}

// ============================================================
// 4. MIDDLEWARE
// ============================================================
export function middleware(request: NextRequest) {
  const start = Date.now();
  const { pathname } = request.nextUrl;
  const method = request.method;
  const ip = extractClientIp(request.headers);

  // Generate request ID using Math.random (avoids node:crypto in edge runtime)
  const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  // Check rate limit
  const rateLimit = checkRateLimit(pathname, method, ip);
  if (!rateLimit.allowed) {
    // Record the rate-limit event BEFORE returning so /api/v1/_metrics
    // reflects the rejected request.
    const elapsed = Date.now() - start;
    recordRequest(elapsed, true);
    recordRateLimitedRequest();

    return NextResponse.json(
      {
        error: "Rate limit exceeded",
        detail: "Too many requests. Please try again later.",
        requestId,
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": rateLimit.maxRequests.toString(),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": Math.ceil(rateLimit.resetAt / 1000).toString(),
          "X-Request-Id": requestId,
        },
      }
    );
  }

  // Get response
  const response = NextResponse.next({
    request: {
      headers: new Headers(request.headers),
    },
  });

  // Add security headers
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }

  // Add rate limit headers
  if (rateLimit.remaining !== Infinity) {
    response.headers.set("X-RateLimit-Remaining", rateLimit.remaining.toString());
  }

  // Add request ID for tracing
  response.headers.set("X-Request-Id", requestId);

  // Record the request as it passes through. Latency here is the
  // middleware wall-clock time, not full request latency (Next.js
  // middleware cannot intercept the outgoing response). This is
  // documented in metrics.ts.
  const elapsed = Date.now() - start;
  recordRequest(elapsed, false);

  return response;
}

export const config = {
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
