import { Readable } from "node:stream";
import { fingerprintEvent } from "@intexura-error-hub/domain";
import {
  decompressEnvelope,
  normalizeEvent,
  parseEnvelope,
  type NormalizedEvent,
  type NormalizedEventInput,
} from "@intexura-error-hub/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PublicAppOptions, PublicIngestLimits } from "../public-app.js";
import { SentryHttpError, sendSentryError } from "../http/sentry-errors.js";
import { IssueRepository } from "../storage/issue-repository.js";
import {
  ProjectRepository,
  type VerifiedIngestKey,
} from "../storage/project-repository.js";
import { authenticateProject } from "./project-auth.js";
import { ConcurrencyGate, FixedWindowRateLimiter } from "./rate-limit.js";

interface IngestRequest {
  readonly Params: { readonly projectId: string };
}

interface PreparedEvent {
  readonly input: NormalizedEventInput;
  readonly event: NormalizedEvent | null;
  readonly eventId: string;
  readonly environment: string;
}

export function registerIngestRoute(
  app: FastifyInstance,
  options: PublicAppOptions,
  limits: PublicIngestLimits,
): void {
  const projects = new ProjectRepository(options.database);
  const issues = new IssueRepository(options.database);
  const sourceLimiter = new FixedWindowRateLimiter(
    limits.sourceRateLimit,
    limits.rateWindowMs,
  );
  const projectLimiter = new FixedWindowRateLimiter(
    limits.projectRateLimit,
    limits.rateWindowMs,
  );
  const concurrency = new ConcurrencyGate(limits.maxConcurrentParses);

  app.options<IngestRequest>(
    "/api/:projectId/envelope/",
    async (request, reply) => {
      const ingestKey = authenticateProjectSafely(request, projects, limits);
      if (ingestKey === null) {
        return sendSentryError(
          reply,
          new SentryHttpError(400, "Invalid project credentials."),
        );
      }
      if (!applyCors(request, reply, ingestKey)) {
        return sendSentryError(
          reply,
          new SentryHttpError(400, "Origin is not allowed."),
        );
      }
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      reply.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Content-Encoding, X-Sentry-Auth",
      );
      return reply.code(204).send();
    },
  );

  app.post<IngestRequest>(
    "/api/:projectId/envelope/",
    async (request, reply) => {
      const now = (options.now ?? (() => new Date()))();
      const sourceDecision = sourceLimiter.consume(request.ip, now.getTime());
      if (!sourceDecision.allowed) {
        return sendSentryError(
          reply,
          new SentryHttpError(
            429,
            "Rate limit exceeded.",
            Math.max(
              sourceDecision.retryAfterSeconds,
              limits.retryAfterSeconds,
            ),
          ),
        );
      }
      if (options.isStorageReady?.() === false) {
        return sendSentryError(
          reply,
          new SentryHttpError(
            503,
            "Ingest storage is temporarily unavailable.",
            limits.retryAfterSeconds,
          ),
        );
      }

      const ingestKey = authenticateProjectSafely(request, projects, limits);
      if (ingestKey === null) {
        return sendSentryError(
          reply,
          new SentryHttpError(400, "Invalid project credentials."),
        );
      }
      const projectDecision = projectLimiter.consume(
        String(ingestKey.projectId),
        now.getTime(),
      );
      if (!projectDecision.allowed) {
        return sendSentryError(
          reply,
          new SentryHttpError(
            429,
            "Rate limit exceeded.",
            Math.max(
              projectDecision.retryAfterSeconds,
              limits.retryAfterSeconds,
            ),
          ),
        );
      }
      if (!applyCors(request, reply, ingestKey)) {
        return sendSentryError(
          reply,
          new SentryHttpError(400, "Origin is not allowed."),
        );
      }
      if (!Buffer.isBuffer(request.body)) {
        return sendSentryError(
          reply,
          new SentryHttpError(400, "Envelope body is required."),
        );
      }

      const release = concurrency.tryAcquire();
      if (release === null) {
        return sendSentryError(
          reply,
          new SentryHttpError(
            429,
            "Concurrent ingest limit exceeded.",
            limits.retryAfterSeconds,
          ),
        );
      }

      const rawEnvelope = Buffer.from(request.body);
      try {
        const decompressed = await decompressEnvelope(
          Readable.from([rawEnvelope]),
          headerValue(request.headers["content-encoding"]),
        );
        const envelope = parseEnvelope(decompressed);
        const prepared = prepareEvents(
          envelope.items,
          envelope.eventId,
          ingestKey,
          now.toISOString(),
        );
        const responseEventId = envelope.eventId ?? prepared[0]?.eventId ?? "";

        try {
          for (const preparedEvent of prepared) {
            if (preparedEvent.event === null) continue;
            const event = preparedEvent.event;
            issues.recordOccurrence({
              projectId: ingestKey.projectId,
              event,
              fingerprint: fingerprintEvent(preparedEvent.input),
              buildOutbox: (transition) =>
                options.buildOutbox({ ingestKey, event, transition }),
            });
          }
        } catch {
          return sendSentryError(
            reply,
            new SentryHttpError(
              503,
              "Ingest storage is temporarily unavailable.",
              limits.retryAfterSeconds,
            ),
          );
        }

        const eventEnvironment = prepared[0]?.environment;
        if (
          eventEnvironment !== undefined &&
          ingestKey.forwardingMode === "shadow"
        ) {
          options.shadowForwarder.enqueue({
            ingestKey,
            eventEnvironment,
            envelope: rawEnvelope,
            contentEncoding: headerValue(request.headers["content-encoding"]),
            sentryClient: requestSentryClient(request),
          });
        }
        return reply.code(200).send({ id: responseEventId });
      } finally {
        release();
      }
    },
  );
}

function authenticateProjectSafely(
  request: FastifyRequest<IngestRequest>,
  projects: ProjectRepository,
  limits: PublicIngestLimits,
): VerifiedIngestKey | null {
  try {
    return authenticateProject(request, projects);
  } catch {
    throw new SentryHttpError(
      503,
      "Ingest storage is temporarily unavailable.",
      limits.retryAfterSeconds,
    );
  }
}

function prepareEvents(
  items: readonly {
    readonly type: string;
    readonly headers: Readonly<Record<string, unknown>>;
    readonly payload: Uint8Array;
  }[],
  envelopeEventId: string | null,
  ingestKey: VerifiedIngestKey,
  receivedAt: string,
): readonly PreparedEvent[] {
  const prepared: PreparedEvent[] = [];
  for (const item of items) {
    if (isRejectedBinaryItem(item)) {
      throw new SentryHttpError(
        400,
        "Binary envelope items are not supported.",
      );
    }
    if (item.type !== "event") continue;
    const input = parseEventPayload(item.payload);
    const payloadEventId =
      typeof input.event_id === "string" && input.event_id.length > 0
        ? input.event_id
        : null;
    if (
      envelopeEventId !== null &&
      payloadEventId !== null &&
      envelopeEventId !== payloadEventId
    ) {
      throw new SentryHttpError(400, "Envelope and event IDs do not match.");
    }
    const eventId = payloadEventId ?? envelopeEventId;
    const environment =
      typeof input.environment === "string" ? input.environment : null;
    if (
      eventId === null ||
      eventId.length === 0 ||
      environment === null ||
      environment !== ingestKey.environment
    ) {
      throw new SentryHttpError(
        400,
        "Event metadata does not match the ingest key.",
      );
    }

    const normalized = normalizeEvent(input, receivedAt);
    if (!normalized.accepted) {
      prepared.push({ input, event: null, eventId, environment });
      continue;
    }
    if (!Number.isFinite(Date.parse(normalized.event.occurredAt))) {
      throw new SentryHttpError(400, "Event timestamp is invalid.");
    }
    prepared.push({
      input,
      event: {
        ...normalized.event,
        id: eventId,
        environment,
      },
      eventId,
      environment,
    });
  }
  return prepared;
}

function isRejectedBinaryItem(item: {
  readonly type: string;
  readonly headers: Readonly<Record<string, unknown>>;
}): boolean {
  if (item.type === "attachment") return true;
  const contentType = item.headers.content_type;
  return (
    typeof contentType === "string" &&
    contentType.toLowerCase().startsWith("application/octet-stream")
  );
}

function parseEventPayload(payload: Uint8Array): NormalizedEventInput {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payload),
    );
  } catch {
    throw new SentryHttpError(400, "Event item is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SentryHttpError(400, "Event item must be a JSON object.");
  }
  return value as NormalizedEventInput;
}

function applyCors(
  request: FastifyRequest,
  reply: FastifyReply,
  ingestKey: VerifiedIngestKey,
): boolean {
  const origin = headerValue(request.headers.origin);
  if (origin === undefined) return true;
  if (!ingestKey.allowedOrigins.includes(origin)) return false;
  reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Vary", "Origin");
  return true;
}

function requestSentryClient(request: FastifyRequest): string | null {
  const url = new URL(request.raw.url ?? "", "http://error-hub.invalid");
  return url.searchParams.get("sentry_client");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
