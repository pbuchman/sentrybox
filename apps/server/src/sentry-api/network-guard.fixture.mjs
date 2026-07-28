import { appendFileSync } from "node:fs";
import { Socket } from "node:net";
import process from "node:process";
import { URL } from "node:url";

const allowedEndpoint = process.env.ERROR_HUB_NETWORK_ALLOWED_ENDPOINT;
const reportPath = process.env.ERROR_HUB_NETWORK_REPORT_PATH;
if (allowedEndpoint === undefined || reportPath === undefined) {
  throw new Error("network guard configuration is missing");
}
const allowedUrl = new URL(`http://${allowedEndpoint}`);
const allowedHost = allowedUrl.hostname;
const allowedPort = Number(allowedUrl.port);
if (
  allowedUrl.protocol !== "http:" ||
  allowedHost !== "127.0.0.1" ||
  !Number.isSafeInteger(allowedPort) ||
  allowedPort < 1
) {
  throw new Error("network guard endpoint is invalid");
}

const forbiddenEnvironment = Object.keys(process.env).filter((name) =>
  /^(?:SENTRY_|DEFAULT_SENTRY_|MCP_(?:.*_)?(?:HOST|URL|TOKEN)$|AI_GATEWAY|OPENAI|ANTHROPIC|OPENROUTER|EMBEDDED_AGENT_PROVIDER|GOOGLE_GENERATIVE_AI|GEMINI|AZURE_OPENAI|COHERE|MISTRAL|GROQ|LANGFUSE|OTEL_|TELEMETRY_)/u.test(
    name,
  ),
);
if (forbiddenEnvironment.length > 0) {
  deny("environment", forbiddenEnvironment.sort().join(","));
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "object" && input !== null && "url" in input
      ? String(input.url)
      : String(input),
  );
  assertAllowed("fetch", url.hostname, effectivePort(url), url.toString());
  return originalFetch(input, init);
};

const originalSocketConnect = Socket.prototype.connect;
Socket.prototype.connect = function guardedConnect(...arguments_) {
  const endpoint = socketEndpoint(arguments_);
  assertAllowed("socket", endpoint.host, endpoint.port, endpoint.description);
  return Reflect.apply(originalSocketConnect, this, arguments_);
};

function socketEndpoint(arguments_) {
  const first = arguments_[0];
  if (Array.isArray(first)) return socketEndpoint(first);
  if (typeof first === "object" && first !== null) {
    const host = typeof first.host === "string" ? first.host : "localhost";
    return {
      host,
      port: Number(first.port),
      description: `${host}:${String(first.port)}`,
    };
  }
  const host = typeof arguments_[1] === "string" ? arguments_[1] : "localhost";
  return {
    host,
    port: Number(first),
    description: `${host}:${String(first)}`,
  };
}

function effectivePort(url) {
  if (url.port.length > 0) return Number(url.port);
  return url.protocol === "http:" ? 80 : url.protocol === "https:" ? 443 : 0;
}

function assertAllowed(kind, host, port, description) {
  if (host === allowedHost && port === allowedPort) return;
  deny(kind, description);
}

function deny(kind, target) {
  appendFileSync(reportPath, `${JSON.stringify({ kind, target })}\n`, "utf8");
  throw new Error(`network guard denied ${kind} ${target}`);
}
