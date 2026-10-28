/** 用户界面的导航输入与本地访问记录，不存会话凭证或页面内容。 */
export interface BrowserLocation { url: string; title: string; visitedAt: number }
export interface BrowserLibrary { bookmarks: BrowserLocation[]; recent: BrowserLocation[] }

export interface BrowserElementSelection {
  selectionId: number;
  tabId: string;
  epoch: number;
  url: string;
  tag: string;
  selector: string;
  role: string;
  name: string;
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  styleChanges?: Record<string, { before: string; after: string }>;
}
export interface BrowserPicker { active: boolean; selection: BrowserElementSelection | null; error: string | null }

export interface BrowserEmulation {
  width: number | null; height: number; deviceScaleFactor: number; mobile: boolean; touch: boolean;
  userAgent: string; offline: boolean; latencyMs: number; downloadMbps: number; uploadMbps: number;
  colorScheme: "auto" | "light" | "dark";
}
export type BrowserEmulationPatch = Partial<Omit<BrowserEmulation, "width">> & { width?: number; reset?: boolean; resetDevice?: boolean };
export const DEFAULT_BROWSER_EMULATION: BrowserEmulation = { width: null, height: 800, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: "", offline: false, latencyMs: 0, downloadMbps: 0, uploadMbps: 0, colorScheme: "auto" };
const androidAgent = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const iphoneAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1";
const ipadAgent = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1";
interface BrowserDevice { id: string; group: "desktop" | "tablet" | "phone"; name: string; width: number; height: number; deviceScaleFactor: number; mobile: boolean; touch: boolean; userAgent: string }
export const BROWSER_DEVICES: readonly BrowserDevice[] = [
  ...[[1280,720],[1366,768],[1440,900],[1920,1080],[2560,1440]].map(([width,height]) => ({ id: `pc-${width}`, group: "desktop" as const, name: `${width} × ${height}`, width, height, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: "" })),
  { id: "ipad-mini", group: "tablet", name: "iPad mini", width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: ipadAgent },
  { id: "ipad-air", group: "tablet", name: "iPad Air", width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: ipadAgent },
  { id: "ipad-pro", group: "tablet", name: "iPad Pro 12.9″", width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: ipadAgent },
  { id: "android-tablet", group: "tablet", name: "Android 11″", width: 800, height: 1280, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: androidAgent.replace(" Mobile", "") },
  { id: "iphone-se", group: "phone", name: "iPhone SE", width: 375, height: 667, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: iphoneAgent },
  { id: "iphone-13", group: "phone", name: "iPhone 13 / 14", width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: iphoneAgent },
  { id: "iphone-15", group: "phone", name: "iPhone 15 / 16", width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: iphoneAgent },
  { id: "iphone-max", group: "phone", name: "iPhone Pro Max", width: 430, height: 932, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: iphoneAgent },
  { id: "pixel-8", group: "phone", name: "Pixel 8", width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: androidAgent },
  { id: "android-small", group: "phone", name: "Android 360", width: 360, height: 800, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: androidAgent },
];
export const BROWSER_NETWORKS = [
  { id: "online", offline: false, latencyMs: 0, downloadMbps: 0, uploadMbps: 0 },
  { id: "wifi", offline: false, latencyMs: 2, downloadMbps: 100, uploadMbps: 50 },
  { id: "5g", offline: false, latencyMs: 20, downloadMbps: 100, uploadMbps: 20 },
  { id: "4g", offline: false, latencyMs: 150, downloadMbps: 4, uploadMbps: 1 },
  { id: "3g", offline: false, latencyMs: 400, downloadMbps: 0.75, uploadMbps: 0.25 },
  { id: "2g", offline: false, latencyMs: 1000, downloadMbps: 0.25, uploadMbps: 0.05 },
  { id: "offline", offline: true, latencyMs: 0, downloadMbps: 0, uploadMbps: 0 },
] as const;

/** 切设备只发送设备字段，不能覆盖当前网络、主题或其他标签的状态。 */
export function browserDeviceOptions(id: string): BrowserEmulationPatch {
  if (id === "responsive") return { resetDevice: true };
  const device = BROWSER_DEVICES.find((item) => item.id === id);
  if (!device) throw new Error("UNKNOWN_DEVICE");
  const { width, height, deviceScaleFactor, mobile, touch, userAgent } = device;
  return { width, height, deviceScaleFactor, mobile, touch, userAgent };
}
export function browserDeviceId(value: BrowserEmulation): string {
  if (value.width === null) return "responsive";
  return BROWSER_DEVICES.find((item) => ((item.width === value.width && item.height === value.height) || (item.height === value.width && item.width === value.height)) && item.deviceScaleFactor === value.deviceScaleFactor && item.mobile === value.mobile && item.touch === value.touch && item.userAgent === value.userAgent)?.id ?? "custom";
}
export function browserNetworkId(value: BrowserEmulation): typeof BROWSER_NETWORKS[number]["id"] | "custom" {
  return BROWSER_NETWORKS.find((item) => item.offline === value.offline && item.latencyMs === value.latencyMs && item.downloadMbps === value.downloadMbps && item.uploadMbps === value.uploadMbps)?.id ?? "custom";
}

/** 点击时立即申请剪贴板写入，PNG 数据异步到达后再交给系统，保留用户手势。 */
export async function copyBrowserScreenshot(dataUrl: Promise<string>): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": dataUrl.then((url) => {
    const encoded = url.match(/^data:image\/png;base64,(.+)$/)?.[1];
    if (!encoded) throw new Error("INVALID_SCREENSHOT");
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: "image/png" });
  }) })]);
}

/** 元素上下文用 JSON 保留边界；页面文字只是引用数据，用户问题单独表达。 */
export function browserElementMessage(element: BrowserElementSelection, problem: string, includeCode = true): string {
  // 评论可选：用户可以直接把已选元素作为上下文发送，不代填修改要求。
  // 仅截图仍携带用户问题和页面地址，不附带选择器或样式。
  return JSON.stringify({ source: "Forge 浏览器元素标记", problem: problem.trim(), ...(includeCode ? { element } : { url: element.url, ...(element.styleChanges ? { styleChanges: element.styleChanges } : {}) }) }, null, 2);
}

export function browserAddress(input: string): string {
  const text = input.trim();
  if (!text) throw new Error("EMPTY_ADDRESS");
  const local = /^(localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\])(?=[:/?#]|$)/i.test(text);
  const host = /^(\[[\da-f:]+\]|[^\s/:]+\.[^\s/:]+)(:\d+)?([/?#]|$)/i.test(text);
  let value: string;
  if (/^https?:\/\//i.test(text)) value = text;
  else if (local || host) value = `${local ? "http" : "https"}://${text}`;
  else if (/^[a-z][a-z\d+.-]*:/i.test(text)) throw new Error("UNSUPPORTED_SCHEME");
  else return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
  const url = new URL(value);
  if (!url.hostname || url.username || url.password) throw new Error("INVALID_ADDRESS");
  return url.href;
}

export function normalizeBrowserLibrary(value: unknown): BrowserLibrary {
  const raw = value && typeof value === "object" ? value as Partial<BrowserLibrary> : {};
  const list = (items: unknown, limit: number): BrowserLocation[] => {
    if (!Array.isArray(items)) return [];
    const seen = new Set<string>();
    return items.flatMap((item) => {
      if (!item || typeof item.url !== "string" || typeof item.title !== "string") return [];
      try {
        const url = new URL(item.url);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || seen.has(url.href)) return [];
        seen.add(url.href);
        return [{ url: url.href, title: item.title.slice(0, 200), visitedAt: typeof item.visitedAt === "number" && Number.isFinite(item.visitedAt) ? item.visitedAt : 0 }];
      } catch { return []; }
    }).slice(0, limit);
  };
  return { bookmarks: list(raw.bookmarks, 40), recent: list(raw.recent, 30) };
}

export function rememberBrowserLocation(library: BrowserLibrary, location: BrowserLocation): BrowserLibrary {
  return normalizeBrowserLibrary({ ...library, recent: [location, ...library.recent.filter((entry) => entry.url !== location.url)] });
}

export function browserStorageKey(workspace: string): string {
  return `forge:browser-library:${workspace.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()}`;
}

export function loadBrowserLibrary(workspace: string): BrowserLibrary {
  try { return normalizeBrowserLibrary(JSON.parse(localStorage.getItem(browserStorageKey(workspace)) ?? "{}")); }
  catch { return { bookmarks: [], recent: [] }; }
}

export function saveBrowserLibrary(workspace: string, library: BrowserLibrary): void {
  // 隐私窗口或存储配额不足时，浏览仍然可用。
  try { localStorage.setItem(browserStorageKey(workspace), JSON.stringify(normalizeBrowserLibrary(library))); } catch { /* 本次内存记录继续有效。 */ }
}

export interface SimpleRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 判断两个矩形在几何空间上是否存在重叠相交。
 * 当且仅当两者在水平与垂直轴线上均有交集时才算相交，相切或分离均不算相交。
 */
export function isRectOverlapping(a: SimpleRect, b: SimpleRect): boolean {
  return !(
    a.right <= b.left ||
    a.left >= b.right ||
    a.bottom <= b.top ||
    a.top >= b.bottom
  );
}
