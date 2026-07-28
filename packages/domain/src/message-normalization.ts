const UUID =
  /(?<![0-9a-z])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-z])/gi;
const HASH =
  /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])|(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])|(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
const ISO_TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:z|[+-]\d{2}:?\d{2})\b/gi;
const UNIX_TIMESTAMP = /(?<!\d)\d{10}(?:\d{3})?(?!\d)/g;
const LABELED_NUMERIC_IDENTIFIER =
  /\b((?:account|event|job|order|record|request|session|task|user)(?:[_ -]?id)?\s*(?:=|:)?\s*)\d+\b/gi;
const HASH_NUMERIC_IDENTIFIER = /(^|[^\w])#\d+\b/g;
const ID_NUMERIC_IDENTIFIER = /\b(id\s*(?:=|:)\s*)\d+\b/gi;

/**
 * Replaces only the volatile categories defined by fingerprint version 1.
 * Ordinary words and semantic numbers, such as status codes and retry counts,
 * remain part of the grouping identity.
 */
export function normalizeMessageTemplate(value: string): string {
  return value
    .replace(ISO_TIMESTAMP, "{timestamp}")
    .replace(UUID, "{uuid}")
    .replace(HASH, "{hash}")
    .replace(UNIX_TIMESTAMP, "{timestamp}")
    .replace(LABELED_NUMERIC_IDENTIFIER, "$1{number}")
    .replace(ID_NUMERIC_IDENTIFIER, "$1{number}")
    .replace(HASH_NUMERIC_IDENTIFIER, "$1#{number}");
}
