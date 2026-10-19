import { describe, expect, it } from "vitest";
import { RECENT_CAP, withRemembered, withoutRemembered } from "../../src/lib/history";

describe("withRemembered", () => {
  it("将新项目插入到首位并去重", () => {
    const list = ["/a", "/b", "/c"];
    expect(withRemembered(list, "/b")).toEqual(["/b", "/a", "/c"]);
    expect(withRemembered(list, "/d")).toEqual(["/d", "/a", "/b", "/c"]);
  });

  it("超过上限截断", () => {
    const list = Array.from({ length: RECENT_CAP }, (_, i) => `/path/${i}`);
    const next = withRemembered(list, "/new");
    expect(next.length).toBe(RECENT_CAP);
    expect(next[0]).toBe("/new");
  });
});

describe("withoutRemembered", () => {
  it("从列表中移除目标字符串", () => {
    const list = ["main", "dev", "feat-1"];
    expect(withoutRemembered(list, "dev")).toEqual(["main", "feat-1"]);
  });

  it("支持跨平台路径匹配移除", () => {
    const list = ["D:\\app\\code\\forge", "C:\\projects\\demo"];
    expect(withoutRemembered(list, "d:/app/code/forge")).toEqual(["C:\\projects\\demo"]);
  });

  it("移除不存在的项时保持原列表", () => {
    const list = ["/a", "/b"];
    expect(withoutRemembered(list, "/c")).toEqual(["/a", "/b"]);
  });
});
