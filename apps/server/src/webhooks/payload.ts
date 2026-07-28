import type { NormalizedEvent } from "@intexura-error-hub/protocol";
import type { BuildOutboxInput } from "../public-app.js";
import type { SecretStore } from "../secrets.js";
import type { OutboxDraft } from "../storage/outbox-repository.js";
import { signWebhookBody } from "./signature.js";
import { validateWebhookDestination } from "./destination.js";

export interface SentryEventAlertInput {
  readonly privateHubOrigin: URL;
  readonly organizationSlug: string;
  readonly projectId: number;
  readonly projectSlug: string;
  readonly issueId: number;
  readonly eventId: string;
  readonly title: string;
}

export interface SentryEventAlertHeadersInput {
  readonly body: Buffer;
  readonly deliveryId: string;
  readonly secret: string;
}

export interface StoredSentryEventAlertHeadersInput {
  readonly deliveryId: string;
  readonly signature: string;
}

export interface BuildCodeAgentOutboxDraftInput extends BuildOutboxInput {
  readonly privateHubOrigin: URL;
  readonly organizationSlug: string;
  readonly deliveryId: string;
  readonly secrets: Pick<SecretStore, "references" | "resolve">;
}

export type SentryEventAlertHeaders = Readonly<{
  "Content-Type": "application/json";
  "Sentry-Hook-Resource": "event_alert";
  "Sentry-Hook-Signature": string;
  "X-Error-Hub-Delivery": string;
}>;

export function createSentryEventAlertBody(
  input: SentryEventAlertInput,
): Buffer {
  const origin = validatedPrivateOrigin(input.privateHubOrigin);
  const organization = validatedSlug(
    input.organizationSlug,
    "organization slug",
  );
  const projectSlug = validatedSlug(input.projectSlug, "project slug");
  const projectId = positiveInteger(input.projectId, "project id");
  const issueId = positiveInteger(input.issueId, "issue id");
  const eventId = nonEmpty(input.eventId, "event id");
  const title = nonEmpty(input.title, "event title");
  const issuePath = `/organizations/${organization}/issues/${String(issueId)}/`;
  const issueUrl = new URL(issuePath, origin).toString();
  const eventUrl = new URL(
    `${issuePath}events/${encodeURIComponent(eventId)}/`,
    origin,
  ).toString();
  const project = { id: String(projectId), slug: projectSlug };
  const payload = {
    action: "triggered",
    data: {
      event: {
        event_id: eventId,
        title,
        web_url: eventUrl,
        issue: {
          id: String(issueId),
          shortId: `INTEXURA-HUB-${String(issueId)}`,
          title,
          permalink: issueUrl,
          status: "unresolved",
          project,
        },
        project,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload), "utf8");
}

export function createSentryEventAlertHeaders(
  input: SentryEventAlertHeadersInput,
): SentryEventAlertHeaders {
  return createStoredSentryEventAlertHeaders({
    deliveryId: input.deliveryId,
    signature: signWebhookBody(input.body, input.secret),
  });
}

export function createStoredSentryEventAlertHeaders(
  input: StoredSentryEventAlertHeadersInput,
): SentryEventAlertHeaders {
  if (!/^[0-9a-f]{64}$/u.test(input.signature)) {
    throw new TypeError("stored webhook signature must be lowercase SHA-256");
  }
  return {
    "Content-Type": "application/json",
    "Sentry-Hook-Resource": "event_alert",
    "Sentry-Hook-Signature": input.signature,
    "X-Error-Hub-Delivery": deliveryUuid(input.deliveryId),
  };
}

/** Builds the immutable bytes persisted by IssueRepository in its transaction. */
export function buildCodeAgentOutboxDraft(
  input: BuildCodeAgentOutboxDraftInput,
): OutboxDraft {
  const body = createSentryEventAlertBody({
    privateHubOrigin: input.privateHubOrigin,
    organizationSlug: input.organizationSlug,
    projectId: input.transition.projectId,
    projectSlug: input.destination.projectSlug,
    issueId: input.transition.issueId,
    eventId: input.transition.eventId,
    title: eventTitle(input.event),
  });
  const deliveryId = deliveryUuid(input.deliveryId);
  if (input.destination.mode === "disabled") {
    return {
      deliveryId,
      mode: "disabled",
      targetUrl: null,
      secretRef: null,
      signature: null,
      body,
    };
  }
  const destination = validateWebhookDestination(
    input.destination.targetUrl,
    input.destination.secretRef,
    input.secrets,
  );
  return {
    deliveryId,
    mode: "live",
    targetUrl: destination.targetUrl,
    secretRef: destination.secretRef,
    signature: signWebhookBody(
      body,
      input.secrets.resolve(destination.secretRef),
    ),
    body,
  };
}

function eventTitle(event: NormalizedEvent): string {
  return nonEmpty(event.title, "event title");
}

function validatedPrivateOrigin(input: URL): URL {
  if (
    input.protocol !== "https:" ||
    input.username.length > 0 ||
    input.password.length > 0 ||
    input.pathname !== "/" ||
    input.search.length > 0 ||
    input.hash.length > 0
  ) {
    throw new TypeError("private Hub URL must be an HTTPS origin");
  }
  return new URL(input.origin);
}

function validatedSlug(value: string, field: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
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

function deliveryUuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError("delivery id must be a UUID");
  }
  return value.toLowerCase();
}
