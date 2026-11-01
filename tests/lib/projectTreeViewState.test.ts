import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasSavedViewOptions,
  loadExpanded,
  loadViewMode,
  loadViewOptions,
  saveExpanded,
  saveViewMode,
  saveViewOptions,
} from "../../src/features/project-tree/viewState";
import { DEFAULT_VIEW_OPTIONS, type ViewOptions } from "../../src/features/project-tree/ProjectHeader";

describe("项目树视图状态持久化", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  it("按工程根分别保存视图模式、选项和展开集合", () => {
    const options: ViewOptions = {
      ...DEFAULT_VIEW_OPTIONS,
      compact: false,
      showHidden: true,
      showExcluded: false,
    };

    saveViewOptions("d:/one", options);
    saveViewMode("d:/one", "changedFiles");
    saveExpanded("d:/one", new Set(["d:/one", "d:/one/src"]));

    expect(loadViewOptions("d:/one")).toEqual(options);
    expect(loadViewMode("d:/one")).toBe("changedFiles");
    expect(loadExpanded("d:/one")).toEqual(new Set(["d:/one", "d:/one/src"]));
    expect(loadViewMode("d:/two")).toBe("project");
    expect(loadExpanded("d:/two")).toBeNull();
  });

  it("拒绝损坏模式并限制展开键数量", () => {
    localStorage.setItem("forge:tree:mode:d:/one", JSON.stringify("unknown"));
    localStorage.setItem(
      "forge:tree:expanded:d:/one",
      JSON.stringify(["d:/one/src", 12, ...Array.from({ length: 3005 }, (_, i) => `d:/one/${i}`)])
    );

    expect(loadViewMode("d:/one")).toBe("project");
    const expanded = loadExpanded("d:/one");
    expect(expanded?.size).toBe(3000);
    expect(expanded?.has("d:/one/src")).toBe(true);
    expect(expanded?.has("d:/one/2998")).toBe(true);
  });

  it("能区分没有项目选项与已经保存默认选项", () => {
    expect(hasSavedViewOptions("d:/one")).toBe(false);
    saveViewOptions("d:/one", DEFAULT_VIEW_OPTIONS);
    expect(hasSavedViewOptions("d:/one")).toBe(true);
  });
});
