import { describe, expect, it } from "vitest";
import {
  createSentryEventAlertBody,
  createSentryEventAlertHeaders,
} from "./payload.js";

const BODY =
  '{"action":"triggered","data":{"event":{"event_id":"4f7a4f2c0e8e4c2a9c3d5e7f90123456","title":"TypeError: Cannot read properties of undefined","web_url":"https://error-hub.tail.example:8443/organizations/intexuraos/issues/1042/events/4f7a4f2c0e8e4c2a9c3d5e7f90123456/","environment":"prod","task_id":"task_review_3575a69848b633cd68c25a0688a6c6d1","dispatch_attempt_id":"8c6c6556-4c58-4aec-8d28-a51d5694e03c","trace_id":"7c5f9b88d035451ebea52ef9d653de7b","issue":{"id":"1042","shortId":"INTEXURA-HUB-1042","title":"TypeError: Cannot read properties of undefined","permalink":"https://error-hub.tail.example:8443/organizations/intexuraos/issues/1042/","status":"unresolved","project":{"id":"1","slug":"intexuraos-backend"}},"project":{"id":"1","slug":"intexuraos-backend"}}}}';

describe("Code Agent webhook payload", () => {
  it("matches the exact Sentry event_alert.triggered body and headers", () => {
    const body = createSentryEventAlertBody({
      privateHubOrigin: new URL("https://error-hub.tail.example:8443"),
      organizationSlug: "intexuraos",
      projectId: 1,
      projectSlug: "intexuraos-backend",
      issueId: 1042,
      eventId: "4f7a4f2c0e8e4c2a9c3d5e7f90123456",
      title: "TypeError: Cannot read properties of undefined",
      environment: "prod",
      taskId: "task_review_3575a69848b633cd68c25a0688a6c6d1",
      dispatchAttemptId: "8c6c6556-4c58-4aec-8d28-a51d5694e03c",
      traceId: "7c5f9b88d035451ebea52ef9d653de7b",
    });

    expect(body).toEqual(Buffer.from(BODY));
    expect(
      createSentryEventAlertHeaders({
        body,
        deliveryId: "1be9b1ba-83ca-4df6-8644-71f93eadcf35",
        secret: "webhook-secret",
      }),
    ).toEqual({
      "Content-Type": "application/json",
      "Sentry-Hook-Resource": "event_alert",
      "Sentry-Hook-Signature":
        "6e1ae3a3855b9b324d2a25d7b31c5a02689ae8215fa349b7a5f8dd22d9447c61",
      "X-Error-Hub-Delivery": "1be9b1ba-83ca-4df6-8644-71f93eadcf35",
    });
  });

  it("always signs the environment and omits unavailable optional correlation fields", () => {
    const body = createSentryEventAlertBody({
      privateHubOrigin: new URL("https://error-hub.tail.example:8443"),
      organizationSlug: "intexuraos",
      projectId: 1,
      projectSlug: "intexuraos-backend",
      issueId: 1042,
      eventId: "event-without-correlation",
      title: "Old normalized event",
      environment: "dev",
    });

    expect(JSON.parse(body.toString("utf8"))).toEqual({
      action: "triggered",
      data: {
        event: {
          event_id: "event-without-correlation",
          title: "Old normalized event",
          web_url:
            "https://error-hub.tail.example:8443/organizations/intexuraos/issues/1042/events/event-without-correlation/",
          environment: "dev",
          issue: {
            id: "1042",
            shortId: "INTEXURA-HUB-1042",
            title: "Old normalized event",
            permalink:
              "https://error-hub.tail.example:8443/organizations/intexuraos/issues/1042/",
            status: "unresolved",
            project: { id: "1", slug: "intexuraos-backend" },
          },
          project: { id: "1", slug: "intexuraos-backend" },
        },
      },
    });
  });

  it.each([undefined, null, "", " \t "])(
    "omits optional correlation fields when their value is %j",
    (value) => {
      const optionalFields =
        value === undefined
          ? {}
          : { taskId: value, dispatchAttemptId: value, traceId: value };
      const body = createSentryEventAlertBody({
        privateHubOrigin: new URL("https://error-hub.tail.example:8443"),
        organizationSlug: "intexuraos",
        projectId: 1,
        projectSlug: "intexuraos-backend",
        issueId: 1042,
        eventId: "event-with-empty-correlation",
        title: "Empty correlation",
        environment: "dev",
        ...optionalFields,
      });

      const event = JSON.parse(body.toString("utf8")).data.event;
      expect(event).not.toHaveProperty("task_id");
      expect(event).not.toHaveProperty("dispatch_attempt_id");
      expect(event).not.toHaveProperty("trace_id");
    },
  );

  it("rejects a base URL that is not a private HTTPS origin", () => {
    expect(() =>
      createSentryEventAlertBody({
        privateHubOrigin: new URL("http://error-hub.tail.example/path?q=1"),
        organizationSlug: "intexuraos",
        projectId: 1,
        projectSlug: "intexuraos-backend",
        issueId: 1042,
        eventId: "event",
        title: "failure",
        environment: "dev",
      }),
    ).toThrow(/HTTPS origin/u);
  });

  it("requires the stable delivery header identity to be a UUID", () => {
    expect(() =>
      createSentryEventAlertHeaders({
        body: Buffer.from("{}"),
        deliveryId: "delivery-1",
        secret: "webhook-secret",
      }),
    ).toThrow(/UUID/u);
  });
});
