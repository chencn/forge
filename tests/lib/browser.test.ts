// 新增的地址输入与工作区持久化没有现有测试归属；验证公开行为，不断言组件结构。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_DEVICES, BROWSER_NETWORKS, browserAddress, browserDeviceId, browserDeviceOptions, browserNetworkId, browserPageOwner, copyBrowserScreenshot, DEFAULT_BROWSER_EMULATION, isRectOverlapping, loadBrowserLibrary, normalizeBrowserLibrary, rememberBrowserLocation, saveBrowserLibrary } from "../../src/lib/browser";

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("设备与网络模拟的公开设置", () => {
  it("选择手机只提交设备字段，保留已设置的慢速网络", () => {
    const options = browserDeviceOptions("iphone-13");
    const value = { ...DEFAULT_BROWSER_EMULATION, downloadMbps: 0.75, latencyMs: 400, ...options };
    expect(options).toEqual({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: expect.stringContaining("iPhone") });
    expect(value.downloadMbps).toBe(0.75);
    expect(value.latencyMs).toBe(400);
    expect(browserDeviceId(value)).toBe("iphone-13");
    expect(browserDeviceId({ ...value, width: value.height, height: value.width! })).toBe("iphone-13");
  });
  it("自适应只重置设备，非预设尺寸和网络显示自定义", () => {
    expect(browserDeviceOptions("responsive")).toEqual({ resetDevice: true });
    expect(browserDeviceId(DEFAULT_BROWSER_EMULATION)).toBe("responsive");
    expect(browserDeviceId({ ...DEFAULT_BROWSER_EMULATION, width: 777, height: 999 })).toBe("custom");
    expect(browserNetworkId({ ...DEFAULT_BROWSER_EMULATION, downloadMbps: 7 })).toBe("custom");
    expect(() => browserDeviceOptions("unknown")).toThrow("UNKNOWN_DEVICE");
  });
  it("预设网络可从真实状态恢复，设备字段不影响网络档位", () => {
    for (const { id, ...network } of BROWSER_NETWORKS) {
      expect(browserNetworkId({ ...DEFAULT_BROWSER_EMULATION, width: 390, ...network })).toBe(id);
    }
    for (const device of BROWSER_DEVICES) {
      expect(browserDeviceId({ ...DEFAULT_BROWSER_EMULATION, ...browserDeviceOptions(device.id) })).toBe(device.id);
    }
  });
});

describe("浏览器截图剪贴板", () => {
  it("点击后立即申请图片写入，截图就绪后交付 PNG 字节", async () => {
    let finish!: (dataUrl: string) => void;
    const screenshot = new Promise<string>((resolve) => { finish = resolve; });
    let copied!: Blob;
    vi.stubGlobal("ClipboardItem", class {
      constructor(readonly data: Record<string, Promise<Blob>>) {}
    });
    const write = vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => { copied = await items[0].data["image/png"]; });
    vi.stubGlobal("navigator", { clipboard: { write } });
    const pending = copyBrowserScreenshot(screenshot);
    expect(write).toHaveBeenCalledOnce();
    finish("data:image/png;base64,iVBORw0KGgo=");
    await pending;
    expect(copied.type).toBe("image/png");
    expect(new Uint8Array(await copied.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it("系统拒绝剪贴板时返回失败，不能假报复制成功", async () => {
    vi.stubGlobal("ClipboardItem", class {});
    vi.stubGlobal("navigator", { clipboard: { write: vi.fn().mockRejectedValue(new Error("clipboard denied")) } });
    await expect(copyBrowserScreenshot(Promise.resolve("data:image/png;base64,iVBORw0KGgo="))).rejects.toThrow("clipboard denied");
  });
});

describe("浏览器地址栏", () => {
  it.each([
    [" localhost:3000/login ", "http://localhost:3000/login"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/"],
    ["[::1]:5173", "http://[::1]:5173/"],
    ["192.168.1.20:8080/login", "http://192.168.1.20:8080/login"],
    ["localhost?preview=1", "http://localhost/?preview=1"],
    ["example.com/docs", "https://example.com/docs"],
    ["https://example.com/?q=中文", "https://example.com/?q=%E4%B8%AD%E6%96%87"],
    ["前端 调试", "https://www.bing.com/search?q=%E5%89%8D%E7%AB%AF%20%E8%B0%83%E8%AF%95"],
  ])("将 %s 解析为可导航地址", (input, expected) => expect(browserAddress(input)).toBe(expected));

  it.each(["", "file:///C:/secret", "javascript:alert(1)", "tauri://localhost", "https://user:secret@example.com", "http://", "localhost:bad"])("拒绝无效或特权输入 %s", (input) => {
    expect(() => browserAddress(input)).toThrow();
  });
});

describe("浏览器访问记录", () => {
  it("归一化不可信存储，去重并排除危险 URL", () => {
    const value = normalizeBrowserLibrary({ bookmarks: [
      { url: "https://example.com", title: "Example", visitedAt: 1 },
      { url: "https://example.com/", title: "duplicate", visitedAt: 2 },
      { url: "javascript:alert(1)", title: "bad" },
      { url: "https://name:password@example.com", title: "secret" },
      { url: "http://localhost:3000", title: "Preview", visitedAt: "bad" },
      null,
    ], recent: "invalid" });
    expect(value.bookmarks).toEqual([
      { url: "https://example.com/", title: "Example", visitedAt: 1 },
      { url: "http://localhost:3000/", title: "Preview", visitedAt: 0 },
    ]);
    expect(value.recent).toEqual([]);
  });

  it("重新访问更新标题和次序，最近记录保留 30 项", () => {
    const recent = Array.from({ length: 35 }, (_, i) => ({ url: `https://example.com/${i}`, title: String(i), visitedAt: i }));
    const location = { url: "https://example.com/9", title: "Updated title", visitedAt: 100 };
    const library = rememberBrowserLocation({ bookmarks: [], recent }, location);
    expect(library.recent).toHaveLength(30);
    expect(library.recent[0]).toEqual(location);
    expect(library.recent.filter((item) => item.url === location.url)).toHaveLength(1);
  });

  it("持久化按工作区隔离，并统一 Windows 路径拼写", () => {
    const library = { bookmarks: [{ url: "https://example.com/", title: "Example", visitedAt: 1 }], recent: [] };
    saveBrowserLibrary("C:\\Projects\\Demo", library);
    expect(loadBrowserLibrary("c:/projects/demo/")).toEqual(library);
    expect(loadBrowserLibrary("c:/projects/other")).toEqual({ bookmarks: [], recent: [] });
  });

  it("坏 JSON 和写入失败不影响浏览", () => {
    saveBrowserLibrary("workspace", { bookmarks: [], recent: [] });
    storage.set([...storage.keys()][0], "bad JSON");
    expect(loadBrowserLibrary("workspace")).toEqual({ bookmarks: [], recent: [] });
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } });
    expect(loadBrowserLibrary("workspace")).toEqual({ bookmarks: [], recent: [] });
    expect(() => saveBrowserLibrary("workspace", { bookmarks: [], recent: [] })).not.toThrow();
  });
});

describe("浏览器视口浮层空间相交检测", () => {
  const browserViewport = { left: 800, top: 32, right: 1400, bottom: 800 };

  it("左侧会话区域的右键菜单与右侧浏览器完全分离，不判定为相交", () => {
    // 模拟左侧会话气泡中右键弹出的菜单（x: 350, y: 200, 宽 244, 高 80）
    const leftSessionMenu = { left: 350, top: 200, right: 594, bottom: 280 };
    expect(isRectOverlapping(leftSessionMenu, browserViewport)).toBe(false);
  });

  it("覆盖在浏览器视口上的浮层判定为相交", () => {
    // 模态弹窗或落在浏览器区域内的弹出菜单
    const overlappingMenu = { left: 850, top: 100, right: 1050, bottom: 300 };
    expect(isRectOverlapping(overlappingMenu, browserViewport)).toBe(true);

    // 全屏遮罩层（0, 0 到 1920, 1080）
    const fullBackdrop = { left: 0, top: 0, right: 1920, bottom: 1080 };
    expect(isRectOverlapping(fullBackdrop, browserViewport)).toBe(true);
  });

  it("紧挨或相切边界不计为相交", () => {
    const tangentLeft = { left: 600, top: 32, right: 800, bottom: 800 };
    expect(isRectOverlapping(tangentLeft, browserViewport)).toBe(false);

    const tangentBottom = { left: 800, top: 800, right: 1400, bottom: 900 };
    expect(isRectOverlapping(tangentBottom, browserViewport)).toBe(false);
  });
});

describe("手动新页面的会话归属", () => {
  const sessions = [{ id: "claude-a" }, { id: "codex-b" }];

  it("归属正在投递的会话", () => {
    expect(browserPageOwner(sessions, "codex-b")).toBe("codex-b");
  });

  it("草稿、未知会话和空归属都保持私有，不因排序靠前而获得归属", () => {
    for (const target of ["draft", "imported-unknown", null]) {
      expect(browserPageOwner(sessions, target)).toBe("manual");
    }
  });

  it("私有归属不给任何会话默认操作权限", () => {
    expect(browserPageOwner([], "claude-a")).toBe("manual");
  });
});
