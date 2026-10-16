// ============================================================
// observability.ts — Structured logging via pino
// ------------------------------------------------------------
// Single logger for the whole app. Child loggers carry tenant + request
// context. Secrets must NEVER be logged — the audit layer strips them
// before they reach here; this module does not attempt redaction.
// ============================================================
import pino from "pino";
import { env } from "@/lib/env";

export const logger = pino({
  name: env.APP_NAME,
  level: env.LOG_LEVEL,
  base: { version: env.APP_VERSION },
  // In dev, pretty-print for readability. In prod, NDJSON for log shippers.
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
});

export function childLogger(bindings: pino.Bindings) {
  return logger.child(bindings);
}
