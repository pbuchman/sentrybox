import type { FastifyInstance } from "fastify";
import {
  issuePayload,
  resolveIssueContext,
  sentryNotFound,
  type SentryFacadeOptions,
} from "./model.js";

interface IssueParams {
  readonly Params: { readonly org: string; readonly issueId: string };
}

export function registerSentryIssueRoutes(
  app: FastifyInstance,
  options: SentryFacadeOptions,
): void {
  app.get<IssueParams>(
    "/api/0/organizations/:org/issues/:issueId/",
    async (request, reply) => {
      const context = resolveIssueContext(
        options,
        request.params.org,
        request.params.issueId,
      );
      return context === null
        ? sentryNotFound(reply)
        : issuePayload(options, context);
    },
  );
}
