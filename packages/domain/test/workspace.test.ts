import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";

describe("domain workspace", () => {
  it("identifies the domain package", () => {
    expect(packageMetadata.name).toBe("@intexura-error-hub/domain");
  });
});
