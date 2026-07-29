import Fastify, { type FastifyInstance } from "fastify";
import type {
  OutboxDraft,
  OutboxTransition,
} from "./storage/outbox-repository.js";
import type { ErrorHubDatabase } from "./storage/database.js";
import type { VerifiedIngestKey } from "./storage/project-repository.js";
import type { NormalizedEvent } from "@intexura-error-hub/protocol";
import type { CurrentWebhookDestination } from "./storage/issue-repository.js";
import type { ShadowForwarder } from "./ingest/shadow-forwarder.js";
import { MAX_DECOMPRESSED_ENVELOPE_BYTES } from "@intexura-error-hub/protocol";
import { registerIngestRoute } from "./ingest/route.js";
import { installSentryErrorHandler } from "./http/sentry-errors.js";
import type { OperationsContext } from "./operations.js";

export interface PublicIngestLimits {
  readonly globalRateLimit: number;
  readonly sourceRateLimit: number;
  readonly maxSourceKeys: number;
  readonly projectRateLimit: number;
  readonly rateWindowMs: number;
  readonly retryAfterSeconds: number;
  readonly maxConcurrentParses: number;
  readonly requestTimeoutMs: number;
}

export interface PublicOperationalMetric {
  readonly type: "shadow_enqueue_failure";
}

export interface BuildOutboxInput {
  readonly ingestKey: VerifiedIngestKey;
  readonly event: NormalizedEvent;
  readonly transition: OutboxTransition;
  readonly destination: CurrentWebhookDestination;
}

export interface PublicAppOptions {
  readonly database: ErrorHubDatabase;
  readonly operations: OperationsContext;
  readonly shadowForwarder: Pick<ShadowForwarder, "enqueue">;
  readonly buildOutbox: (input: BuildOutboxInput) => OutboxDraft;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly onOperationalMetric?: (metric: PublicOperationalMetric) => void;
  readonly limits?: Partial<PublicIngestLimits>;
}

export const MAX_COMPRESSED_ENVELOPE_BYTES =
  MAX_DECOMPRESSED_ENVELOPE_BYTES + 65_536;

export function createPublicApp(options: PublicAppOptions): FastifyInstance {
  const limits: PublicIngestLimits = {
    globalRateLimit: options.limits?.globalRateLimit ?? 5_000,
    sourceRateLimit: options.limits?.sourceRateLimit ?? 120,
    maxSourceKeys: options.limits?.maxSourceKeys ?? 10_000,
    projectRateLimit: options.limits?.projectRateLimit ?? 1_000,
    rateWindowMs: options.limits?.rateWindowMs ?? 60_000,
    retryAfterSeconds: options.limits?.retryAfterSeconds ?? 60,
    maxConcurrentParses: options.limits?.maxConcurrentParses ?? 16,
    requestTimeoutMs: options.limits?.requestTimeoutMs ?? 10_000,
  };
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_COMPRESSED_ENVELOPE_BYTES,
    disableRequestLogging: true,
    requestTimeout: limits.requestTimeoutMs,
    connectionTimeout: limits.requestTimeoutMs,
    trustProxy: ["127.0.0.1", "::1"],
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    {
      parseAs: "buffer",
      bodyLimit: MAX_COMPRESSED_ENVELOPE_BYTES,
    },
    (_request, body, done) => {
      done(null, body);
    },
  );
  installSentryErrorHandler(app, limits.retryAfterSeconds);
  app.addHook("onResponse", async (request, reply) => {
    if (request.method === "POST" && reply.statusCode >= 400) {
      options.operations.metrics.recordIngest("rejected");
    }
  });
  registerIngestRoute(app, options, limits);
  app.get("/health/live", async () => ({ status: "ok" }));
  return app;
}
