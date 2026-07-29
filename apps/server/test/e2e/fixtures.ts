import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

export const NODE_EVENT_ID = "11111111111111111111111111111111";
export const PUBLIC_KEY = "task-11-public-key";
export const WEB_PUBLIC_KEY = "task-11-web-public-key";

export const nodeEnvelope855 = readFileSync(
  new URL(
    "../../../../packages/protocol/test/fixtures/node-event.envelope",
    import.meta.url,
  ),
);

export const browserEnvelope855 = readFileSync(
  new URL(
    "../../../../packages/protocol/test/fixtures/browser-event.envelope",
    import.meta.url,
  ),
);

export interface FixtureEnvelopeOptions {
  readonly eventId: string;
  readonly timestampSeconds: number;
  readonly release: string | null;
  readonly service: string;
  readonly requestId?: string;
  readonly level?: "debug" | "info" | "error" | "fatal";
  readonly forbiddenValues?: readonly string[];
}

export function nodeFixtureEnvelope(options: FixtureEnvelopeOptions): Buffer {
  return customizeEnvelope(nodeEnvelope855, options);
}

export function browserFixtureEnvelopeGzip(
  options: FixtureEnvelopeOptions,
): Buffer {
  return gzipSync(customizeEnvelope(browserEnvelope855, options));
}

function customizeEnvelope(
  source: Buffer,
  options: FixtureEnvelopeOptions,
): Buffer {
  const [rawEnvelopeHeader, rawItemHeader, rawPayload] = source
    .toString("utf8")
    .trimEnd()
    .split("\n");
  if (
    rawEnvelopeHeader === undefined ||
    rawItemHeader === undefined ||
    rawPayload === undefined
  ) {
    throw new Error("captured SDK fixture envelope is malformed");
  }
  const envelopeHeader = JSON.parse(rawEnvelopeHeader) as Record<
    string,
    unknown
  >;
  const payload = JSON.parse(rawPayload) as Record<string, unknown>;
  envelopeHeader.event_id = options.eventId;
  payload.event_id = options.eventId;
  payload.timestamp = new Date(options.timestampSeconds * 1_000).toISOString();
  payload.environment = "fixture";
  if (options.release === null) delete payload.release;
  else payload.release = options.release;
  payload.server_name = options.service;
  payload.level = options.level ?? "error";
  payload.fingerprint = ["task-11-runtime-group"];
  const extra = record(payload.extra);
  if (options.requestId !== undefined) {
    extra.requestId = options.requestId;
  }
  if (options.forbiddenValues !== undefined) {
    const [authorization = "", cookie = "", password = "", token = ""] =
      options.forbiddenValues;
    payload.request = {
      headers: { Authorization: authorization, Cookie: cookie },
    };
    extra.password = password;
    extra.access_token = token;
  }
  if (Object.keys(extra).length > 0) payload.extra = extra;
  return Buffer.from(
    `${JSON.stringify(envelopeHeader)}\n${rawItemHeader}\n${JSON.stringify(payload)}`,
    "utf8",
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Readonly<Record<string, unknown>>) }
    : {};
}
