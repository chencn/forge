import { describe, expect, it } from "vitest";
import {
  createEditorSplit,
  partitionEditorTabs,
  editorTabDropTarget,
  relocateEditorTab,
  replaceEditorSplitTab,
} from "../../src/lib/editorSplit";

const tabs = [
  { id: "doc|a", kind: "doc" },
  { id: "pane|terminal", kind: "pane" },
  { id: "ai|session-1", kind: "ai" },
];

describe("编辑区标签分组", () => {
  it.each(["horizontal", "vertical"] as const)(
    "%s 拆分只把目标标签移入副栏",
    (direction) => {
      const transition = createEditorSplit(
        tabs.map((tab) => tab.id),
        "pane|terminal",
        "pane|terminal",
        direction,
      );
      const groups = partitionEditorTabs(tabs, transition.split);

      expect(groups.primary.map((tab) => tab.id)).toEqual(["doc|a", "ai|session-1"]);
      expect(groups.secondary.map((tab) => tab.id)).toEqual(["pane|terminal"]);
      expect(transition.primaryActiveId).toBe("ai|session-1");
      expect(transition.split.direction).toBe(direction);
    },
  );

  it("拆分非活动标签时保留主栏活动标签", () => {
    const transition = createEditorSplit(
      tabs.map((tab) => tab.id),
      "doc|a",
      "ai|session-1",
      "horizontal",
    );

    expect(transition.primaryActiveId).toBe("doc|a");
  });

  it("子代理分栏默认 7:3，文件预览默认 5:5，未指定时沿用当前比例", () => {
    const ids = tabs.map((tab) => tab.id);
    expect(createEditorSplit(ids, "doc|a", "pane|terminal", "horizontal").split.ratio).toBe(50);
    const subagent = createEditorSplit(ids, "doc|a", "ai|session-1", "horizontal", null, 70);
    expect(subagent.split.ratio).toBe(70);
    const kept = createEditorSplit(ids, "doc|a", "pane|terminal", "horizontal", subagent.split);
    expect(kept.split.ratio).toBe(70);
    expect(createEditorSplit(ids, "doc|a", "pane|terminal", "horizontal", subagent.split, 50).split.ratio).toBe(50);
  });

  it("再次拆分只追加目标标签，原副栏标签保留且不重复", () => {
    const ids = tabs.map((tab) => tab.id);
    const first = createEditorSplit(ids, "pane|terminal", "pane|terminal", "horizontal");
    const second = createEditorSplit(ids, "ai|session-1", "ai|session-1", "vertical", first.split);
    const repeated = createEditorSplit(ids, "ai|session-1", "ai|session-1", "horizontal", second.split);
    const groups = partitionEditorTabs(tabs, repeated.split);
    expect(groups.primary.map((tab) => tab.id)).toEqual(["doc|a"]);
    expect(groups.secondary.map((tab) => tab.id)).toEqual(["pane|terminal", "ai|session-1"]);
    expect(repeated.split.tabId).toBe("ai|session-1");
  });

  it("指针落在标签左半边插到前面，右半边插到后面，空白处接到末尾", () => {
    const ids = ["doc|a", "doc|b"];
    expect(editorTabDropTarget("doc|a", ids, false, "doc|b", false)).toEqual({ beforeId: "doc|b" });
    expect(editorTabDropTarget("doc|a", ids, false, "doc|b", true)).toEqual({ beforeId: null });
    expect(editorTabDropTarget("doc|a", ids, false, "doc|a", false)).toBeNull();
    expect(editorTabDropTarget("doc|left", ["doc|right"], true, null, false)).toEqual({ beforeId: null });
    expect(editorTabDropTarget("doc|left", ["doc|right"], false, "doc|right", false)).toBeNull();
  });

  it("跨栏拖动按目标栏的落点插入，拖到空白处则接到该栏末尾", () => {
    const order = ["doc|a", "ai|left", "ai|right", "doc|b"];
    const secondary = ["ai|right"];
    expect(relocateEditorTab(order, secondary, "doc|a", "ai|right", "secondary")).toEqual(["ai|left", "doc|a", "ai|right", "doc|b"]);
    expect(relocateEditorTab(order, secondary, "doc|a", null, "secondary")).toEqual(["ai|left", "ai|right", "doc|a", "doc|b"]);
    expect(relocateEditorTab(order, secondary, "ai|right", "doc|b", "primary")).toEqual(["doc|a", "ai|left", "ai|right", "doc|b"]);
    expect(relocateEditorTab(order, secondary, "ai|right", null, "primary")).toEqual(["doc|a", "ai|left", "doc|b", "ai|right"]);
  });

  it("取消拆分后所有标签归回主栏，标签内容和顺序保持不变", () => {
    expect(partitionEditorTabs(tabs, null)).toEqual({ primary: tabs, secondary: [] });
  });

  it("副栏启动 AI 会话后，新会话继承草稿的位置和活动项", () => {
    const initial = createEditorSplit(["doc|a", "ai|draft"], "ai|draft", "ai|draft", "vertical");
    const split = replaceEditorSplitTab(initial.split, "ai|draft", "ai|created");
    expect(partitionEditorTabs([{ id: "doc|a" }, { id: "ai|created" }], split))
      .toEqual({ primary: [{ id: "doc|a" }], secondary: [{ id: "ai|created" }] });
    expect(split?.tabId).toBe("ai|created");
    expect(split?.direction).toBe("vertical");
  });
});
