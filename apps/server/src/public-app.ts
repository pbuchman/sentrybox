import Fastify, { type FastifyInstance } from "fastify";
import type {
  OutboxDraft,
  OutboxTransition,
} from "./storage/outbox-repository.js";
import type { ErrorHubDatabase } from "./storage/database.js";
import type { VerifiedIngestKey } from "./storage/project-repository.js";
import type { NormalizedEvent } from "@intexura-error-hub/protocol";
import type { ShadowForwarder } from "./ingest/shadow-forwarder.js";
import { MAX_DECOMPRESSED_ENVELOPE_BYTES } from "@intexura-error-hub/protocol";
import { registerIngestRoute } from "./ingest/route.js";
import { installSentryErrorHandler } from "./http/sentry-errors.js";

export interface PublicIngestLimits {
  readonly sourceRateLimit: number;
  readonly projectRateLimit: number;
  readonly rateWindowMs: number;
  readonly retryAfterSeconds: number;
  readonly maxConcurrentParses: number;
  readonly requestTimeoutMs: number;
}

export interface BuildOutboxInput {
  readonly ingestKey: VerifiedIngestKey;
  readonly event: NormalizedEvent;
  readonly transition: OutboxTransition;
}

export interface PublicAppOptions {
  readonly database: ErrorHubDatabase;
  readonly shadowForwarder: ShadowForwarder;
  readonly buildOutbox: (input: BuildOutboxInput) => OutboxDraft;
  readonly now?: () => Date;
  readonly isStorageReady?: () => boolean;
  readonly limits?: Partial<PublicIngestLimits>;
}

export function createPublicApp(options: PublicAppOptions): FastifyInstance {
  const limits: PublicIngestLimits = {
    sourceRateLimit: options.limits?.sourceRateLimit ?? 120,
    projectRateLimit: options.limits?.projectRateLimit ?? 1_000,
    rateWindowMs: options.limits?.rateWindowMs ?? 60_000,
    retryAfterSeconds: options.limits?.retryAfterSeconds ?? 60,
    maxConcurrentParses: options.limits?.maxConcurrentParses ?? 16,
    requestTimeoutMs: options.limits?.requestTimeoutMs ?? 10_000,
  };
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_DECOMPRESSED_ENVELOPE_BYTES,
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
      bodyLimit: MAX_DECOMPRESSED_ENVELOPE_BYTES,
    },
    (_request, body, done) => {
      done(null, body);
    },
  );
  installSentryErrorHandler(app);
  registerIngestRoute(app, options, limits);
  app.get("/health/live", async () => ({ status: "ok" }));
  return app;
}
