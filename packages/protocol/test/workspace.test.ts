import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";

describe("protocol workspace", () => {
  it("identifies the protocol package", () => {
    expect(packageMetadata.name).toBe("@sentrybox/protocol");
  });
});
