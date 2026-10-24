import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiRequest } from "../../src/lib/aiRuntime";

const h = vi.hoisted(() => ({ states: [] as unknown[], index: 0 }));
vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ t: (key: string, vars?: Record<string, unknown>) => (vars?.root ? `${key}:${vars.root}` : key) }),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => {
      const index = h.index++;
      if (!(index in h.states)) h.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [h.states[index], (next: unknown) => { h.states[index] = typeof next === "function" ? (next as (prev: unknown) => unknown)(h.states[index]) : next; }];
    } };
});

import AiApprovalCard from "../../src/components/AiApprovalCard";

type Node = ReactElement<Record<string, unknown>>;

/** 折叠体在 Fragment 里，只翻一层 children 找不到按钮。 */
function nodes(root: unknown): Node[] {
  if (!root || typeof root !== "object") return [];
  if ("props" in root) {
    const element = root as Node;
    return [element, ...nodes(element.props.children)];
  }
  return Array.isArray(root) ? root.flatMap(nodes) : [];
}

const answers: Record<string, unknown>[] = [];
const EDITABLE: Partial<AiRequest> = { toolName: "Edit", input: { file_path: "a.ts", new_string: "two" }, canEdit: true };

function render(request: Partial<AiRequest>, stopping = false) {
  const full = { requestId: "r1-1", runId: "r1", kind: "permission", title: "Edit", detail: "", questions: [], active: true, ...request } as AiRequest;
  let tree!: Node;
  h.index = 0;
  function Harness() {
    // 直接调用组件函数拿到的才是它渲染出来的元素树；createElement 拿到的只是入参。
    tree = AiApprovalCard({ request: full, stopping, onRespond: (answer) => { answers.push(answer); } }) as Node;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Harness));
  return { html, tree };
}

const label = (node: Node) => String(node.props.children ?? "");
const buttons = (tree: Node) => nodes(tree).filter((node) => node.type === "button");
const buttonByLabel = (tree: Node, text: string) => buttons(tree).find((node) => label(node) === text);
const click = (tree: Node, text: string) => (buttonByLabel(tree, text)!.props.onClick as () => void)();
const textarea = (tree: Node) => nodes(tree).find((node) => node.type === "textarea");

beforeEach(() => {
  h.states = [];
  h.index = 0;
  answers.length = 0;
});

describe("AiApprovalCard", () => {
  it("认不出路径时只给一次一答与整工具放行，绝不出现按目录授权", () => {
    const { tree } = render({ toolName: "exec", input: { command: "rm -rf /" } });
    expect(buttons(tree).map(label)).toEqual(["ai.runtime.deny", "ai.runtime.allowOnce", "ai.runtime.allowAndRemember"]);
    expect(buttonByLabel(tree, "ai.runtime.editBeforeAllow")).toBeUndefined();
  });
  it("路径是绝对的时候才出现「本轮该目录内不再询问」，并把目录写进文案", () => {
    const { tree } = render({ toolName: "Edit", input: { file_path: "D:/app/src/a.ts" } });
    expect(buttonByLabel(tree, "ai.runtime.allowDirectoryNamed:D:/app/src")).toBeTruthy();
  });
  it("后端没声明 canEdit 就不出现「改完再允许」", () => {
    const { tree } = render({ toolName: "Edit", input: { file_path: "D:/app/src/a.ts" }, canEdit: false });
    expect(buttonByLabel(tree, "ai.runtime.editBeforeAllow")).toBeUndefined();
    const withEdit = render({ toolName: "Edit", input: { file_path: "D:/app/src/a.ts" }, canEdit: true });
    expect(buttonByLabel(withEdit.tree, "ai.runtime.editBeforeAllow")).toBeTruthy();
  });
  it("认不出工具名时只剩允许一次与拒绝，也不谎报「不再询问」的范围", () => {
    const { tree, html } = render({ input: { file_path: "D:/app/src/a.ts" } });
    expect(buttons(tree).map(label)).toEqual(["ai.runtime.deny", "ai.runtime.allowOnce"]);
    expect(html).not.toContain("ai.runtime.grantScopeNote");
  });
  it("四种授权各自送出各自的答复形状", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["ai.runtime.deny", { allow: false }],
      ["ai.runtime.allowOnce", { allow: true }],
      ["ai.runtime.allowAndRemember", { allow: true, remember: { tool: "Edit" } }],
      ["ai.runtime.allowDirectoryNamed:D:/app/src", { allow: true, remember: { tool: "Edit", root: "D:/app/src" } }],
    ];
    for (const [text, answer] of cases) {
      answers.length = 0;
      const { tree } = render({ toolName: "Edit", input: { file_path: "D:/app/src/a.ts" } });
      click(tree, text);
      expect(answers).toEqual([answer]);
    }
  });
  it("请求失效或正在停止时，每个按钮都是按不动的", () => {
    for (const { request, stopping } of [{ request: { toolName: "Edit", active: false }, stopping: false }, { request: { toolName: "Edit" }, stopping: true }]) {
      const { tree } = render(request, stopping);
      expect(buttons(tree).length).toBeGreaterThan(2);
      buttons(tree).forEach((node) => expect(node.props.disabled).toBe(true));
    }
  });
  it("「改完再允许」摊开原入参；改坏时只报错，一个字节都不发", () => {
    const opened = render(EDITABLE);
    expect(textarea(opened.tree)).toBeUndefined();
    expect(buttonByLabel(opened.tree, "ai.runtime.submitEdit")).toBeUndefined();
    click(opened.tree, "ai.runtime.editBeforeAllow");
    const typed = render(EDITABLE);
    expect(textarea(typed.tree)?.props.value).toBe('{\n  "file_path": "a.ts",\n  "new_string": "two"\n}');
    (textarea(typed.tree)!.props.onChange as (event: unknown) => void)({ target: { value: "{" } });
    const broken = render(EDITABLE);
    click(broken.tree, "ai.runtime.submitEdit");
    expect(answers).toEqual([]);
    expect(render(EDITABLE).html).toContain("ai.runtime.editNotJson");
  });
  it("改对了就只提交改过的那部分，再点一次开关收起面板", () => {
    const opened = render(EDITABLE);
    click(opened.tree, "ai.runtime.editBeforeAllow");
    const typed = render(EDITABLE);
    (textarea(typed.tree)!.props.onChange as (event: unknown) => void)({ target: { value: '{"new_string":"safe"}' } });
    const ready = render(EDITABLE);
    click(ready.tree, "ai.runtime.submitEdit");
    expect(answers).toEqual([{ allow: true, input: { new_string: "safe" } }]);
    // 提交不改展开状态；收起由同一个开关负责。
    click(render(EDITABLE).tree, "ai.runtime.editBeforeAllow");
    expect(textarea(render(EDITABLE).tree)).toBeUndefined();
  });
});
