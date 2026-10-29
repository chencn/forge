import { describe, expect, it } from "vitest";
import { detectExternalLibraries, invalidateLibrariesCache } from "../../src/features/project-tree/libraries";

describe("External Libraries Detection", () => {
  it("provides fallback SDK when directory does not have libraries", async () => {
    invalidateLibrariesCache();
    const groups = await detectExternalLibraries("D:/non-existent-path-abc-123");
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0].id).toBe("sdk");
    expect(groups[0].roots[0].name).toBe("Standard Built-in Modules");
  });

  it("caches detected groups for the same root", async () => {
    const root = "D:/dummy-cache-test";
    const first = await detectExternalLibraries(root);
    const second = await detectExternalLibraries(root);
    expect(first).toBe(second);

    invalidateLibrariesCache(root);
    const third = await detectExternalLibraries(root);
    expect(third).not.toBe(first);
  });
});
