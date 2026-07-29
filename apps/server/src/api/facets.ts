import type { FastifyInstance } from "fastify";
import type { ErrorHubDatabase } from "../storage/database.js";
import { parseFilters } from "./query.js";
import { facetsForFilters } from "./read-model.js";

export function registerFacetRoutes(
  app: FastifyInstance,
  database: ErrorHubDatabase,
): void {
  app.get("/api/facets", async (request) =>
    facetsForFilters(database, parseFilters(request.query)),
  );
}
