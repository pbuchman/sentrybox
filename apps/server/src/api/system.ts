import type { FastifyInstance } from "fastify";
import type { SecretStore } from "../secrets.js";
import type { ErrorHubDatabase } from "../storage/database.js";
import { OutboxRepository } from "../storage/outbox-repository.js";
import { conflict, positiveId } from "./query.js";

interface DeliveryParams {
  readonly Params: { readonly id: string };
}

export interface SystemRouteOptions {
  readonly database: ErrorHubDatabase;
  readonly now: () => Date;
  readonly createDeliveryId: () => string;
  readonly secrets?: Pick<SecretStore, "references" | "resolve">;
  readonly isReady?: () => boolean;
  readonly getSystemStatus?: () => Readonly<Record<string, unknown>>;
  readonly getMetrics?: () => string;
}

export function registerSystemRoutes(
  app: FastifyInstance,
  options: SystemRouteOptions,
): void {
  app.get("/api/system/status", async () => ({
    ...baselineStatus(options.database),
    ...(options.getSystemStatus?.() ?? {}),
  }));

  app.post<DeliveryParams>(
    "/api/webhook-deliveries/:id/retry",
    async (request, reply) => {
      if (options.secrets === undefined)
        throw conflict("Webhook secrets are unavailable");
      try {
        const redrive = new OutboxRepository(options.database).requestRedrive({
          outboxId: positiveId(request.params.id, "delivery id"),
          deliveryId: options.createDeliveryId(),
          requestedAt: canonicalNow(options.now),
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
        throw conflict(
          error instanceof Error ? error.message : "Delivery cannot be retried",
        );
      }
    },
  );

  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return `${baselineMetrics(options.database)}${options.getMetrics?.() ?? ""}`;
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    const ready = databaseReady(options.database) && readyExtension(options);
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? "ready" : "not_ready" });
  });
}

function baselineStatus(database: ErrorHubDatabase) {
  const states = outboxStateCounts(database);
  return {
    status: "ok",
    database: { ready: databaseReady(database) },
    storage: {
      physicalBytes: null,
      logicalPayloadBytes: scalarCount(
        database,
        "SELECT COALESCE(SUM(compressed_payload_bytes), 0) AS count FROM events",
      ),
      budgetBytes: 5 * 1024 * 1024 * 1024,
      safety: "task_9_pending",
    },
    retention: { configured: false, lastRun: null },
    ingest: { accepting: true },
    outbox: {
      pending: states.pending ?? 0,
      retry: states.retry ?? 0,
      delivered: states.delivered ?? 0,
      deadLetter: states.dead_letter ?? 0,
      suppressed: states.suppressed ?? 0,
      redrivePending: scalarCount(
        database,
        "SELECT COUNT(*) AS count FROM webhook_redrives WHERE state = 'pending'",
      ),
    },
  };
}

function baselineMetrics(database: ErrorHubDatabase): string {
  const states = outboxStateCounts(database);
  const lines = [
    "# TYPE error_hub_issues gauge",
    `error_hub_issues ${String(scalarCount(database, "SELECT COUNT(*) AS count FROM issues"))}`,
    "# TYPE error_hub_events gauge",
    `error_hub_events ${String(scalarCount(database, "SELECT COUNT(*) AS count FROM events"))}`,
    "# TYPE error_hub_webhook_deliveries gauge",
  ];
  for (const state of [
    "pending",
    "retry",
    "delivered",
    "dead_letter",
    "suppressed",
  ] as const) {
    lines.push(
      `error_hub_webhook_deliveries{state="${state}"} ${String(states[state] ?? 0)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function outboxStateCounts(
  database: ErrorHubDatabase,
): Partial<Record<string, number>> {
  const rows = database
    .prepare(
      "SELECT state, COUNT(*) AS count FROM webhook_outbox GROUP BY state",
    )
    .all() as { state: string; count: number }[];
  return Object.fromEntries(rows.map((row) => [row.state, row.count]));
}

function scalarCount(database: ErrorHubDatabase, sql: string): number {
  return (database.prepare(sql).get() as { count: number }).count;
}

function databaseReady(database: ErrorHubDatabase): boolean {
  try {
    return (
      (database.prepare("SELECT 1 AS ready").get() as { ready: number })
        .ready === 1
    );
  } catch {
    return false;
  }
}

function readyExtension(options: SystemRouteOptions): boolean {
  try {
    return options.isReady?.() !== false;
  } catch {
    return false;
  }
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime()))
    throw new TypeError("private API clock must be valid");
  return value.toISOString();
}
