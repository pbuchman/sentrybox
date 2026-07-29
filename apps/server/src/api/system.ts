import type { FastifyInstance } from "fastify";
import type { SecretStore } from "../secrets.js";
import type { ErrorHubDatabase } from "../storage/database.js";
import {
  OutboxRepository,
  WebhookRedriveConflictError,
  WebhookRedriveNotFoundError,
} from "../storage/outbox-repository.js";
import { conflict, notFound, positiveId } from "./query.js";
import type { HealthStatusService } from "../health/status.js";
import type { ErrorHubMetrics } from "../metrics.js";
import type { StorageSafetyState } from "../retention/storage-budget.js";

interface DeliveryParams {
  readonly Params: { readonly id: string };
}

export interface SystemRouteOptions {
  readonly database: ErrorHubDatabase;
  readonly now: () => Date;
  readonly createDeliveryId: () => string;
  readonly secrets?: Pick<SecretStore, "references" | "resolve">;
  readonly health: HealthStatusService;
  readonly metrics: ErrorHubMetrics;
  readonly storageSafety: StorageSafetyState;
}

export function registerSystemRoutes(
  app: FastifyInstance,
  options: SystemRouteOptions,
): void {
  app.get("/api/system/status", async () => options.health.systemStatus());

  app.post<DeliveryParams>(
    "/api/webhook-deliveries/:id/retry",
    async (request, reply) => {
      const outboxId = positiveId(request.params.id, "delivery id");
      if (options.secrets === undefined)
        throw conflict("Webhook secrets are unavailable");
      const deliveryId = options.createDeliveryId();
      const requestedAt = canonicalNow(options.now);
      try {
        const redrive = new OutboxRepository(options.database).requestRedrive({
          outboxId,
          deliveryId,
          requestedAt,
          secrets: options.secrets,
        });
        return reply.code(202).send({
          id: redrive.id,
          deliveryId: redrive.deliveryId,
          originalOutboxId: redrive.originalOutboxId,
          state: redrive.state,
          attempts: redrive.attempts,
          requestedAt: redrive.requestedAt,
          attemptedAt: redrive.attemptedAt,
          lastError: redrive.lastError,
        });
      } catch (error) {
        if (error instanceof WebhookRedriveNotFoundError)
          throw notFound("Delivery not found");
        if (error instanceof WebhookRedriveConflictError)
          throw conflict("Delivery cannot be retried");
        throw error;
      }
    },
  );

  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return options.metrics.render({
      database: options.database,
      storage: options.storageSafety,
    });
  });
  app.get("/health/live", async () => options.health.liveness());
  app.get("/health/ready", async (_request, reply) => {
    const ready = options.health.readiness().ready;
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? "ready" : "not_ready" });
  });
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime()))
    throw new TypeError("private API clock must be valid");
  return value.toISOString();
}
