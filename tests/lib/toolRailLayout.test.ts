import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_RAIL_LAYOUT,
  loadToolRailLayout,
  moveToolRail,
  normalizeToolRailLayout,
  reorderToolRail,
  saveToolRailLayout,
} from "../../src/lib/toolRailLayout";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  },
});

beforeEach(() => memory.clear());

describe("活动栏布局", () => {
  it("只允许同侧同组排序", () => {
    const moved = reorderToolRail(DEFAULT_TOOL_RAIL_LAYOUT, "git", "explorer", true);
    expect(moved.left.top).toEqual(["git", "explorer"]);
    expect(reorderToolRail(moved, "git", "terminal", true)).toBe(moved);
    expect(reorderToolRail(moved, "git", "maven", true)).toBe(moved);
  });

  it("左右迁移时保留上下分组", () => {
    const top = moveToolRail(DEFAULT_TOOL_RAIL_LAYOUT, "explorer", "right");
    const bottom = moveToolRail(top, "notifications", "left");
    expect(top.right.top.at(-1)).toBe("explorer");
    expect(bottom.left.bottom.at(-1)).toBe("notifications");
    expect(bottom.left.top).not.toContain("notifications");
  });

  it("归一化坏数据并补回遗漏工具", () => {
    const layout = normalizeToolRailLayout({
      left: { top: ["git", "git", "terminal", "unknown"], bottom: ["run"] },
      right: { top: ["maven"], bottom: ["notifications"] },
    });
    expect(layout.left.top).toEqual(["git", "explorer"]);
    expect(layout.left.bottom).toEqual(["run", "terminal", "log"]);
    expect(layout.right.top).toEqual(["maven", "ai", "browser"]);
  });

  it("使用独立存储键往返布局", () => {
    const layout = moveToolRail(DEFAULT_TOOL_RAIL_LAYOUT, "explorer", "right");
    saveToolRailLayout(layout);
    expect(loadToolRailLayout()).toEqual(layout);
  });

  it("首次读取 v1 布局时把 AI 迁到右侧顶部第一位", () => {
    memory.set("forge:tool-rail-layout:v1", JSON.stringify({
      left: { top: ["explorer", "ai", "git"], bottom: ["terminal", "run", "log"] },
      right: { top: ["maven"], bottom: ["notifications"] },
    }));
    const layout = loadToolRailLayout();
    expect(layout.left.top).toEqual(["explorer", "git"]);
    expect(layout.right.top).toEqual(["ai", "maven", "browser"]);
  });

  it("已有布局补入右侧浏览器，并保留用户之后的移栏选择", () => {
    memory.set("forge:tool-rail-layout:v2", JSON.stringify({
      left: { top: ["explorer", "git"], bottom: ["terminal", "run", "log"] },
      right: { top: ["ai", "maven"], bottom: ["notifications"] },
    }));
    const layout = loadToolRailLayout();
    expect(layout.right.top).toContain("browser");
    expect(layout.left.top).not.toContain("browser");
    saveToolRailLayout(moveToolRail(layout, "browser", "left"));
    expect(loadToolRailLayout().left.top).toContain("browser");
    expect(loadToolRailLayout().right.top).not.toContain("browser");
  });
});
