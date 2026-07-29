import type { FastifyInstance } from "fastify";
import type { ErrorHubDatabase } from "../storage/database.js";
import { IssueRepository } from "../storage/issue-repository.js";
import {
  decodeCursor,
  notFound,
  optionalQueryValue,
  parseFilters,
  parsePageLimit,
  positiveId,
} from "./query.js";
import {
  facetsForFilters,
  getIssueDetail,
  listIssueEvents,
  listIssues,
} from "./read-model.js";

interface IssueParams {
  readonly Params: { readonly id: string };
}

export function registerIssueRoutes(
  app: FastifyInstance,
  options: { readonly database: ErrorHubDatabase; readonly now: () => Date },
): void {
  app.get("/api/issues", async (request) => {
    const filters = parseFilters(request.query);
    const page = listIssues(
      options.database,
      filters,
      parsePageLimit(request.query),
      decodeCursor(optionalQueryValue(request.query, "cursor"), "number"),
    );
    return { ...page, facets: facetsForFilters(options.database, filters) };
  });

  app.get<IssueParams>("/api/issues/:id", async (request) =>
    getIssueDetail(options.database, positiveId(request.params.id, "issue id")),
  );

  app.get<IssueParams>("/api/issues/:id/events", async (request) =>
    listIssueEvents(
      options.database,
      positiveId(request.params.id, "issue id"),
      parsePageLimit(request.query),
      decodeCursor(optionalQueryValue(request.query, "cursor"), "string"),
    ),
  );

  app.post<IssueParams>("/api/issues/:id/resolve", async (request) => {
    const id = positiveId(request.params.id, "issue id");
    const issue = new IssueRepository(options.database).resolve(
      id,
      canonicalNow(options.now),
    );
    if (issue === null) throw notFound("Issue not found");
    return getIssueDetail(options.database, id);
  });

  app.post<IssueParams>("/api/issues/:id/reopen", async (request) => {
    const id = positiveId(request.params.id, "issue id");
    const issue = new IssueRepository(options.database).reopen(
      id,
      canonicalNow(options.now),
    );
    if (issue === null) throw notFound("Issue not found");
    return getIssueDetail(options.database, id);
  });

  app.delete<IssueParams>("/api/issues/:id", async (request, reply) => {
    const deleted = new IssueRepository(options.database).delete(
      positiveId(request.params.id, "issue id"),
    );
    if (!deleted)
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "Issue not found" } });
    return reply.code(204).send();
  });
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime()))
    throw new TypeError("private API clock must be valid");
  return value.toISOString();
}
