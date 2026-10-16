// ============================================================
// trusted-ip.test.ts — Unit tests for trusted-proxy IP extraction
// ------------------------------------------------------------
// Closes 00-09 Gap 2: proves that when TRUSTED_PROXY is unset or
// "false", a client-supplied x-forwarded-for header CANNOT spoof
// the perceived IP — the rate-limiter falls back to a shared
// "unknown" bucket instead.
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extractClientIp } from "@/middleware";

const ORIGINAL_TRUSTED_PROXY = process.env.TRUSTED_PROXY;

beforeEach(() => {
  delete process.env.TRUSTED_PROXY;
});

afterEach(() => {
  if (ORIGINAL_TRUSTED_PROXY === undefined) {
    delete process.env.TRUSTED_PROXY;
  } else {
    process.env.TRUSTED_PROXY = ORIGINAL_TRUSTED_PROXY;
  }
});

describe("extractClientIp — TRUSTED_PROXY disabled (default)", () => {
  // The default deployment shape: app is NOT behind a known proxy.
  // Client-supplied x-forwarded-for MUST be ignored.

  it("returns 'unknown' when TRUSTED_PROXY is unset and x-forwarded-for is spoofed", () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "203.0.113.42");
    expect(extractClientIp(headers)).toBe("unknown");
  });

  it("returns 'unknown' when TRUSTED_PROXY=false regardless of header value", () => {
    process.env.TRUSTED_PROXY = "false";
    const headers = new Headers();
    headers.set("x-forwarded-for", "198.51.100.1, 10.0.0.1");
    expect(extractClientIp(headers)).toBe("unknown");
  });

  it("returns 'unknown' when TRUSTED_PROXY=0", () => {
    process.env.TRUSTED_PROXY = "0";
    const headers = new Headers();
    headers.set("x-forwarded-for", "198.51.100.1");
    expect(extractClientIp(headers)).toBe("unknown");
  });

  it("returns 'unknown' when header is absent (no spoofing possible)", () => {
    const headers = new Headers();
    expect(extractClientIp(headers)).toBe("unknown");
  });

  // NEGATIVE TEST: This is the core anti-spoofing guarantee.
  it("NEGATIVE: spoofed IPs cannot bypass rate limit — all clients share 'unknown' bucket", () => {
    // Attacker tries 5 different IPs in x-forwarded-for
    const spoofedIps = ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5"];
    const extracted = spoofedIps.map((ip) => {
      const headers = new Headers();
      headers.set("x-forwarded-for", ip);
      return extractClientIp(headers);
    });
    // Every extraction returns "unknown" — all spoofed values are ignored
    extracted.forEach((ip) => expect(ip).toBe("unknown"));
    // The attacker cannot differentiate themselves — they all collapse
    // to the same "unknown" bucket and are rate-limited together.
    expect(new Set(extracted).size).toBe(1);
  });
});

describe("extractClientIp — TRUSTED_PROXY enabled (behind known proxy)", () => {
  // When the app IS behind a known reverse proxy that overwrites
  // x-forwarded-for, we honor the left-most IP (the original client).

  it("returns the left-most IP when TRUSTED_PROXY=true", () => {
    process.env.TRUSTED_PROXY = "true";
    const headers = new Headers();
    headers.set("x-forwarded-for", "203.0.113.42, 10.0.0.1, 10.0.0.2");
    expect(extractClientIp(headers)).toBe("203.0.113.42");
  });

  it("returns 'unknown' when TRUSTED_PROXY=true but header is missing", () => {
    process.env.TRUSTED_PROXY = "true";
    const headers = new Headers();
    expect(extractClientIp(headers)).toBe("unknown");
  });

  it("returns 'unknown' for malformed IP values (log-injection defense)", () => {
    process.env.TRUSTED_PROXY = "true";
    const headers = new Headers();
    // Use a value that Headers accepts (no newlines) but that fails
    // the IP-shape regex — semicolons, spaces, and SQL/log-injection
    // tokens are all rejected by /^[0-9a-fA-F.:]+$/.
    headers.set("x-forwarded-for", "1.2.3.4; rm -rf /; SELECT 1");
    expect(extractClientIp(headers)).toBe("unknown");
  });

  it("trims whitespace around the left-most IP", () => {
    process.env.TRUSTED_PROXY = "true";
    const headers = new Headers();
    headers.set("x-forwarded-for", "  203.0.113.42  , 10.0.0.1");
    expect(extractClientIp(headers)).toBe("203.0.113.42");
  });

  it("accepts IPv6 addresses", () => {
    process.env.TRUSTED_PROXY = "true";
    const headers = new Headers();
    headers.set("x-forwarded-for", "2001:db8::1, 10.0.0.1");
    expect(extractClientIp(headers)).toBe("2001:db8::1");
  });

  it("accepts TRUSTED_PROXY=1 as truthy", () => {
    process.env.TRUSTED_PROXY = "1";
    const headers = new Headers();
    headers.set("x-forwarded-for", "192.0.2.100");
    expect(extractClientIp(headers)).toBe("192.0.2.100");
  });

  it("accepts TRUSTED_PROXY=yes as truthy", () => {
    process.env.TRUSTED_PROXY = "yes";
    const headers = new Headers();
    headers.set("x-forwarded-for", "192.0.2.200");
    expect(extractClientIp(headers)).toBe("192.0.2.200");
  });
});
