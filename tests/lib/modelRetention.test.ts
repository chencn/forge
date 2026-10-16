import { describe, expect, it } from "vitest";
import { KEPT_FILE_MODELS, nextKeptPaths } from "../../src/lib/keptModels";

describe("nextKeptPaths", () => {
  const open = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts", "i.ts"];

  it("当前这篇排最前，超过上限丢掉最早的", () => {
    const kept = nextKeptPaths(
      ["h.ts", "g.ts", "f.ts", "e.ts", "d.ts", "c.ts", "b.ts", "a.ts"],
      "i.ts",
      open,
      KEPT_FILE_MODELS
    );
    expect(kept).toEqual(["i.ts", "h.ts", "g.ts", "f.ts", "e.ts", "d.ts", "c.ts", "b.ts"]);
    expect(kept).not.toContain("a.ts");
  });

  it("已经关掉的路径不再占名额", () => {
    expect(nextKeptPaths(["gone.ts", "b.ts"], "a.ts", ["a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
  });

  it("盘符大小写不同仍算同一篇", () => {
    expect(nextKeptPaths(["C:/proj/a.ts"], "c:/proj/a.ts", ["c:/proj/a.ts"])).toEqual([
      "c:/proj/a.ts",
    ]);
  });
});
