// @vitest-environment jsdom
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { attachMinimapPointer } from "../../src/lib/cm/minimapPointer";

/**
 * 小地图的手势：点框外跳一块、点框里只准备拖、按住拖连续滚。
 *
 * 这里量不到排版，矩形一律用替身给：画布 300px 高，视口框 30px，滚动区 3000/300。
 * 于是「框上 1px = 正文 10px」，预期落点都能手算。
 */
const SURFACE_TOP = 100;
const SURFACE_HEIGHT = 300;
const THUMB_HEIGHT = 30;
const CLIENT_HEIGHT = 300;
const SCROLL_HEIGHT = 3000;

function box(top: number, height: number): DOMRect {
  return { top, left: 0, bottom: top + height, right: 200, width: 200, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function mount() {
  const scroller = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(scroller, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
      scroller.dispatchEvent(new Event("scroll"));
    },
  });
  Object.defineProperty(scroller, "scrollHeight", { get: () => SCROLL_HEIGHT });
  Object.defineProperty(scroller, "clientHeight", { get: () => CLIENT_HEIGHT });

  const dispatch = vi.fn();
  const focus = vi.fn();
  const selections = { head: 0 };
  const view = {
    scrollDOM: scroller,
    lineBlockAtHeight: (height: number) => ({ from: Math.min(Math.max(0, Math.round(height)), 4000) }),
    state: {
      doc: { lineAt: (pos: number) => ({ from: pos, number: pos + 1 }) },
      selection: { main: selections },
    },
    dispatch: (spec: { selection: { anchor: number } }) => {
      selections.head = spec.selection.anchor;
      dispatch(spec);
    },
    focus,
  };

  const host = document.createElement("div");
  const surface = document.createElement("div");
  surface.className = "cm-minimap-inner";
  const overlay = document.createElement("div");
  overlay.className = "cm-minimap-overlay";
  surface.appendChild(overlay);
  host.appendChild(surface);
  document.body.appendChild(host);

  surface.getBoundingClientRect = () => box(SURFACE_TOP, SURFACE_HEIGHT);
  overlay.getBoundingClientRect = () => box(SURFACE_TOP + Number.parseFloat(overlay.style.top || "0"), THUMB_HEIGHT);

  const capture = new Set<number>();
  const typed = host as unknown as {
    setPointerCapture: (id: number) => void;
    hasPointerCapture: (id: number) => boolean;
    releasePointerCapture: (id: number) => void;
  };
  typed.setPointerCapture = (id) => capture.add(id);
  typed.hasPointerCapture = (id) => capture.has(id);
  typed.releasePointerCapture = (id) => capture.delete(id);

  attachMinimapPointer(host, view as unknown as EditorView);

  const fire = (type: string, clientY: number) =>
    host.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY }));

  return { scroller, dispatch, focus, selections, fire };
}

describe("小地图手势", () => {
  it("点视口框外：按「框上 1px = 正文 10px」把那一块滚到视口中间，光标落到中心行", () => {
    const { scroller, dispatch, focus, fire } = mount();
    // 框在画布最上面（0–30），点在 240：离框心（15）有 225px。
    fire("pointerdown", SURFACE_TOP + 240);
    fire("pointerup", SURFACE_TOP + 240);

    expect(scroller.scrollTop).toBe(2250);
    expect(dispatch).toHaveBeenCalledWith({ selection: { anchor: 2400 } });
    expect(focus).toHaveBeenCalled();
  });

  it("点视口框里：只准备拖，不跳也不动光标", () => {
    const { scroller, dispatch, fire } = mount();
    fire("pointerdown", SURFACE_TOP + 10);
    fire("pointerup", SURFACE_TOP + 10);

    expect(scroller.scrollTop).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("按住拖：从框里往下拖 50px，正文滚 500px；抬手后再动不再滚", () => {
    const { scroller, fire } = mount();
    fire("pointerdown", SURFACE_TOP + 10);
    fire("pointermove", SURFACE_TOP + 35);
    expect(scroller.scrollTop).toBe(250);
    fire("pointermove", SURFACE_TOP + 60);
    expect(scroller.scrollTop).toBe(500);
    fire("pointerup", SURFACE_TOP + 60);
    fire("pointermove", SURFACE_TOP + 200);
    expect(scroller.scrollTop).toBe(500);
  });

  it("拖到超出末尾时收在最大滚动量上", () => {
    const { scroller, fire } = mount();
    fire("pointerdown", SURFACE_TOP + 10);
    fire("pointermove", SURFACE_TOP + 300);
    expect(scroller.scrollTop).toBe(SCROLL_HEIGHT - CLIENT_HEIGHT);
  });
});
