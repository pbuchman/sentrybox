import type { FastifyInstance, FastifyRequest } from "fastify";
import { PrivateApiError } from "./query.js";

export interface PrivateRequestGuardOptions {
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly publicIngestHosts: readonly string[];
}

export function installPrivateRequestGuard(
  app: FastifyInstance,
  options: PrivateRequestGuardOptions,
): void {
  const allowedHosts = normalizedSet(
    options.allowedHosts,
    "allowed private Host",
  );
  const allowedOrigins = new Set(options.allowedOrigins.map(canonicalOrigin));
  const publicHosts = normalizedSet(
    options.publicIngestHosts,
    "public ingest Host",
    true,
  );
  for (const host of allowedHosts) {
    if (publicHosts.has(host)) {
      throw new TypeError("private and public ingest Hosts must be disjoint");
    }
  }
  app.addHook("onRequest", async (request) => {
    const host = headerValue(request.headers.host);
    if (
      host === undefined ||
      publicHosts.has(host) ||
      !allowedHosts.has(host)
    ) {
      throw new PrivateApiError(
        403,
        "private_host_required",
        "Private Host is not allowed",
      );
    }
    const origin = headerValue(request.headers.origin);
    if (
      origin !== undefined &&
      !allowedOrigins.has(canonicalOriginSafely(origin))
    ) {
      throw new PrivateApiError(
        403,
        "private_origin_required",
        "Origin is not allowed",
      );
    }
    if (!isProtectedMutation(request)) return;
    if (origin === undefined) {
      throw new PrivateApiError(
        403,
        "private_origin_required",
        "Origin is not allowed",
      );
    }
    const contentType = headerValue(request.headers["content-type"]);
    if (
      contentType === undefined ||
      !/^application\/json(?:\s*;|$)/iu.test(contentType)
    ) {
      throw new PrivateApiError(
        415,
        "json_required",
        "Mutation requests require application/json",
      );
    }
  });
}

function isProtectedMutation(request: FastifyRequest): boolean {
  if (
    request.method === "DELETE" &&
    /^\/api\/issues\/[^/]+\/?(?:\?.*)?$/u.test(request.raw.url ?? "")
  )
    return true;
  if (request.method !== "POST") return false;
  return (
    /^\/api\/issues\/[^/]+\/(?:resolve|reopen)\/?(?:\?.*)?$/u.test(
      request.raw.url ?? "",
    ) ||
    /^\/api\/webhook-deliveries\/[^/]+\/retry\/?(?:\?.*)?$/u.test(
      request.raw.url ?? "",
    )
  );
}

function normalizedSet(
  values: readonly string[],
  field: string,
  allowEmpty = false,
): Set<string> {
  if (!allowEmpty && values.length === 0)
    throw new TypeError(`${field} list must not be empty`);
  const result = new Set<string>();
  for (const value of values) {
    const canonical = value.trim();
    if (
      canonical.length === 0 ||
      canonical.includes("/") ||
      canonical.includes("@")
    ) {
      throw new TypeError(`${field} is invalid`);
    }
    result.add(canonical);
  }
  return result;
}

function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError("allowed Origin must be an origin URL");
  }
  if (value !== url.origin) {
    throw new TypeError("allowed Origin must use canonical origin syntax");
  }
  return url.origin;
}

function canonicalOriginSafely(value: string): string {
  try {
    return canonicalOrigin(value);
  } catch {
    return "invalid:";
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
