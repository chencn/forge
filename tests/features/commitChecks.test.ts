import { describe, expect, it } from "vitest";
import { badCommitNames, isNewCommitPath } from "../../src/features/vcs/commitChecks";

describe("badCommitNames", () => {
  it("flags Windows reserved names with or without an extension", () => {
    expect(badCommitNames(["src/con.ts", "readme.md"])).toEqual({ reserved: ["src/con.ts"], invalid: [] });
    expect(badCommitNames(["LPT1/a.txt"])).toEqual({ reserved: ["LPT1/a.txt"], invalid: [] });
  });

  it("flags characters Windows rejects and leaves ordinary names alone", () => {
    expect(badCommitNames(["ok/name.txt", "bad/a:b.txt"])).toEqual({ reserved: [], invalid: ["bad/a:b.txt"] });
    expect(badCommitNames(["src/console.ts"])).toEqual({ reserved: [], invalid: [] });
  });
});

describe("isNewCommitPath", () => {
  it("accepts untracked, added, renamed and copied paths only", () => {
    expect(isNewCommitPath({ untracked: true, indexStatus: "" })).toBe(true);
    expect(isNewCommitPath({ untracked: false, indexStatus: "A" })).toBe(true);
    expect(isNewCommitPath({ untracked: false, indexStatus: "R" })).toBe(true);
    expect(isNewCommitPath({ untracked: false, indexStatus: "M" })).toBe(false);
    expect(isNewCommitPath(undefined)).toBe(false);
  });
});
