import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { EnvelopeProtocolError } from "@intexura-error-hub/protocol";

export type SentryErrorStatus = 400 | 413 | 429 | 500 | 503;

export class SentryHttpError extends Error {
  public readonly name = "SentryHttpError";

  public constructor(
    public readonly statusCode: SentryErrorStatus,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function sendSentryError(
  reply: FastifyReply,
  error: SentryHttpError,
): FastifyReply {
  reply.header("X-Sentry-Error", error.message);
  if (error.retryAfterSeconds !== undefined) {
    reply.header("Retry-After", String(error.retryAfterSeconds));
  }
  return reply.code(error.statusCode).send({ detail: error.message });
}

export function installSentryErrorHandler(
  app: FastifyInstance,
  retryAfterSeconds: number,
): void {
  app.setErrorHandler(
    (
      error: FastifyError | Error,
      _request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      if (error instanceof SentryHttpError) {
        return sendSentryError(reply, error);
      }
      if (
        "code" in error &&
        (error as { readonly code?: unknown }).code ===
          "FST_ERR_CTP_BODY_TOO_LARGE"
      ) {
        return sendSentryError(
          reply,
          new SentryHttpError(413, "Envelope body exceeds 1 MiB."),
        );
      }
      if (error instanceof EnvelopeProtocolError) {
        const tooLarge =
          error.code === "DECOMPRESSED_BODY_TOO_LARGE" ||
          error.code === "DECOMPRESSION_RATIO_EXCEEDED";
        return sendSentryError(
          reply,
          new SentryHttpError(
            tooLarge ? 413 : 400,
            error.code === "UNSUPPORTED_CONTENT_ENCODING"
              ? "Unsupported Content-Encoding."
              : error.message,
          ),
        );
      }
      return sendSentryError(
        reply,
        new SentryHttpError(500, "Internal ingest failure.", retryAfterSeconds),
      );
    },
  );
}
