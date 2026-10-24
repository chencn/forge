import { describe, expect, it } from "vitest";
import { isFileName, parseFileLink, resolveFileLink } from "../../src/lib/fileLinks";

describe("parseFileLink", () => {
  it.each([
    ["src/a.ts", "src/a.ts", undefined, undefined],
    ["./src/a.ts:12", "./src/a.ts", 12, undefined],
    ["../a.ts:12:5", "../a.ts", 12, 5],
    ["src/my%20file.ts:7", "src/my file.ts", 7, undefined],
  ])("parses a relative href %s", (href, path, line, column) => {
    expect(parseFileLink(href)).toEqual({ path, line, column });
  });

  it.each([
    ["a.ts:12", "a.ts", 12],
    ["Makefile:40:2", "Makefile", 40],
    [".env:3", ".env", 3],
    ["README", "README", undefined],
  ])("parses a root file %s", (href, path, line) => {
    expect(parseFileLink(href)).toMatchObject({ path, line });
  });

  it("keeps a Windows drive path and its line", () => {
    expect(parseFileLink("C:\\repo\\a.ts:12")).toEqual({ path: "C:/repo/a.ts", line: 12 });
    expect(parseFileLink("C:/repo/a.ts#L10-L25")).toEqual({ path: "C:/repo/a.ts", line: 10 });
  });

  it("reads the percent-encoded separators marked writes out", () => {
    expect(parseFileLink("C:%5Crepo%5Ca.ts:12")).toMatchObject({ path: "C:/repo/a.ts", line: 12 });
    expect(parseFileLink("src%5Ca.ts:3")).toMatchObject({ path: "src/a.ts", line: 3 });
  });

  it("rewrites file uris to local paths", () => {
    expect(parseFileLink("file:///C:/repo/a.ts")).toEqual({
      path: "C:/repo/a.ts",
      line: undefined,
      column: undefined,
    });
    expect(parseFileLink("file:///repo/a.md#line=4")?.line).toBe(4);
    expect(parseFileLink("file://server/share/a.ts:9")).toMatchObject({
      path: "//server/share/a.ts",
      line: 9,
    });
  });

  it.each([
    ["https://example.com/a.ts", null],
    ["mailto:a@b.com", null],
    ["#anchor", null],
    ["//example.com/a.ts", null],
    ["example.com/a.ts", null],
    ["localhost:3000/a", null],
    ["docs", null],
    ["", null],
  ])("rejects non-file href %s", (href, expected) => {
    expect(parseFileLink(href)).toBe(expected);
  });
});

describe("resolveFileLink", () => {
  it("resolves relative paths against the workspace", () => {
    expect(resolveFileLink(parseFileLink("src/a.ts:3")!, "D:\\repo")).toBe("D:\\repo\\src\\a.ts");
    expect(resolveFileLink(parseFileLink("./a.ts")!, "/repo")).toBe("/repo/a.ts");
    expect(resolveFileLink(parseFileLink("../a.ts")!, "/repo/sub")).toBe("/repo/a.ts");
  });

  it("keeps absolute paths and converts their separators", () => {
    expect(resolveFileLink(parseFileLink("C:/repo/a.ts")!, null)).toBe("C:\\repo\\a.ts");
    expect(resolveFileLink(parseFileLink("/repo/a.ts")!, "/repo")).toBe("/repo/a.ts");
  });

  it("maps a Git Bash drive path on Windows", () => {
    expect(resolveFileLink(parseFileLink("/d/app/forge/a.ts")!, "D:\\app\\forge")).toBe(
      "D:\\app\\forge\\a.ts"
    );
  });

  it("gives up on paths it cannot locate", () => {
    expect(resolveFileLink(parseFileLink("src/a.ts")!, null)).toBeNull();
    expect(resolveFileLink(parseFileLink("~/a.ts")!, "D:\\repo")).toBeNull();
  });
});

describe("isFileName", () => {
  it("tells files from words and hosts", () => {
    expect(isFileName("a.ts")).toBe(true);
    expect(isFileName(".gitignore")).toBe(true);
    expect(isFileName("Dockerfile")).toBe(true);
    expect(isFileName("README")).toBe(true);
    expect(isFileName("v1.2.3")).toBe(false);
    expect(isFileName("example.com")).toBe(false);
    expect(isFileName("docs")).toBe(false);
  });
});
