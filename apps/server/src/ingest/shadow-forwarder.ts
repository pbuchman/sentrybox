import type { VerifiedIngestKey } from "../storage/project-repository.js";

export interface ShadowForwardRequest {
  readonly ingestKey: VerifiedIngestKey;
  readonly eventEnvironment: string;
  readonly envelope: Buffer;
  readonly contentEncoding: string | undefined;
  readonly sentryClient: string | null;
}

export type ShadowEnqueueResult =
  | "disabled"
  | "queued"
  | "saturated"
  | "environment_mismatch"
  | "invalid_target";

export interface ShadowForwarder {
  enqueue(request: ShadowForwardRequest): ShadowEnqueueResult;
}

export interface ShadowHttpRequest {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface ShadowHttpResponse {
  readonly statusCode: number;
}

export type ShadowForwardMetric =
  | {
      readonly outcome:
        | "disabled"
        | "saturated"
        | "environment_mismatch"
        | "invalid_target";
      readonly environment: string;
    }
  | {
      readonly outcome: "success" | "failure";
      readonly environment: string;
      readonly durationMs: number;
      readonly statusCode: number | null;
    };

export interface CreateShadowForwarderOptions {
  readonly secretResolver: {
    resolve(reference: string): string;
  };
  readonly send?: (request: ShadowHttpRequest) => Promise<ShadowHttpResponse>;
  readonly onMetric?: (metric: ShadowForwardMetric) => void;
  readonly queueCapacity: number;
  readonly concurrency: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

interface PendingForward {
  readonly target: URL;
  readonly environment: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly envelope: Buffer;
}

export function createShadowForwarder(
  options: CreateShadowForwarderOptions,
): ShadowForwarder {
  return new BoundedShadowForwarder(options);
}

class BoundedShadowForwarder implements ShadowForwarder {
  readonly #pending: PendingForward[] = [];
  readonly #send: (request: ShadowHttpRequest) => Promise<ShadowHttpResponse>;
  readonly #now: () => number;
  #active = 0;
  #pumpScheduled = false;

  public constructor(private readonly options: CreateShadowForwarderOptions) {
    assertPositiveInteger(options.queueCapacity, "shadow queue capacity");
    assertPositiveInteger(options.concurrency, "shadow concurrency");
    const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    assertPositiveInteger(requestTimeoutMs, "shadow request timeout");
    this.#send =
      options.send ??
      ((request) => sendShadowRequest(request, requestTimeoutMs));
    this.#now = options.now ?? (() => Date.now());
  }

  public enqueue(request: ShadowForwardRequest): ShadowEnqueueResult {
    const environment = request.ingestKey.environment;
    if (request.ingestKey.forwardingMode === "disabled") {
      this.emit({ outcome: "disabled", environment });
      return "disabled";
    }
    if (request.eventEnvironment !== environment) {
      this.emit({ outcome: "environment_mismatch", environment });
      return "environment_mismatch";
    }
    const reference = request.ingestKey.forwardingSecretRef;
    if (reference === null) {
      this.emit({ outcome: "invalid_target", environment });
      return "invalid_target";
    }

    let target: URL;
    try {
      target = buildLegacyEnvelopeTarget(
        this.options.secretResolver.resolve(reference),
        request.sentryClient,
      );
    } catch {
      this.emit({ outcome: "invalid_target", environment });
      return "invalid_target";
    }

    if (this.#active + this.#pending.length >= this.options.queueCapacity) {
      this.emit({ outcome: "saturated", environment });
      return "saturated";
    }

    const headers: Record<string, string> = {
      "content-type": "application/x-sentry-envelope",
    };
    if (
      request.contentEncoding !== undefined &&
      request.contentEncoding.length > 0
    ) {
      headers["content-encoding"] = request.contentEncoding;
    }
    this.#pending.push({
      target,
      environment,
      headers,
      envelope: Buffer.from(request.envelope),
    });
    this.schedulePump();
    return "queued";
  }

  private schedulePump(): void {
    if (this.#pumpScheduled) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (
      this.#active < this.options.concurrency &&
      this.#pending.length > 0
    ) {
      const next = this.#pending.shift();
      if (next === undefined) break;
      this.#active += 1;
      void this.forward(next);
    }
  }

  private async forward(pending: PendingForward): Promise<void> {
    const startedAt = this.#now();
    let statusCode: number | null = null;
    let succeeded = false;
    try {
      const response = await this.#send({
        url: new URL(pending.target.href),
        headers: pending.headers,
        body: Buffer.from(pending.envelope),
      });
      statusCode = response.statusCode;
      succeeded = statusCode >= 200 && statusCode < 300;
    } catch {
      succeeded = false;
    } finally {
      this.emit({
        outcome: succeeded ? "success" : "failure",
        environment: pending.environment,
        durationMs: Math.max(0, this.#now() - startedAt),
        statusCode,
      });
      this.#active -= 1;
      this.pump();
    }
  }

  private emit(metric: ShadowForwardMetric): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Metrics must never influence the SDK response or forwarding queue.
    }
  }
}

function buildLegacyEnvelopeTarget(
  dsn: string,
  sentryClient: string | null,
): URL {
  const parsed = new URL(dsn);
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length === 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("invalid legacy DSN");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (
    projectId === undefined ||
    !/^[1-9]\d*$/u.test(projectId) ||
    !Number.isSafeInteger(Number(projectId))
  ) {
    throw new Error("invalid legacy DSN");
  }
  const publicKey = decodeUrlCredential(parsed.username);
  const secret =
    parsed.password.length === 0 ? null : decodeUrlCredential(parsed.password);
  if (publicKey.length === 0) {
    throw new Error("invalid legacy DSN");
  }

  const target = new URL(parsed.origin);
  const prefix = segments.length === 0 ? "" : `/${segments.join("/")}`;
  target.pathname = `${prefix}/api/${projectId}/envelope/`;
  target.searchParams.set("sentry_version", "7");
  target.searchParams.set("sentry_key", publicKey);
  if (secret !== null) {
    target.searchParams.set("sentry_secret", secret);
  }
  const client = boundedSentryClient(sentryClient);
  if (client !== null) {
    target.searchParams.set("sentry_client", client);
  }
  return target;
}

function boundedSentryClient(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  const normalized = value.replace(/[\r\n]/gu, "").slice(0, 200);
  return normalized.length === 0 ? null : normalized;
}

function decodeUrlCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("invalid legacy DSN");
  }
}

async function sendShadowRequest(
  request: ShadowHttpRequest,
  timeoutMs: number,
): Promise<ShadowHttpResponse> {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { statusCode: response.status };
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}
