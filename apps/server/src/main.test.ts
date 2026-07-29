import { describe, expect, it } from "vitest";
import { readGrafanaExploreUrl } from "./main.js";

describe("runtime entry point", () => {
  it("has no listener, environment, or signal side effects when imported", async () => {
    const before = signalListenerCounts();
    const previous = process.env.ERROR_HUB_ENV_FILE;
    delete process.env.ERROR_HUB_ENV_FILE;
    try {
      await expect(import("./main.js")).resolves.toMatchObject({
        runMain: expect.any(Function),
      });
      expect(signalListenerCounts()).toEqual(before);
    } finally {
      if (previous === undefined) delete process.env.ERROR_HUB_ENV_FILE;
      else process.env.ERROR_HUB_ENV_FILE = previous;
    }
  });
});

describe("Grafana Explore configuration", () => {
  it("accepts one credential-free HTTPS URL and treats absence as disabled", () => {
    expect(readGrafanaExploreUrl({})).toBeNull();
    expect(
      readGrafanaExploreUrl({ ERROR_HUB_GRAFANA_EXPLORE_URL: "  " }),
    ).toBeNull();
    expect(
      readGrafanaExploreUrl({
        ERROR_HUB_GRAFANA_EXPLORE_URL:
          "https://logs.example.grafana.net/explore?orgId=1&datasource=grafanacloud-logs",
      })?.toString(),
    ).toBe(
      "https://logs.example.grafana.net/explore?orgId=1&datasource=grafanacloud-logs",
    );
  });

  it.each([
    "http://grafana.example/explore",
    "https://user:secret@grafana.example/explore",
    "https://grafana.example/explore?orgId=1",
    "https://grafana.example/explore?datasource=bad%20uid",
    "https://grafana.example/explore?orgId=one&datasource=logs",
    "https://grafana.example/explore?orgId=1&orgId=2&datasource=logs",
    "https://grafana.example/explore?orgId=1&datasource=logs&extra=value",
    "https://grafana.example/explore?orgId=1&datasource=logs#fragment",
    "https://grafana.example:70000/explore?orgId=1&datasource=logs",
    "not-a-url",
  ])("rejects an unsafe Grafana Explore URL: %s", (value) => {
    expect(() =>
      readGrafanaExploreUrl({ ERROR_HUB_GRAFANA_EXPLORE_URL: value }),
    ).toThrow(/Grafana Explore URL/u);
  });
});

function signalListenerCounts() {
  return {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
  };
}
