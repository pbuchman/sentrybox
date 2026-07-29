import { MAX_RECURSION_DEPTH } from "./limits.js";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED: recursion_depth]";
const SENSITIVE_KEY =
  /(?:auth(?:entication|orization)?|cookie|credential|secret|password|token|api[_-]?key|request[_-]?body|body|content|access[_-]?key)/i;
const AUTH_HEADER =
  /\b(?:authorization|authentication|auth)\s*[:=]\s*[^\r\n]*/gi;
const BEARER_TOKEN = /\bbearer\s+[^\s,;]+/gi;
const BASIC_CANDIDATE = /\bbasic\s+([A-Z0-9+/]+={0,2})(?=$|[\s,;])/gi;
const DIGEST_CANDIDATE = /\bdigest\s+[^\r\n]*/gi;
const DIGEST_PARAMETER =
  /\b(username|realm|nonce|uri|response|algorithm|qop|nc|cnonce)\s*=\s*(?:"(?:\\.|[^"\\])*"|[^,\s]+)/gi;
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
  return redactDigestCandidates(
    redactBasicCandidates(
      value
        .replace(AUTH_HEADER, REDACTED)
        .replace(BEARER_TOKEN, REDACTED)
        .replace(API_KEY, REDACTED)
        .replace(SENTRY_DSN, REDACTED)
        .replace(COOKIE, REDACTED)
        .replace(EMAIL, REDACTED),
    ),
  );
}

function redactBasicCandidates(value: string): string {
  return value.replace(BASIC_CANDIDATE, (candidate, encoded: string) =>
    isBasicCredential(encoded) ? REDACTED : candidate,
  );
}

function isBasicCredential(encoded: string): boolean {
  const unpadded = encoded.replace(/=+$/u, "");
  if (
    unpadded.length === 0 ||
    unpadded.length % 4 === 1 ||
    (encoded.includes("=") && encoded.length % 4 !== 0)
  ) {
    return false;
  }

  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  try {
    const decoded = atob(padded);
    const canonical = btoa(decoded);
    if (encoded !== canonical && encoded !== canonical.replace(/=+$/u, "")) {
      return false;
    }
    return decoded.includes(":");
  } catch {
    return false;
  }
}

function redactDigestCandidates(value: string): string {
  return value.replace(DIGEST_CANDIDATE, (candidate) =>
    hasDigestCredentials(candidate) ? REDACTED : candidate,
  );
}

function hasDigestCredentials(candidate: string): boolean {
  const parameters = new Set<string>();
  for (const match of candidate.matchAll(DIGEST_PARAMETER)) {
    parameters.add(match[1]!.toLowerCase());
  }
  return (
    parameters.size >= 2 &&
    parameters.has("username") &&
    parameters.has("response")
  );
}

export function isSensitiveKey(key: string): boolean {
  return key.toLowerCase() !== "content-type" && SENSITIVE_KEY.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
