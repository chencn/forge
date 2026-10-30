// @vitest-environment jsdom
/**
 * 全局右键兜底守卫（抄 openidea browserGuards）行为回归：
 * - 可读文本（user-select: text，如通知内容）右键给「复制」菜单；
 * - 有选区时可复制并写入剪贴板，无选区时菜单置灰；
 * - 普通 UI（user-select: none）与输入框不给菜单；
 * - 组件已接手（defaultPrevented / 自绘菜单已换）时不重复兜底。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyMenuFor, contextMenuGuard, installContextMenuGuard, copyText } from "../../src/lib/contextMenuGuard";

function el(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

let clipboard: string[] = [];

beforeEach(() => {
  clipboard = [];
  contextMenuGuard.close();
  Object.assign(navigator, {
    clipboard: { writeText: async (text: string) => clipboard.push(text) },
  });
});

describe("copyMenuFor", () => {
  it("可读文本右键给「复制」菜单，无选区时置灰", () => {
    const span = el(`<span id="t" style="user-select: text">通知内容</span>`);
    const menu = copyMenuFor(span);
    expect(menu).not.toBeNull();
    expect(menu![0].label).toBe("复制");
    expect(menu![0].disabled).toBe(true);
  });

  it("普通 UI（未放开选中）不给菜单", () => {
    const span = el(`<span id="u">界面文字</span>`);
    expect(copyMenuFor(span)).toBeNull();
  });

  it("输入框不给菜单", () => {
    const input = el(`<input id="i" />`);
    expect(copyMenuFor(input)).toBeNull();
  });

  it("选区覆盖落点时可复制选中文本", async () => {
    const span = el(`<span id="s" style="user-select: text">通知内容</span>`);
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      toString: () => "通知内容",
      rangeCount: 1,
      getRangeAt: () => ({
        intersectsNode: () => true,
        commonAncestorContainer: span,
      }),
    } as unknown as Selection);
    const menu = copyMenuFor(span);
    expect(menu![0].disabled).toBe(false);
    await menu![0].onSelect!();
    expect(clipboard).toEqual(["通知内容"]);
  });
});

describe("installContextMenuGuard", () => {
  it("组件未接手且落在可读文本上：弹兜底菜单并禁用原生菜单", () => {
    const cleanup = installContextMenuGuard();
    const span = el(`<span id="g" style="user-select: text">通知内容</span>`);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 34 });
    span.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    const menu = contextMenuGuard.get();
    expect(menu).not.toBeNull();
    expect(menu!.x).toBe(12);
    expect(menu!.y).toBe(34);
    expect(menu!.items[0].label).toBe("复制");
    cleanup();
    contextMenuGuard.close();
  });

  it("组件已接手（defaultPrevented）时不重复弹兜底菜单", () => {
    const cleanup = installContextMenuGuard();
    const div = el(`<div id="h" style="user-select: text">区域</div>`);
    div.addEventListener("contextmenu", (e) => e.preventDefault());
    div.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(contextMenuGuard.get()).toBeNull();
    cleanup();
  });
});

describe("copyText", () => {
  it("优先走 Clipboard API，异常时回退 execCommand", async () => {
    await copyText("a");
    expect(clipboard).toEqual(["a"]);

    Object.assign(navigator, { clipboard: { writeText: async () => { throw new Error("denied"); } } });
    const exec = vi.fn<(command: string) => boolean>(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    await copyText("b");
    expect(exec).toHaveBeenCalledWith("copy");
  });
});
