import { Readable } from "node:stream";
import { fingerprintEvent } from "@sentrybox/domain";
import {
  decompressEnvelope,
  normalizeEvent,
  parseEnvelope,
  type NormalizedEvent,
  type NormalizedEventInput,
} from "@sentrybox/protocol";
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
import { createAdmissionReleaseHooks } from "./admission-lifecycle.js";

interface IngestRequest {
  readonly Params: { readonly projectId: string };
}

interface PreparedEvent {
  readonly input: NormalizedEventInput;
  readonly event: NormalizedEvent | null;
  readonly eventId: string;
  readonly environment: string;
}

interface PreparedEnvelope {
  readonly events: readonly PreparedEvent[];
  readonly discarded: number;
}

export function registerIngestRoute(
  app: FastifyInstance,
  options: PublicAppOptions,
  limits: PublicIngestLimits,
): void {
  const projects = new ProjectRepository(options.database);
  const issues = new IssueRepository(options.database);
  const globalLimiter = new FixedWindowRateLimiter(
    limits.globalRateLimit,
    limits.rateWindowMs,
    { maxKeys: 1 },
  );
  const sourceLimiter = new FixedWindowRateLimiter(
    limits.sourceRateLimit,
    limits.rateWindowMs,
    { maxKeys: limits.maxSourceKeys },
  );
  const projectLimiter = new FixedWindowRateLimiter(
    limits.projectRateLimit,
    limits.rateWindowMs,
  );
  const concurrency = new ConcurrencyGate(limits.maxConcurrentParses);
  const requestTimes = new WeakMap<FastifyRequest, Date>();
  const releases = new WeakMap<FastifyRequest, () => void>();
  const earlyAdmission = async (request: FastifyRequest): Promise<void> => {
    const now = (options.now ?? (() => new Date()))();
    const globalDecision = globalLimiter.consume("ingest", now.getTime());
    if (!globalDecision.allowed) {
      throw rateLimitError(globalDecision, limits);
    }
    const sourceDecision = sourceLimiter.consume(request.ip, now.getTime());
    if (!sourceDecision.allowed) {
      throw rateLimitError(sourceDecision, limits);
    }
    const release = concurrency.tryAcquire();
    if (release === null) {
      throw new SentryHttpError(
        429,
        "Concurrent ingest limit exceeded.",
        limits.retryAfterSeconds,
      );
    }
    requestTimes.set(request, now);
    releases.set(request, release);
  };
  const releaseRequest = (request: FastifyRequest): void => {
    releases.get(request)?.();
    releases.delete(request);
    requestTimes.delete(request);
  };
  const routeHooks = {
    onRequest: earlyAdmission,
    ...createAdmissionReleaseHooks(releaseRequest),
  };

  app.options<IngestRequest>(
    "/api/:projectId/envelope/",
    routeHooks,
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
    routeHooks,
    async (request, reply) => {
      const now = requestTimes.get(request);
      if (now === undefined) {
        throw new Error("ingest admission timestamp is unavailable");
      }
      if (!options.operations.storageSafety.snapshot().acceptingIngest) {
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

      const rawEnvelope = Buffer.from(request.body);
      const parseStarted = monotonicNow(options);
      let envelopeEventId: string | null;
      let prepared: PreparedEnvelope;
      try {
        const decompressed = await decompressEnvelope(
          Readable.from([rawEnvelope]),
          headerValue(request.headers["content-encoding"]),
        );
        const envelope = parseEnvelope(decompressed);
        envelopeEventId = canonicalEventIdOrNull(envelope.eventId);
        prepared = prepareEvents(
          envelope.items,
          envelopeEventId,
          ingestKey,
          now.toISOString(),
        );
      } finally {
        options.operations.metrics.observeParseDuration(
          Math.max(0, monotonicNow(options) - parseStarted) / 1_000,
        );
      }
      const responseEventId =
        envelopeEventId ?? prepared.events[0]?.eventId ?? "";
      const projectDecision = projectLimiter.consume(
        String(ingestKey.projectId),
        now.getTime(),
      );
      if (!projectDecision.allowed) {
        return sendSentryError(reply, rateLimitError(projectDecision, limits));
      }

      if (!options.operations.storageSafety.snapshot().acceptingIngest) {
        return sendSentryError(
          reply,
          new SentryHttpError(
            503,
            "Ingest storage is temporarily unavailable.",
            limits.retryAfterSeconds,
          ),
        );
      }
      const admittedEvents = prepared.events.filter(
        (preparedEvent) => preparedEvent.event !== null,
      ).length;
      const reservation =
        admittedEvents === 0
          ? null
          : options.operations.storageSafety.reserveIngest(admittedEvents);
      if (admittedEvents > 0 && reservation === null) {
        return sendSentryError(
          reply,
          new SentryHttpError(
            503,
            "Ingest storage is temporarily unavailable.",
            limits.retryAfterSeconds,
          ),
        );
      }
      let persistedEvents = 0;
      try {
        for (const preparedEvent of prepared.events) {
          if (preparedEvent.event === null) continue;
          const event = preparedEvent.event;
          const result = issues.recordOccurrence({
            projectId: ingestKey.projectId,
            event,
            fingerprint: fingerprintEvent(preparedEvent.input),
            buildOutbox: (transition, destination) =>
              options.buildOutbox({
                ingestKey,
                event,
                transition,
                destination,
              }),
          });
          options.operations.metrics.recordIngest("accepted");
          options.operations.metrics.recordGrouping(result);
          if (!result.duplicate) persistedEvents += 1;
        }
        for (let index = 0; index < prepared.discarded; index += 1) {
          options.operations.metrics.recordIngest("discarded");
        }
      } catch {
        reservation?.release(admittedEvents - persistedEvents);
        return sendSentryError(
          reply,
          new SentryHttpError(
            503,
            "Ingest storage is temporarily unavailable.",
            limits.retryAfterSeconds,
          ),
        );
      }
      reservation?.release(admittedEvents - persistedEvents);

      const eventEnvironment = prepared.events[0]?.environment;
      if (
        eventEnvironment !== undefined &&
        ingestKey.forwardingMode === "shadow"
      ) {
        try {
          options.shadowForwarder.enqueue({
            ingestKey,
            eventEnvironment,
            envelope: rawEnvelope,
            contentEncoding: headerValue(request.headers["content-encoding"]),
            sentryClient: requestSentryClient(request),
          });
        } catch {
          reportOperationalMetric(options, { type: "shadow_enqueue_failure" });
        }
      }
      return reply.code(200).send({ id: responseEventId });
    },
  );
}

function rateLimitError(
  decision: { readonly retryAfterSeconds: number },
  limits: PublicIngestLimits,
): SentryHttpError {
  return new SentryHttpError(
    429,
    "Rate limit exceeded.",
    Math.max(decision.retryAfterSeconds, limits.retryAfterSeconds),
  );
}

function reportOperationalMetric(
  options: PublicAppOptions,
  metric: { readonly type: "shadow_enqueue_failure" },
): void {
  try {
    options.onOperationalMetric?.(metric);
  } catch {
    // Operational reporting must never change the SDK response after commit.
  }
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
): PreparedEnvelope {
  const prepared: PreparedEvent[] = [];
  let discarded = 0;
  for (const item of items) {
    if (isRejectedBinaryItem(item)) {
      throw new SentryHttpError(
        400,
        "Binary envelope items are not supported.",
      );
    }
    if (item.type !== "event") {
      discarded += 1;
      continue;
    }
    const input = parseEventPayload(item.payload);
    const payloadEventId =
      input.event_id === undefined ? null : canonicalEventId(input.event_id);
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
      discarded += 1;
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
  return { events: prepared, discarded };
}

function monotonicNow(options: PublicAppOptions): number {
  const value = options.monotonicNow?.() ?? performance.now();
  if (!Number.isFinite(value)) {
    throw new TypeError("ingest monotonic clock must be finite");
  }
  return value;
}

function canonicalEventIdOrNull(eventId: string | null): string | null {
  return eventId === null ? null : canonicalEventId(eventId);
}

function canonicalEventId(eventId: unknown): string {
  if (typeof eventId !== "string" || !/^[a-f0-9]{32}$/iu.test(eventId)) {
    throw new SentryHttpError(400, "Event ID is invalid.");
  }
  return eventId.toLowerCase();
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
