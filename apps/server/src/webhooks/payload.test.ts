import { describe, expect, it } from "vitest";
import {
  createSentryEventAlertBody,
  createSentryEventAlertHeaders,
} from "./payload.js";

const BODY =
  '{"action":"triggered","data":{"event":{"event_id":"4f7a4f2c0e8e4c2a9c3d5e7f90123456","title":"TypeError: Cannot read properties of undefined","web_url":"https://error-hub.tail.example:8443/organizations/intexuraos/issues/1042/events/4f7a4f2c0e8e4c2a9c3d5e7f90123456/","issue":{"id":"1042","shortId":"INTEXURA-HUB-1042","title":"TypeError: Cannot read properties of undefined","permalink":"https://error-hub.tail.example:8443/organizations/intexuraos/issues/1042/","status":"unresolved","project":{"id":"1","slug":"intexuraos-backend"}},"project":{"id":"1","slug":"intexuraos-backend"}}}}';

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
        "965755f44f733a7f9df86b1c67d0712ccac5f0d897e633edf63d91e0120353b3",
      "X-Error-Hub-Delivery": "1be9b1ba-83ca-4df6-8644-71f93eadcf35",
    });
  });

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
