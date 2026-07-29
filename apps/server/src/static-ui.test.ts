import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerStaticUi } from "./static-ui.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("private static UI", () => {
  it("serves the Vite entry for both issue permalinks without intercepting APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "error-hub-static-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<!doctype html><h1>Hub UI</h1>");
    await writeFile(join(root, "assets", "app-abc123.js"), "export {};");
    await writeFile(join(root, "assets", "app-abc123.css"), "body{}");
    await mkdir(join(root, "fonts"));
    await writeFile(join(root, "fonts", "hub.woff2"), "font");
    const app = Fastify({ exposeHeadRoutes: false });
    app.get("/api/issues", async () => ({ source: "api" }));
    registerStaticUi(app, { root });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test listener address is unavailable");
      }
      const origin = `http://127.0.0.1:${String(address.port)}`;
      for (const path of [
        "/",
        "/organizations/intexuraos/issues/41/",
        "/organizations/intexuraos/issues/41/events/event-sdk-id/",
      ]) {
        const response = await fetch(`${origin}${path}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(await response.text()).toContain("Hub UI");
      }
      expect(await (await fetch(`${origin}/api/issues`)).json()).toEqual({
        source: "api",
      });
      expect((await fetch(`${origin}/api/missing`)).status).toBe(404);
      for (const [path, contentType] of [
        ["/assets/app-abc123.js", "text/javascript"],
        ["/assets/app-abc123.css", "text/css"],
        ["/fonts/hub.woff2", "font/woff2"],
      ] as const) {
        const response = await fetch(`${origin}${path}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(contentType);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      }
      const head = await fetch(`${origin}/assets/app-abc123.js`, {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      for (const path of [
        "/missing",
        "/assets/missing.js",
        "/assets/app-abc123.html",
        "/metrics",
        "/health/ready",
      ]) {
        expect((await fetch(`${origin}${path}`)).status).toBe(404);
      }
      expect(
        (await fetch(`${origin}/`, { method: "POST", body: "ignored" })).status,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects traversal, content-type confusion, and links escaping the asset root", async () => {
    const root = await mkdtemp(join(tmpdir(), "error-hub-static-safe-"));
    const outside = await mkdtemp(join(tmpdir(), "error-hub-static-outside-"));
    temporaryDirectories.push(root, outside);
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "entry");
    await writeFile(join(outside, "secret.js"), "do-not-serve");
    await symlink(join(outside, "secret.js"), join(root, "assets", "link.js"));
    const app = Fastify({ exposeHeadRoutes: false });
    registerStaticUi(app, { root });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test listener address is unavailable");
      }
      const origin = `http://127.0.0.1:${String(address.port)}`;
      for (const path of [
        "/assets/link.js",
        "/assets/%2e%2e/index.html",
        "/assets/%252e%252e/index.js",
        "/assets/file.js%00.css",
        "/assets\\file.js",
      ]) {
        expect((await fetch(`${origin}${path}`)).status).toBe(404);
      }
    } finally {
      await app.close();
    }
  });
});
