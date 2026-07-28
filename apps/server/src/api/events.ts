import type { FastifyInstance } from "fastify";
import type { ErrorHubDatabase } from "../storage/database.js";
import { positiveId } from "./query.js";
import { eventResponse, getEventByLocator } from "./read-model.js";

interface EventParams {
  readonly Params: { readonly id: string };
}

export function registerEventRoutes(
  app: FastifyInstance,
  database: ErrorHubDatabase,
): void {
  app.get<EventParams>("/api/events/:id", async (request) =>
    eventResponse(
      getEventByLocator(
        database,
        positiveId(request.params.id, "event locator"),
      ),
    ),
  );
}
