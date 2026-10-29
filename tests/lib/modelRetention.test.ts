import { describe, expect, it } from "vitest";
import { KEPT_FILE_MODELS, nextKeptPaths } from "../../src/lib/keptModels";
import { registerRetentionSweep, retainEditorModels } from "../../src/lib/modelRetention";

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

describe("retainEditorModels", () => {
  const many = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);

  it("名单交给登记的引擎，并且按上限截断", () => {
    const seen: Array<{ keep: string[]; open: number }> = [];
    const off = registerRetentionSweep((keep, open) => {
      seen.push({ keep: [...keep], open: open.length });
    });
    for (const path of many) retainEditorModels(path, many);
    off();
    const last = seen[seen.length - 1];
    expect(last?.keep).toHaveLength(KEPT_FILE_MODELS);
    // 当前这篇排第一，最早那两篇已经让位。
    expect(last?.keep[0]).toBe(many[11]);
    expect(last?.keep).not.toContain(many[0]);
    expect(last?.open).toBe(12);
  });

  it("退订之后不再收到调用", () => {
    let calls = 0;
    const off = registerRetentionSweep(() => {
      calls += 1;
    });
    retainEditorModels("x.ts", ["x.ts"]);
    off();
    retainEditorModels("y.ts", ["x.ts", "y.ts"]);
    expect(calls).toBe(1);
  });
});
