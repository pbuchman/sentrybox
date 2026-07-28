import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { SecretStore } from "./secrets.js";
import type { ErrorHubDatabase } from "./storage/database.js";
import { registerEventRoutes } from "./api/events.js";
import { registerExportRoutes } from "./api/exports.js";
import { registerFacetRoutes } from "./api/facets.js";
import { registerIssueRoutes } from "./api/issues.js";
import { installPrivateRequestGuard } from "./api/private-request-guard.js";
import { PrivateApiError } from "./api/query.js";
import { registerSystemRoutes } from "./api/system.js";
import { registerSentryEventRoutes } from "./sentry-api/events.js";
import { registerSentryIssueRoutes } from "./sentry-api/issues.js";
import { registerSentryProjectRoutes } from "./sentry-api/projects.js";
import { sentryNotFound } from "./sentry-api/model.js";
import { HealthStatusService } from "./health/status.js";
import type { OperationsContext } from "./operations.js";

export interface PrivateAppOptions {
  readonly database: ErrorHubDatabase;
  readonly operations: OperationsContext;
  readonly privateOrigin: URL;
  readonly organizationSlug: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly publicIngestHosts: readonly string[];
  readonly grafanaExploreUrl?: URL | null;
  readonly secrets?: Pick<SecretStore, "references" | "resolve">;
  readonly now?: () => Date;
  readonly createDeliveryId?: () => string;
  readonly exportBatchSize?: number;
  readonly onExportBatch?: (size: number) => void;
}

export function createPrivateApp(options: PrivateAppOptions): FastifyInstance {
  validatePrivateOrigin(options.privateOrigin);
  validateOrganizationSlug(options.organizationSlug);
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    exposeHeadRoutes: false,
  });
  installPrivateRequestGuard(app, options);
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof PrivateApiError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    const errorRecord =
      typeof error === "object" && error !== null
        ? (error as { statusCode?: unknown; message?: unknown })
        : {};
    const statusCode =
      typeof errorRecord.statusCode === "number" ? errorRecord.statusCode : 500;
    return reply.code(statusCode).send({
      error: {
        code: statusCode === 404 ? "not_found" : "internal_error",
        message:
          statusCode >= 500
            ? "Internal server error"
            : typeof errorRecord.message === "string"
              ? errorRecord.message
              : "Request failed",
      },
    });
  });
  const now = options.now ?? (() => new Date());
  const health = new HealthStatusService({
    database: options.database,
    safetyState: options.operations.storageSafety,
  });
  registerIssueRoutes(app, { database: options.database, now });
  registerEventRoutes(app, options.database, options.grafanaExploreUrl ?? null);
  registerFacetRoutes(app, options.database);
  registerExportRoutes(app, {
    database: options.database,
    ...(options.exportBatchSize === undefined
      ? {}
      : { batchSize: options.exportBatchSize }),
    ...(options.onExportBatch === undefined
      ? {}
      : { onBatch: options.onExportBatch }),
  });
  registerSystemRoutes(app, {
    database: options.database,
    now,
    createDeliveryId: options.createDeliveryId ?? randomUUID,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    health,
    metrics: options.operations.metrics,
    storageSafety: options.operations.storageSafety,
  });
  const sentryOptions = {
    database: options.database,
    privateOrigin: new URL(options.privateOrigin.origin),
    organizationSlug: options.organizationSlug,
    now,
  };
  registerSentryIssueRoutes(app, sentryOptions);
  registerSentryEventRoutes(app, sentryOptions);
  registerSentryProjectRoutes(app, sentryOptions);
  app.all("/api/0", async (_request, reply) => sentryNotFound(reply));
  app.all("/api/0/*", async (_request, reply) => sentryNotFound(reply));
  return app;
}

function validatePrivateOrigin(value: URL): void {
  if (
    value.protocol !== "https:" ||
    value.username.length > 0 ||
    value.password.length > 0 ||
    value.pathname !== "/" ||
    value.search.length > 0 ||
    value.hash.length > 0
  ) {
    throw new TypeError("private origin must be an HTTPS origin");
  }
}

function validateOrganizationSlug(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(value))
    throw new TypeError("organization slug is invalid");
}
