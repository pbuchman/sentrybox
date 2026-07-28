import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DECOMPRESSION_LIMITS,
  EnvelopeProtocolError,
  decompressEnvelope,
  parseEnvelope,
} from "./index.js";

const fixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(
    await readFile(new URL(`../test/fixtures/${name}`, import.meta.url)),
  );

describe("parseEnvelope", () => {
  it("accepts a newline-framed Node SDK event without requiring content type metadata", async () => {
    const envelope = parseEnvelope(await fixture("node-event.envelope"));

    expect(envelope.eventId).toBe("11111111111111111111111111111111");
    expect(envelope.headers.sdk).toEqual({
      name: "sentry.javascript.node",
      version: "8.55.0",
    });
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0]).toMatchObject({ type: "event" });
    expect(
      JSON.parse(new TextDecoder().decode(envelope.items[0]!.payload)),
    ).toMatchObject({
      level: "error",
      platform: "node",
    });
  });

  it("accepts a newline-framed React SDK event", async () => {
    const envelope = parseEnvelope(await fixture("browser-event.envelope"));

    expect(envelope.eventId).toBe("22222222222222222222222222222222");
    expect(envelope.headers.sdk).toEqual({
      name: "sentry.javascript.react",
      version: "8.55.0",
    });
    expect(envelope.items[0]?.type).toBe("event");
  });

  it("preserves supported, unsupported, and future items with length and newline framing", async () => {
    const envelope = parseEnvelope(await fixture("mixed-items.envelope"));

    expect(envelope.items.map((item) => item.type)).toEqual([
      "event",
      "client_report",
      "future_item",
    ]);
    expect(new TextDecoder().decode(envelope.items[1]!.payload)).toBe("a\nb!");
    expect(new TextDecoder().decode(envelope.items[2]!.payload)).toBe(
      "opaque payload",
    );
  });

  it("rejects an item header without a type", () => {
    const body = new TextEncoder().encode('{"event_id":"event"}\n{}\n{}');

    expectProtocolError(() => parseEnvelope(body), "INVALID_ITEM_HEADER");
  });

  it("rejects duplicate item header fields before JSON parsing can overwrite one", () => {
    const body = new TextEncoder().encode(
      '{"event_id":"event"}\n{"type":"event","type":"transaction"}\n{}',
    );

    expectProtocolError(() => parseEnvelope(body), "DUPLICATE_HEADER_FIELD");
  });

  it("rejects malformed envelope JSON", () => {
    const body = new TextEncoder().encode(
      '{"event_id":}\n{"type":"event"}\n{}',
    );

    expectProtocolError(() => parseEnvelope(body), "MALFORMED_JSON");
  });

  it("wraps malformed item header keys in a typed protocol error", () => {
    const body = new TextEncoder().encode('{"event_id":"event"}\n{"type\n{}');

    expectProtocolError(() => parseEnvelope(body), "MALFORMED_JSON");
  });

  it("rejects a length-framed payload that is truncated", () => {
    const body = new TextEncoder().encode(
      '{"event_id":"event"}\n{"type":"event","length":5}\nabc',
    );

    expectProtocolError(() => parseEnvelope(body), "TRUNCATED_PAYLOAD");
  });
});

describe("decompressEnvelope", () => {
  it("accepts an identity body when content type is absent", async () => {
    const body = new TextEncoder().encode('{"event_id":"event"}');

    await expect(
      decompressEnvelope(streamOf(body), undefined),
    ).resolves.toEqual(body);
  });

  it("decompresses a gzip request body", async () => {
    const body = new TextEncoder().encode('{"event_id":"event"}');

    await expect(
      decompressEnvelope(streamOf(gzipSync(body)), "gzip"),
    ).resolves.toEqual(body);
  });

  it("rejects a decompressed body larger than one MiB", async () => {
    const body = new Uint8Array(1_048_577);
    for (let offset = 0; offset < body.length; offset += 65_536) {
      crypto.getRandomValues(
        body.subarray(offset, Math.min(offset + 65_536, body.length)),
      );
    }

    await expect(
      decompressEnvelope(streamOf(gzipSync(body)), "gzip"),
    ).rejects.toMatchObject({
      code: "DECOMPRESSED_BODY_TOO_LARGE",
    });
  });

  it("enforces an injectable decompression ratio while streaming", async () => {
    const body = new TextEncoder().encode("a".repeat(256));

    await expect(
      decompressEnvelope(streamOf(gzipSync(body)), "gzip", {
        maxCompressionRatio: 1,
      }),
    ).rejects.toMatchObject({ code: "DECOMPRESSION_RATIO_EXCEEDED" });
    expect(DEFAULT_DECOMPRESSION_LIMITS.maxCompressionRatio).toBe(100);
  });
});

function streamOf(body: Uint8Array): NodeJS.ReadableStream {
  return Readable.from([body]);
}

function expectProtocolError(action: () => void, code: string): void {
  expect(action).toThrow(EnvelopeProtocolError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}
