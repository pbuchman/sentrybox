import { MAX_RECURSION_DEPTH } from "./limits.js";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED: recursion_depth]";
const SENSITIVE_KEY =
  /(?:auth(?:entication|orization)?|cookie|credential|secret|password|token|api[_-]?key|request[_-]?body|body|content|access[_-]?key)/i;
const AUTH_HEADER =
  /\b(?:authorization|authentication|auth)\s*[:=]\s*[^\r\n]*/gi;
const AUTH_SCHEME = /\b(?:bearer|basic|digest)\b[^\r\n]*/gi;
const API_KEY = /\b(?:sk|pk|api)[_-][a-z0-9_-]{8,}\b/gi;
const SENTRY_DSN = /https?:\/\/[^\s/@]+@[^\s/]+\/\d+\b/gi;
const COOKIE = /\b(?:set-cookie|cookie)\s*[:=]\s*[^\r\n]*/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export interface RedactionResult {
  readonly value: unknown;
  readonly truncated: boolean;
}

export function redactValue(value: unknown, depth = 0): unknown {
  return redactWithMetadata(value, depth).value;
}

export function redactWithMetadata(value: unknown, depth = 0): RedactionResult {
  if (depth >= MAX_RECURSION_DEPTH) {
    return { value: TRUNCATED, truncated: true };
  }

  if (typeof value === "string") {
    return { value: redactString(value), truncated: false };
  }
  if (Array.isArray(value)) {
    const redacted = value.map((entry) => redactWithMetadata(entry, depth + 1));
    return {
      value: redacted.map((entry) => entry.value),
      truncated: redacted.some((entry) => entry.truncated),
    };
  }
  if (!isRecord(value)) {
    return { value, truncated: false };
  }

  const result = Object.create(null) as Record<string, unknown>;
  let truncated = false;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "contentPreview") {
      continue;
    }
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
      continue;
    }
    const redacted = redactWithMetadata(entry, depth + 1);
    result[key] = redacted.value;
    truncated ||= redacted.truncated;
  }
  return { value: result, truncated };
}

export function redactString(value: string): string {
  return value
    .replace(AUTH_HEADER, REDACTED)
    .replace(AUTH_SCHEME, REDACTED)
    .replace(API_KEY, REDACTED)
    .replace(SENTRY_DSN, REDACTED)
    .replace(COOKIE, REDACTED)
    .replace(EMAIL, REDACTED);
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
