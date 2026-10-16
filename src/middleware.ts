// ============================================================
// middleware.ts — Security headers, rate limiting, request tracing
// ------------------------------------------------------------
// Applied to all routes via Next.js middleware.
// ============================================================
import { NextRequest, NextResponse } from "next/server";

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
// 2. RATE LIMITING (in-memory, per-IP)
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
  "/api/v1/auth/signin": { maxRequests: 10, windowMs: 60_000 },
  "/api/v1/auth/signout": { maxRequests: 10, windowMs: 60_000 },
  "/api/v1/tasks": { maxRequests: 30, windowMs: 60_000 },
  "/api/v1/capabilities": { maxRequests: 20, windowMs: 60_000 },
};

function checkRateLimit(
  path: string,
  method: string,
  ip: string
): { allowed: boolean; remaining: number; resetAt: number } {
  if (method !== "POST" && method !== "PUT" && method !== "DELETE") {
    return { allowed: true, remaining: Infinity, resetAt: 0 };
  }

  let config: RateLimitConfig | undefined;
  for (const route of Object.keys(RATE_LIMITS)) {
    if (path.startsWith(route)) {
      config = RATE_LIMITS[route];
      break;
    }
  }

  if (!config) {
    return { allowed: true, remaining: Infinity, resetAt: 0 };
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
    };
  }

  entry.count++;
  if (entry.count > config.maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetAt: entry.resetAt,
  };
}

// ============================================================
// 3. MIDDLEWARE
// ============================================================
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  // Generate request ID using Math.random (avoids node:crypto in edge runtime)
  const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  // Check rate limit
  const rateLimit = checkRateLimit(pathname, method, ip);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded",
        detail: "Too many requests. Please try again later.",
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": RATE_LIMITS[pathname]?.maxRequests.toString() || "0",
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

  return response;
}

export const config = {
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
