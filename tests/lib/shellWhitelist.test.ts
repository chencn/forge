import { describe, expect, it } from "vitest";
import { appendExtraExtension, normalizeExtraExtensions } from "../../src/lib/shellWhitelist";

const builtin = ["txt", "md", "json"];

describe("appendExtraExtension", () => {
  it("追加新后缀，并收成不带点的小写", () => {
    expect(appendExtraExtension([], ".Prisma", builtin)).toEqual(["prisma"]);
    expect(appendExtraExtension(["prisma"], "*.HTTP", builtin)).toEqual(["prisma", "http"]);
  });

  it("内置格式和重复追加都不改原名单", () => {
    const current = ["prisma"];
    expect(appendExtraExtension(current, "txt", builtin)).toBe(current);
    expect(appendExtraExtension(current, ".PRISMA", builtin)).toBe(current);
    expect(appendExtraExtension(current, "not an ext", builtin)).toBe(current);
  });
});

describe("normalizeExtraExtensions", () => {
  it("非法、内置和重复都只留用户自己的第一条", () => {
    expect(normalizeExtraExtensions(["TXT", "prisma", ".prisma", "bad/ext", "http"], builtin)).toEqual([
      "prisma",
      "http",
    ]);
  });
});
