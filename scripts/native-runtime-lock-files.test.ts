import { describe, expect, it } from "vitest";
import { loadNativeRuntimeLock } from "./native-runtime-lock";

describe("native runtime lock", () => {
  // The rename pass that follows a merge from upstream must not touch a vendored file. Its checksum
  // in native-runtime.lock.json would stop matching, and the package step would fail late, as it did
  // on 31 October 2026 with the Sunshine patch.
  it("matches the checksums of the vendored patches and overrides", async () => {
    await expect(loadNativeRuntimeLock()).resolves.toBeDefined();
  });
});
