import { EnvelopeProtocolError } from "./sentry-types.js";

import type { EnvelopeItem, ParsedEnvelope } from "./sentry-types.js";

const NEWLINE = 0x0a;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function parseEnvelope(body: Uint8Array): ParsedEnvelope {
  if (body.length === 0) {
    throw new EnvelopeProtocolError(
      "MALFORMED_JSON",
      "Envelope headers are required.",
    );
  }

  const firstNewline = body.indexOf(NEWLINE);
  const headerEnd = firstNewline === -1 ? body.length : firstNewline;
  const headers = parseHeader(body.subarray(0, headerEnd), "envelope");
  const eventId = readEventId(headers);
  const items: EnvelopeItem[] = [];
  let cursor = firstNewline === -1 ? body.length : firstNewline + 1;

  while (cursor < body.length) {
    const itemHeaderEnd = body.indexOf(NEWLINE, cursor);
    if (itemHeaderEnd === -1) {
      throw new EnvelopeProtocolError(
        "TRUNCATED_ITEM",
        "Item headers must be followed by a payload delimiter.",
      );
    }

    const itemHeaders = parseHeader(
      body.subarray(cursor, itemHeaderEnd),
      "item",
    );
    const type = itemHeaders.type;
    if (typeof type !== "string" || type.length === 0) {
      throw new EnvelopeProtocolError(
        "INVALID_ITEM_HEADER",
        "An item header requires a string type.",
      );
    }

    cursor = itemHeaderEnd + 1;
    const length = readItemLength(itemHeaders);
    let payload: Uint8Array;

    if (length === null) {
      const payloadEnd = body.indexOf(NEWLINE, cursor);
      if (payloadEnd === -1) {
        payload = body.slice(cursor);
        cursor = body.length;
      } else {
        payload = body.slice(cursor, payloadEnd);
        cursor = payloadEnd + 1;
      }
    } else {
      if (body.length - cursor < length) {
        throw new EnvelopeProtocolError(
          "TRUNCATED_PAYLOAD",
          "A length-framed item payload ended before its declared length.",
        );
      }

      payload = body.slice(cursor, cursor + length);
      cursor += length;
      if (cursor < body.length) {
        if (body[cursor] !== NEWLINE) {
          throw new EnvelopeProtocolError(
            "AMBIGUOUS_PAYLOAD_FRAMING",
            "A length-framed item must be followed by a newline before another item.",
          );
        }
        cursor += 1;
      }
    }

    items.push({ type, headers: itemHeaders, payload });
  }

  return { eventId, headers, items };
}

function parseHeader(
  bytes: Uint8Array,
  kind: "envelope" | "item",
): Readonly<Record<string, unknown>> {
  const source = decodeHeader(bytes, kind);
  assertNoDuplicateFields(source, kind);

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new EnvelopeProtocolError(
      "MALFORMED_JSON",
      `Malformed ${kind} header JSON.`,
      {
        cause: error,
      },
    );
  }

  if (!isRecord(parsed)) {
    throw new EnvelopeProtocolError(
      kind === "item" ? "INVALID_ITEM_HEADER" : "INVALID_ENVELOPE_HEADER",
      `${capitalize(kind)} headers must be JSON objects.`,
    );
  }

  return parsed;
}

function decodeHeader(bytes: Uint8Array, kind: "envelope" | "item"): string {
  try {
    return textDecoder.decode(bytes);
  } catch (error) {
    throw new EnvelopeProtocolError(
      "MALFORMED_JSON",
      `Malformed ${kind} header encoding.`,
      {
        cause: error,
      },
    );
  }
}

function readEventId(
  headers: Readonly<Record<string, unknown>>,
): string | null {
  const eventId = headers.event_id;
  if (eventId === undefined) {
    return null;
  }
  if (typeof eventId !== "string") {
    throw new EnvelopeProtocolError(
      "INVALID_ENVELOPE_HEADER",
      "event_id must be a string.",
    );
  }
  return eventId;
}

function readItemLength(
  headers: Readonly<Record<string, unknown>>,
): number | null {
  const length = headers.length;
  if (length === undefined) {
    return null;
  }
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    throw new EnvelopeProtocolError(
      "INVALID_ITEM_HEADER",
      "An item length must be a non-negative safe integer.",
    );
  }
  return length;
}

function assertNoDuplicateFields(
  source: string,
  kind: "envelope" | "item",
): void {
  let cursor = skipWhitespace(source, 0);
  if (source[cursor] !== "{") {
    return;
  }
  cursor = skipWhitespace(source, cursor + 1);
  const fields = new Set<string>();

  while (source[cursor] !== "}") {
    if (source[cursor] !== '"') {
      return;
    }
    const keyStart = cursor;
    cursor = consumeString(source, cursor);
    let key: string;
    try {
      key = JSON.parse(source.slice(keyStart, cursor)) as string;
    } catch {
      return;
    }
    if (fields.has(key)) {
      throw new EnvelopeProtocolError(
        "DUPLICATE_HEADER_FIELD",
        `Duplicate ${kind} header field: ${key}.`,
      );
    }
    fields.add(key);
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] !== ":") {
      return;
    }
    cursor = skipWhitespace(source, consumeJsonValue(source, cursor + 1));
    if (source[cursor] === ",") {
      cursor = skipWhitespace(source, cursor + 1);
      continue;
    }
    return;
  }
}

function consumeString(source: string, start: number): number {
  let escaped = false;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return cursor + 1;
    }
  }
  return source.length;
}

function consumeJsonValue(source: string, start: number): number {
  const first = source[start];
  if (first === '"') {
    return consumeString(source, start);
  }
  if (first !== "{" && first !== "[") {
    let cursor = start;
    while (cursor < source.length && !"\t\n\r ,}".includes(source[cursor]!)) {
      cursor += 1;
    }
    return cursor;
  }

  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '"') {
      cursor = consumeString(source, cursor) - 1;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
  }
  return source.length;
}

function skipWhitespace(source: string, cursor: number): number {
  while (cursor < source.length && "\t\n\r ".includes(source[cursor]!)) {
    cursor += 1;
  }
  return cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capitalize(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
