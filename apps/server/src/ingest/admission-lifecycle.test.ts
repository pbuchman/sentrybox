import { describe, expect, it, vi } from "vitest";
import { createAdmissionReleaseHooks } from "./admission-lifecycle.js";

describe("ingest admission lifecycle", () => {
  it("releases an admitted request through the timeout hook", async () => {
    const releaseRequest = vi.fn<(request: object) => void>();
    const hooks = createAdmissionReleaseHooks(releaseRequest);
    const request = {};

    await hooks.onTimeout(request);

    expect(releaseRequest).toHaveBeenCalledOnce();
    expect(releaseRequest).toHaveBeenCalledWith(request);
  });
});
