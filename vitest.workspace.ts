import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "@intexura-error-hub/server",
          include: ["apps/server/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "@intexura-error-hub/web",
          include: ["apps/web/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "@intexura-error-hub/domain",
          include: [
            "packages/domain/src/**/*.test.ts",
            "packages/domain/test/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "@intexura-error-hub/protocol",
          include: [
            "packages/protocol/src/**/*.test.ts",
            "packages/protocol/test/**/*.test.ts",
          ],
        },
      },
    ],
  },
});
