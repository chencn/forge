import { describe, expect, it } from "vitest";
import { getNextScratchName, SCRATCH_LANGUAGES } from "../../src/features/project-tree/scratches";

describe("Scratches naming and language definitions", () => {
  it("provides common scratch languages", () => {
    expect(SCRATCH_LANGUAGES.length).toBeGreaterThan(10);
    const exts = SCRATCH_LANGUAGES.map((l) => l.ext);
    expect(exts).toContain("txt");
    expect(exts).toContain("ts");
    expect(exts).toContain("rs");
    expect(exts).toContain("json");
  });

  it("generates scratch.ext when empty", () => {
    const name = getNextScratchName([], "txt");
    expect(name).toBe("scratch.txt");
  });

  it("increments to scratch_1.ext when scratch.ext exists", () => {
    const name = getNextScratchName(["scratch.txt"], "txt");
    expect(name).toBe("scratch_1.txt");
  });

  it("finds next free index", () => {
    const name = getNextScratchName(["scratch.txt", "scratch_1.txt", "scratch_2.txt"], "txt");
    expect(name).toBe("scratch_3.txt");
  });

  it("is case-insensitive on existing names", () => {
    const name = getNextScratchName(["SCRATCH.TXT"], "txt");
    expect(name).toBe("scratch_1.txt");
  });
});
