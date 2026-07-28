import { MAX_RECURSION_DEPTH } from "./limits.js";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED: recursion_depth]";
const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|secret|password|token|api[_-]?key|request[_-]?body|body|content|access[_-]?key)/i;
const BEARER_TOKEN = /\bbearer\s+[a-z0-9._~+/=-]+/gi;
const API_KEY = /\b(?:sk|pk|api)[_-][a-z0-9_-]{8,}\b/gi;
const SENTRY_DSN = /https?:\/\/[^\s/@]+@[^\s/]+\/\d+\b/gi;
const COOKIE = /\b(?:set-cookie|cookie)\s*[:=]\s*[^\s;,]+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_RECURSION_DEPTH) {
    return TRUNCATED;
  }

  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  if (!isRecord(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "contentPreview") {
      continue;
    }
    if (SENSITIVE_KEY.test(key)) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = redactValue(entry, depth + 1);
  }
  return result;
}

export function redactString(value: string): string {
  return value
    .replace(BEARER_TOKEN, REDACTED)
    .replace(API_KEY, REDACTED)
    .replace(SENTRY_DSN, REDACTED)
    .replace(COOKIE, REDACTED)
    .replace(EMAIL, REDACTED);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
