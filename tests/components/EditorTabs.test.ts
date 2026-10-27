import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ states: [] as unknown[], index: 0 }));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useEffect: () => undefined,
    useRef: (initial: unknown) => ({ current: initial }),
    useState: (initial: unknown) => {
      const index = h.index++;
      if (!(index in h.states)) h.states[index] = initial;
      return [h.states[index], (next: unknown) => {
        h.states[index] = typeof next === "function"
          ? (next as (value: unknown) => unknown)(h.states[index])
          : next;
      }];
    },
  };
});

vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../../src/components/AiSessionActivity", () => ({ default: () => null }));
vi.mock("../../src/components/ContextMenu", () => ({ default: () => null }));

import EditorTabs, { type TabItem, type TabKind } from "../../src/components/EditorTabs";

type Node = ReactElement<Record<string, unknown>>;

function nodes(root: unknown): Node[] {
  if (!root || typeof root !== "object") return [];
  if ("props" in root) {
    const element = root as Node;
    return [element, ...nodes(element.props.children)];
  }
  return Array.isArray(root) ? root.flatMap(nodes) : [];
}

function splitMenu(kind: TabKind) {
  h.index = 0;
  const tab: TabItem = {
    id: kind === "doc" ? "doc|D:/project/a.ts" : `${kind}|sample`,
    kind,
    name: kind,
    title: kind,
    dirty: false,
  };
  const onSplitRight = vi.fn(), onSplitDown = vi.fn();
  const props = {
    tabs: [tab],
    activeId: tab.id,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseAll: vi.fn(),
    onReorder: vi.fn(),
    onSave: vi.fn(),
    isDirty: () => false,
    onSplitRight,
    onSplitDown,
  };
  const tree = EditorTabs(props) as Node;
  const tabNode = nodes(tree).find((node) => node.props.role === "tab")!;

  // 直接驱动标签公开的右键边界，避免把测试绑到 ContextMenu 的 DOM 结构上。
  (tabNode.props.onContextMenu as (event: Record<string, unknown>) => void)({
    preventDefault: vi.fn(),
    clientX: 10,
    clientY: 20,
  });

  h.index = 0;
  const opened = EditorTabs(props) as Node;
  const menu = nodes(opened).find((node) => "anchor" in node.props)!;
  const anchor = menu.props.anchor as { items: Array<{ label: string; onSelect: () => void }> };
  return { items: anchor.items, onSplitRight, onSplitDown, id: tab.id };
}

beforeEach(() => {
  h.states = [];
  h.index = 0;
});

describe("编辑区标签拆分菜单", () => {
  it.each<TabKind>(["doc", "diff", "pane", "settings", "ai"])(
    "%s 标签均支持向右和向下拆分",
    (kind) => {
      const menu = splitMenu(kind);
      expect(menu.items.map((item) => item.label)).toEqual(expect.arrayContaining([
        "menu.splitRight",
        "menu.splitDown",
      ]));
      menu.items.find((item) => item.label === "menu.splitRight")!.onSelect();
      menu.items.find((item) => item.label === "menu.splitDown")!.onSelect();
      expect(menu.onSplitRight).toHaveBeenCalledExactlyOnceWith(menu.id);
      expect(menu.onSplitDown).toHaveBeenCalledExactlyOnceWith(menu.id);
    },
  );
});
