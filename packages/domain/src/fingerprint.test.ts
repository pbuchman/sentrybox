import { describe, expect, it } from "vitest";
import type { NormalizedEventInput } from "@intexura-error-hub/protocol";
import {
  fingerprintEvent,
  normalizeMessageTemplate,
  scopedIssueKey,
} from "./index.js";

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

  it("hashes only meaningful non-default explicit fingerprint values", () => {
    const mixed = fingerprintEvent(
      exceptionEvent({
        fingerprint: ["{{ default }}", " ", "tenant-7", "workflow:invoice"],
      }),
    );
    const meaningful = fingerprintEvent(
      exceptionEvent({ fingerprint: ["tenant-7", "workflow:invoice"] }),
    );

    expect(mixed.digest).toBe(meaningful.digest);
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

  it("keeps unmarked application frames while excluding known vendor paths", () => {
    const withoutFrames = fingerprintEvent(
      exceptionEvent({
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Cannot read properties of undefined",
              stacktrace: { frames: [] },
            },
          ],
        },
      }),
    );
    const unmarkedApplication = fingerprintEvent(
      exceptionEvent({
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Cannot read properties of undefined",
              stacktrace: {
                frames: [
                  {
                    module: "billing.invoice",
                    filename: "/srv/build/src/billing/invoice.ts",
                    function: "createInvoice",
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const mislabeledVendor = fingerprintEvent(
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
                    filename: "/srv/node_modules/library/index.js",
                    function: "createInvoice",
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(unmarkedApplication.digest).not.toBe(withoutFrames.digest);
    expect(mislabeledVendor.digest).toBe(withoutFrames.digest);
  });

  it("preserves stable directories when stripping volatile absolute build roots", () => {
    const payments = fingerprintEvent(
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
                    module: "application.index",
                    filename: "/srv/build-a/src/payments/index.ts",
                    function: "run",
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const orders = fingerprintEvent(
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
                    module: "application.index",
                    filename: "/srv/build-b/src/orders/index.ts",
                    function: "run",
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(payments.digest).not.toBe(orders.digest);
  });

  it("normalizes the same source file across absolute build roots", () => {
    const appRoot = fingerprintEvent(
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
                    module: "application.index",
                    filename: "/app/src/orders/index.ts",
                    function: "run",
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const srvRoot = fingerprintEvent(
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
                    module: "application.index",
                    filename: "/srv/src/orders/index.ts",
                    function: "run",
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const sourceRoot = fingerprintEvent(
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
                    module: "application.index",
                    filename: "/src/orders/index.ts",
                    function: "run",
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const webpackSourceRoot = fingerprintEvent(
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
                    module: "application.index",
                    filename: "webpack:///src/orders/index.ts",
                    function: "run",
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(appRoot.digest).toBe(srvRoot.digest);
    expect(sourceRoot.digest).toBe(srvRoot.digest);
    expect(webpackSourceRoot.digest).toBe(srvRoot.digest);
  });

  it("retains deep unanchored absolute paths instead of collapsing them", () => {
    const firstPath = fingerprintEvent(
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
                    module: "application.index",
                    filename: "/build-a/feature/payments/index.ts",
                    function: "run",
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const secondPath = fingerprintEvent(
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
                    module: "application.index",
                    filename: "/build-b/feature/payments/index.ts",
                    function: "run",
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(firstPath.digest).not.toBe(secondPath.digest);
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

  it("normalizes only whole 32, 40, and 64 character hash tokens", () => {
    const hash32 = "0123456789abcdef0123456789abcdef";
    const hash40 = "0123456789abcdef0123456789abcdef01234567";
    const hash64 =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    expect(normalizeMessageTemplate(`hash ${hash32}`)).toBe("hash {hash}");
    expect(normalizeMessageTemplate(`hash ${hash40}`)).toBe("hash {hash}");
    expect(normalizeMessageTemplate(`hash ${hash64}`)).toBe("hash {hash}");
    expect(normalizeMessageTemplate(`token g${hash32}z`)).toBe(
      `token g${hash32}z`,
    );
    expect(normalizeMessageTemplate(`hash ${hash32.slice(0, -1)}`)).toBe(
      `hash ${hash32.slice(0, -1)}`,
    );
    expect(normalizeMessageTemplate(`hash ${hash32}0`)).toBe(`hash ${hash32}0`);
  });

  it("normalizes standalone numeric identifiers without changing semantic numeric tokens", () => {
    expect(normalizeMessageTemplate("invoice 12345 failed")).toBe(
      "invoice {number} failed",
    );
    expect(normalizeMessageTemplate("HTTP 404 after 1.5 seconds")).toBe(
      "HTTP 404 after 1.5 seconds",
    );
    expect(normalizeMessageTemplate("build12345 failed")).toBe(
      "build12345 failed",
    );
  });

  it("uses meaningful server names before falling back to an explicit service tag", () => {
    const tagService = exceptionEvent({
      server_name: null,
      tags: { service: "worker" },
    });
    const emptyServerName = fingerprintEvent(
      exceptionEvent({ server_name: "", tags: { service: "worker" } }),
    );
    const whitespaceServerName = fingerprintEvent(
      exceptionEvent({ server_name: "  ", tags: { service: "worker" } }),
    );
    const directService = fingerprintEvent(
      exceptionEvent({ server_name: "worker" }),
    );
    const serverNameWins = fingerprintEvent(
      exceptionEvent({ server_name: "api", tags: { service: "worker" } }),
    );

    expect(emptyServerName.digest).toBe(fingerprintEvent(tagService).digest);
    expect(whitespaceServerName.digest).toBe(
      fingerprintEvent(tagService).digest,
    );
    expect(directService.digest).toBe(fingerprintEvent(tagService).digest);
    expect(serverNameWins.digest).not.toBe(fingerprintEvent(tagService).digest);
  });

  it("keeps scoped issue keys separate across trusted projects", () => {
    const event = exceptionEvent();
    const firstProject = scopedIssueKey({ projectId: 7, event });
    const secondProject = scopedIssueKey({ projectId: 8, event });

    expect(firstProject.fingerprint).toBe(secondProject.fingerprint);
    expect(firstProject).not.toEqual(secondProject);
  });
});
