import { describe, expect, it } from "vitest";
import type { NormalizedEventInput } from "@intexura-error-hub/protocol";
import { fingerprintEvent, scopedIssueKey } from "./index.js";

function exceptionEvent(
  changes: Partial<NormalizedEventInput> = {},
): NormalizedEventInput {
  return {
    environment: "production",
    release: "abc123",
    server_name: "api",
    exception: {
      values: [
        {
          type: "TypeError",
          value: "Cannot read properties of undefined",
          stacktrace: {
            frames: [
              {
                in_app: true,
                module: "billing.invoice",
                filename: "/srv/build-abc/src/invoice.ts?build=abc123",
                function: "createInvoice",
                lineno: 42,
                colno: 9,
              },
            ],
          },
        },
      ],
    },
    ...changes,
  };
}

describe("fingerprintEvent", () => {
  it("uses ordered non-default explicit fingerprints without exposing their values", () => {
    const first = fingerprintEvent(
      exceptionEvent({ fingerprint: ["tenant-7", "workflow:invoice"] }),
    );
    const same = fingerprintEvent(
      exceptionEvent({
        release: "def456",
        environment: "development",
        fingerprint: ["tenant-7", "workflow:invoice"],
      }),
    );
    const reordered = fingerprintEvent(
      exceptionEvent({ fingerprint: ["workflow:invoice", "tenant-7"] }),
    );

    expect(first.digest).toBe(same.digest);
    expect(reordered.digest).not.toBe(first.digest);
    expect(first.explanation).toContain("explicit fingerprint values");
    expect(first.explanation.join(" ")).not.toContain("tenant-7");
  });

  it("treats the SDK default fingerprint sentinel as the normal exception strategy", () => {
    const implicit = fingerprintEvent(exceptionEvent());
    const sdkDefault = fingerprintEvent(
      exceptionEvent({ fingerprint: ["{{ default }}"] }),
    );

    expect(sdkDefault.digest).toBe(implicit.digest);
    expect(sdkDefault.explanation).toContain("exception type");
  });

  it("keeps identical exceptions together across releases and environments", () => {
    const production = fingerprintEvent(exceptionEvent());
    const development = fingerprintEvent(
      exceptionEvent({ environment: "development", release: "next-build" }),
    );

    expect(production.digest).toBe(development.digest);
  });

  it("ignores line and column changes in application frames", () => {
    const original = fingerprintEvent(exceptionEvent());
    const moved = fingerprintEvent(
      exceptionEvent({
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Cannot read properties of undefined",
              stacktrace: {
                frames: [
                  {
                    in_app: true,
                    module: "billing.invoice",
                    filename: "/different/root/src/invoice.ts?build=def456",
                    function: "createInvoice",
                    lineno: 900,
                    colno: 1,
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(moved.digest).toBe(original.digest);
  });

  it("excludes vendor frames, including vendor-only stacks", () => {
    const vendorOnlyOne = fingerprintEvent(
      exceptionEvent({
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Cannot read properties of undefined",
              stacktrace: {
                frames: [
                  {
                    in_app: false,
                    module: "node_modules.alpha",
                    filename: "/srv/node_modules/alpha/index.js",
                    function: "internalOne",
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const vendorOnlyTwo = fingerprintEvent(
      exceptionEvent({
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Cannot read properties of undefined",
              stacktrace: {
                frames: [
                  {
                    in_app: false,
                    module: "node_modules.beta",
                    filename: "/srv/node_modules/beta/index.js",
                    function: "internalTwo",
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(vendorOnlyOne.digest).toBe(vendorOnlyTwo.digest);
  });

  it("normalizes volatile warning-template identifiers while preserving semantic numbers", () => {
    const first = fingerprintEvent({
      logger: "worker",
      server_name: "api",
      message:
        "job 101 failed at 2026-07-28T10:11:12Z for 550e8400-e29b-41d4-a716-446655440000 sha abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    });
    const second = fingerprintEvent({
      logger: "worker",
      server_name: "api",
      message:
        "job 202 failed at 2027-01-02T03:04:05Z for 123e4567-e89b-12d3-a456-426614174000 sha 0123456789abcdef0123456789abcdef01234567",
    });
    const differentStatus = fingerprintEvent({
      logger: "worker",
      server_name: "api",
      message: "HTTP 500 after 3 retry attempts",
    });
    const originalStatus = fingerprintEvent({
      logger: "worker",
      server_name: "api",
      message: "HTTP 404 after 3 retry attempts",
    });

    expect(first.digest).toBe(second.digest);
    expect(differentStatus.digest).not.toBe(originalStatus.digest);
  });

  it("keeps scoped issue keys separate across trusted projects", () => {
    const event = exceptionEvent();
    const firstProject = scopedIssueKey({ projectId: 7, event });
    const secondProject = scopedIssueKey({ projectId: 8, event });

    expect(firstProject.fingerprint).toBe(secondProject.fingerprint);
    expect(firstProject).not.toEqual(secondProject);
  });
});
