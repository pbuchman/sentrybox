import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";

describe("server workspace", () => {
  it("identifies the server package", () => {
    expect(packageMetadata.name).toBe("@intexura-error-hub/server");
  });
});
