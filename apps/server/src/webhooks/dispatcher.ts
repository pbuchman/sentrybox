import { randomUUID } from "node:crypto";
import type { SecretStore } from "../secrets.js";
import {
  OutboxRepository,
  type StoredOutboxRow,
} from "../storage/outbox-repository.js";
import { createSentryEventAlertHeaders } from "./payload.js";
import { classifyHttpStatus, nextRetryAt } from "./retry-policy.js";

export interface WebhookAttempt {
  readonly deliveryId: string;
  readonly body: Buffer;
  readonly targetUrl: URL;
  readonly secretRef: string;
  readonly attempt: number;
}

export type DeliveryResult = "delivered" | "retry" | "dead_letter";

export interface WebhookHttpRequest {
  readonly body: Buffer;
  readonly targetUrl: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface WebhookHttpClient {
  send(request: WebhookHttpRequest): Promise<{ readonly statusCode: number }>;
}

export interface WebhookDispatcherOptions {
  readonly outbox: OutboxRepository;
  readonly http: WebhookHttpClient;
  readonly secrets: Pick<SecretStore, "resolve">;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
  readonly leaseMs?: number;
  readonly batchSize?: number;
  readonly createLeaseId?: () => string;
}

export interface DispatchSummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
}

export class WebhookDispatcher {
  readonly #outbox: OutboxRepository;
  readonly #http: WebhookHttpClient;
  readonly #secrets: Pick<SecretStore, "resolve">;
  readonly #now: () => Date;
  readonly #requestTimeoutMs: number;
  readonly #leaseMs: number;
  readonly #batchSize: number;
  readonly #createLeaseId: () => string;

  public constructor(options: WebhookDispatcherOptions) {
    this.#outbox = options.outbox;
    this.#http = options.http;
    this.#secrets = options.secrets;
    this.#now = options.now ?? (() => new Date());
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 10_000,
      "request timeout",
    );
    this.#leaseMs = positiveInteger(
      options.leaseMs ?? 30_000,
      "lease duration",
    );
    if (this.#leaseMs <= this.#requestTimeoutMs) {
      throw new TypeError("lease duration must exceed request timeout");
    }
    this.#batchSize = positiveInteger(options.batchSize ?? 25, "batch size");
    this.#createLeaseId = options.createLeaseId ?? randomUUID;
  }

  public async dispatchDue(): Promise<DispatchSummary> {
    const claimedAt = canonicalDate(this.#now(), "dispatch timestamp");
    const leaseId = nonEmpty(this.#createLeaseId(), "lease id");
    const leaseUntil = new Date(
      claimedAt.getTime() + this.#leaseMs,
    ).toISOString();
    const rows = this.#outbox.claimDue(
      claimedAt.toISOString(),
      leaseUntil,
      leaseId,
      this.#batchSize,
    );
    const summary = {
      claimed: rows.length,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
    };
    const results = await Promise.all(
      rows.map(async (row) => this.deliver(row, leaseId)),
    );
    for (const result of results) {
      if (result === null) continue;
      if (result === "delivered") summary.delivered += 1;
      else if (result === "retry") summary.retried += 1;
      else summary.deadLettered += 1;
    }
    return summary;
  }

  private async deliver(
    row: StoredOutboxRow,
    leaseId: string,
  ): Promise<DeliveryResult | null> {
    if (
      row.destinationMode !== "live" ||
      row.targetUrl === null ||
      row.secretRef === null
    ) {
      return this.#outbox.completeDeadLetter(
        row.id,
        leaseId,
        "invalid destination configuration",
      )
        ? "dead_letter"
        : null;
    }
    const attemptNumber = row.attempts + 1;
    let result: DeliveryResult;
    let error: string;
    try {
      const attempt: WebhookAttempt = {
        deliveryId: row.deliveryId,
        body: Buffer.from(row.body),
        targetUrl: validatedTargetUrl(row.targetUrl),
        secretRef: row.secretRef,
        attempt: attemptNumber,
      };
      const secret = this.#secrets.resolve(attempt.secretRef);
      const response = await this.#http.send({
        body: attempt.body,
        targetUrl: attempt.targetUrl,
        headers: createSentryEventAlertHeaders({
          body: attempt.body,
          deliveryId: attempt.deliveryId,
          secret,
        }),
        timeoutMs: this.#requestTimeoutMs,
      });
      result = classifyHttpStatus(response.statusCode);
      error = `HTTP ${String(response.statusCode)}`;
    } catch (caught) {
      result = "retry";
      error =
        caught instanceof WebhookTimeoutError
          ? "request timeout"
          : "network failure";
    }
    const completedAt = canonicalDate(this.#now(), "completion timestamp");
    if (result === "delivered") {
      return this.#outbox.completeDelivered(
        row.id,
        leaseId,
        completedAt.toISOString(),
      )
        ? result
        : null;
    }
    if (result === "retry") {
      const retryAt = nextRetryAt(
        row.createdAt,
        completedAt.toISOString(),
        attemptNumber,
      );
      if (retryAt !== null) {
        return this.#outbox.completeRetry(row.id, leaseId, retryAt, error)
          ? result
          : null;
      }
    }
    return this.#outbox.completeDeadLetter(row.id, leaseId, error)
      ? "dead_letter"
      : null;
  }
}

export class WebhookTimeoutError extends Error {
  public constructor() {
    super("webhook request timed out");
    this.name = "WebhookTimeoutError";
  }
}

/** Production HTTP boundary; callers can inject a local fake in unit tests. */
export class FetchWebhookHttpClient implements WebhookHttpClient {
  public async send(
    request: WebhookHttpRequest,
  ): Promise<{ readonly statusCode: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.targetUrl, {
        method: "POST",
        headers: request.headers,
        body: new Uint8Array(request.body),
        redirect: "manual",
        signal: controller.signal,
      });
      const statusCode = response.status;
      try {
        await response.body?.cancel();
      } catch {
        // The delivery result depends only on the received status code.
      }
      return { statusCode };
    } catch (error) {
      if (controller.signal.aborted) throw new WebhookTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function validatedTargetUrl(value: string): URL {
  const target = new URL(value);
  if (
    target.protocol !== "https:" ||
    target.username.length > 0 ||
    target.password.length > 0
  ) {
    throw new TypeError("webhook target must use HTTPS without credentials");
  }
  return target;
}

function canonicalDate(value: Date, field: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`${field} must be valid`);
  }
  return new Date(value.getTime());
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonEmpty(value: string, field: string): string {
  if (value.length === 0) throw new TypeError(`${field} must not be empty`);
  return value;
}
