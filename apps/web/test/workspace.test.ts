import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";

describe("web workspace", () => {
  it("identifies the web package", () => {
    expect(packageMetadata.name).toBe("@intexura-error-hub/web");
  });
});
