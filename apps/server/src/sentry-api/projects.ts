import type { FastifyInstance } from "fastify";
import { sentryNotFound, type SentryFacadeOptions } from "./model.js";

interface ProjectParams {
  readonly Params: { readonly org: string; readonly project: string };
}

export function registerSentryProjectRoutes(
  app: FastifyInstance,
  options: SentryFacadeOptions,
): void {
  app.get<ProjectParams>(
    "/api/0/projects/:org/:project/",
    async (request, reply) => {
      if (request.params.org !== options.organizationSlug)
        return sentryNotFound(reply);
      const row = options.database
        .prepare(
          `SELECT id, slug, name FROM projects
           WHERE slug = ? OR CAST(id AS TEXT) = ?
           ORDER BY id LIMIT 1`,
        )
        .get(request.params.project, request.params.project) as
        | { id: number; slug: string; name: string }
        | undefined;
      return row === undefined
        ? sentryNotFound(reply)
        : {
            id: String(row.id),
            slug: row.slug,
            name: row.name,
            platform: "node",
          };
    },
  );
}
