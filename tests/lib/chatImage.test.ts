import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { copyChatImage } from "../../src/lib/chatImage";

afterEach(() => {
  invoke.mockReset();
  vi.unstubAllGlobals();
});

describe("会话截图剪贴板", () => {
  it("点击后立即申请图片写入，读盘完成后交付 PNG", async () => {
    let finish!: (image: { mediaType: string; base64: string }) => void;
    invoke.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("ClipboardItem", class {
      constructor(readonly data: Record<string, Promise<Blob>>) {}
    });
    let copied!: Blob;
    const write = vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => { copied = await items[0].data["image/png"]; });
    vi.stubGlobal("navigator", { clipboard: { write } });
    const pending = copyChatImage("C:\\cache\\shot.png");
    expect(write).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("ai_runtime_read_image", { path: "C:\\cache\\shot.png" });
    finish({ mediaType: "image/png", base64: "iVBORw0KGgo=" });
    await pending;
    expect(copied.type).toBe("image/png");
    expect(new Uint8Array(await copied.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it("系统拒绝剪贴板时返回失败，不能假报复制成功", async () => {
    invoke.mockResolvedValue({ mediaType: "image/png", base64: "iVBORw0KGgo=" });
    vi.stubGlobal("ClipboardItem", class {});
    vi.stubGlobal("navigator", { clipboard: { write: vi.fn().mockRejectedValue(new Error("clipboard denied")) } });
    await expect(copyChatImage("C:\\cache\\shot.png")).rejects.toThrow("clipboard denied");
  });
});
