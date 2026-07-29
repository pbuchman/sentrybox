import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@sentrybox/domain": new URL(
        "./packages/domain/src/index.ts",
        import.meta.url,
      ).pathname,
      "@sentrybox/protocol": new URL(
        "./packages/protocol/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "@sentrybox/server",
          include: [
            "apps/server/src/**/*.test.ts",
            "apps/server/test/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "@sentrybox/web",
          include: [
            "apps/web/src/**/*.test.ts",
            "apps/web/src/**/*.test.tsx",
            "apps/web/test/**/*.test.ts",
            "apps/web/test/**/*.test.tsx",
          ],
          environment: "jsdom",
        },
      },
      {
        test: {
          name: "@sentrybox/domain",
          include: [
            "packages/domain/src/**/*.test.ts",
            "packages/domain/test/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "@sentrybox/protocol",
          include: [
            "packages/protocol/src/**/*.test.ts",
            "packages/protocol/test/**/*.test.ts",
          ],
        },
      },
    ],
  },
});
