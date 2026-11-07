import type { TermSessionId } from "./term";

/** 面板插槽。终端实例不跟着面板拆，只把画面节点挪进挪出。 */
const slots = new Map<TermSessionId, HTMLElement>();
/** 插槽变化订阅者（面板挂载/卸载时触发重渲染）。 */
const slotWatchers = new Set<() => void>();

/** 通知所有插槽订阅者。 */
function notifySlots() {
  for (const watch of slotWatchers) watch();
}

/** 面板上的那一块空位。同一条会话同时只认最后一个插槽。 */
export function registerTermSlot(id: TermSessionId, element: HTMLElement): () => void {
  slots.set(id, element);
  notifySlots();
  return () => {
    if (slots.get(id) !== element) return;
    slots.delete(id);
    notifySlots();
  };
}

/** 取会话当前所在的面板插槽；不在任何面板返回 null。 */
export function termSlot(id: TermSessionId): HTMLElement | null {
  return slots.get(id) ?? null;
}

/** 订阅插槽变化；返回退订函数。 */
export function watchTermSlots(watch: () => void): () => void {
  slotWatchers.add(watch);
  return () => {
    slotWatchers.delete(watch);
  };
}

/** 面板收起时画面停在这里：固定尺寸、移出视口，不参与布局。 */
export function termPark(): HTMLElement {
  const existing = document.querySelector<HTMLElement>("[data-term-park]");
  if (existing) return existing;
  const park = document.createElement("div");
  park.setAttribute("data-term-park", "");
  park.className = "term-park";
  park.setAttribute("aria-hidden", "true");
  document.body.appendChild(park);
  return park;
}

/** 终端查找的匹配选项。 */
export interface TermFindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** 当前匹配是第几个（从 1 起，0 表示没有当前项）、一共几个。 */
export interface TermFindResults {
  index: number;
  count: number;
}

/** 面板能对一条已经建好的终端下的命令。实例本身留在宿主里。 */
export interface TermControl {
  clear: () => void;
  /** `incremental` 时从当前匹配原地重找，边打字边找用它，免得每敲一个字跳到下一个。 */
  findNext: (query: string, options: TermFindOptions, incremental?: boolean) => void;
  findPrevious: (query: string, options: TermFindOptions) => void;
  /** 关掉查找：去掉全部高亮。 */
  clearFind: () => void;
  /** 订阅匹配计数；返回退订函数。 */
  watchFind: (watch: (results: TermFindResults) => void) => () => void;
  focus: () => void;
  selection: () => string;
  hasSelection: () => boolean;
  paste: (text: string) => void;
  /** 整段滚屏的纯文本，软换行接回成一行。 */
  text: () => string;
}

/** 各会话已注册的控制句柄（会话销毁时注销）。 */
const controls = new Map<TermSessionId, TermControl>();

/** 注册会话的控制句柄；返回注销函数。 */
export function registerTermControl(id: TermSessionId, control: TermControl): () => void {
  controls.set(id, control);
  return () => {
    if (controls.get(id) === control) controls.delete(id);
  };
}

/** 取会话的控制句柄；未注册返回 null。 */
export function termControl(id: TermSessionId): TermControl | null {
  return controls.get(id) ?? null;
}

/** 页签栏上的放大镜和面板里的 Ctrl+F 是两个组件，靠这个通知面板打开查找框。 */
const findRequests = new Set<() => void>();

/** 广播「打开终端查找框」的请求。 */
export function requestTermFind(): void {
  for (const open of findRequests) open();
}

/** 订阅查找框打开请求；返回退订函数。 */
export function watchTermFindRequests(open: () => void): () => void {
  findRequests.add(open);
  return () => {
    findRequests.delete(open);
  };
}
