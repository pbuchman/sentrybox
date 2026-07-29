import { lstat, open, realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface StaticUiOptions {
  readonly root: string;
}

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".woff2", "font/woff2"],
]);

const ISSUE_PERMALINK = /^\/organizations\/intexuraos\/issues\/[1-9]\d*\/$/u;
const EVENT_PERMALINK =
  /^\/organizations\/intexuraos\/issues\/[1-9]\d*\/events\/[^/]+\/$/u;

export function registerStaticUi(
  app: FastifyInstance,
  options: StaticUiOptions,
): void {
  const configuredRoot = resolve(options.root);
  app.route({
    method: ["GET", "HEAD"],
    url: "/*",
    async handler(request, reply) {
      const pathname = decodedPathname(request);
      if (pathname === null || excludedSurface(pathname)) {
        return reply.callNotFound();
      }
      if (
        pathname === "/" ||
        ISSUE_PERMALINK.test(pathname) ||
        EVENT_PERMALINK.test(pathname)
      ) {
        return sendFile(request, reply, configuredRoot, "index.html", true);
      }
      const relativePath = staticAssetPath(pathname);
      if (relativePath === null) return reply.callNotFound();
      return sendFile(request, reply, configuredRoot, relativePath, false);
    },
  });
}

function decodedPathname(request: FastifyRequest): string | null {
  try {
    return decodeURIComponent(
      new URL(request.raw.url ?? "", "http://sentrybox.invalid").pathname,
    );
  } catch {
    return null;
  }
}

function excludedSurface(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/metrics" ||
    pathname.startsWith("/metrics/") ||
    pathname === "/health" ||
    pathname.startsWith("/health/")
  );
}

function staticAssetPath(pathname: string): string | null {
  if (!pathname.startsWith("/assets/") && !pathname.startsWith("/fonts/")) {
    return null;
  }
  if (pathname.includes("\\") || pathname.includes("\0")) return null;
  const segments = pathname.slice(1).split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  const relativePath = segments.join("/");
  return CONTENT_TYPES.has(extname(relativePath).toLowerCase())
    ? relativePath
    : null;
}

async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  root: string,
  relativePath: string,
  html: boolean,
) {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const canonicalRoot = await realpath(root);
    const candidate = resolve(canonicalRoot, relativePath);
    const canonicalFile = await realpath(candidate);
    const location = relative(canonicalRoot, canonicalFile);
    if (
      location.length === 0 ||
      location === ".." ||
      location.startsWith(`..${sep}`) ||
      location.startsWith(sep)
    ) {
      return reply.callNotFound();
    }
    const fileStatus = await lstat(canonicalFile);
    if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) {
      return reply.callNotFound();
    }
    const contentType = html
      ? "text/html; charset=utf-8"
      : CONTENT_TYPES.get(extname(canonicalFile).toLowerCase());
    if (contentType === undefined) return reply.callNotFound();
    handle = await open(canonicalFile, "r");
    const status = await handle.stat();
    reply.header("Content-Type", contentType);
    reply.header("Content-Length", String(status.size));
    reply.header("X-Content-Type-Options", "nosniff");
    if (request.method === "HEAD") {
      await handle.close();
      handle = null;
      return reply.send();
    }
    const stream = handle.createReadStream({ autoClose: true });
    handle = null;
    return reply.send(stream);
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (isMissingFile(error)) return reply.callNotFound();
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
