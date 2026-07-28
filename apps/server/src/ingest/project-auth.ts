import type { FastifyRequest } from "fastify";
import type {
  ProjectRepository,
  VerifiedIngestKey,
} from "../storage/project-repository.js";

export function authenticateProject(
  request: FastifyRequest<{ Params: { projectId: string } }>,
  projects: ProjectRepository,
): VerifiedIngestKey | null {
  const projectId = Number(request.params.projectId);
  if (
    !/^[1-9]\d*$/u.test(request.params.projectId) ||
    !Number.isSafeInteger(projectId)
  ) {
    return null;
  }
  const url = new URL(request.raw.url ?? "", "http://error-hub.invalid");
  const queryKeys = url.searchParams.getAll("sentry_key");
  if (queryKeys.length > 1) {
    return null;
  }
  const queryKey = queryKeys[0] ?? null;
  const headerKey = readSentryAuthKey(request.headers["x-sentry-auth"]);
  if (queryKey !== null && headerKey !== null && queryKey !== headerKey) {
    return null;
  }
  const publicKey = queryKey ?? headerKey;
  if (publicKey === null || publicKey.length === 0) return null;
  const verified = projects.verifyIngestKey(projectId, publicKey);
  return verified?.enabled === true ? verified : null;
}

function readSentryAuthKey(
  value: string | string[] | undefined,
): string | null {
  const header = Array.isArray(value)
    ? value.length === 1
      ? value[0]
      : undefined
    : value;
  if (header === undefined) return null;
  const match = /^Sentry\s+(.+)$/iu.exec(header.trim());
  if (match === null) return null;
  let key: string | null = null;
  for (const part of (match[1] ?? "").split(",")) {
    const equals = part.indexOf("=");
    if (equals === -1) continue;
    const name = part.slice(0, equals).trim().toLowerCase();
    if (name !== "sentry_key") continue;
    if (key !== null) return null;
    try {
      key = decodeURIComponent(part.slice(equals + 1).trim());
    } catch {
      return null;
    }
  }
  return key;
}
