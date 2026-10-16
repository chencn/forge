import type { TermSessionId } from "./term";

/** 面板插槽。终端实例不跟着面板拆，只把画面节点挪进挪出。 */
const slots = new Map<TermSessionId, HTMLElement>();
const slotWatchers = new Set<() => void>();

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

export function termSlot(id: TermSessionId): HTMLElement | null {
  return slots.get(id) ?? null;
}

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

/** 面板能对一条已经建好的终端下的命令。实例本身留在宿主里。 */
export interface TermControl {
  clear: () => void;
  findNext: (query: string) => void;
  findPrevious: (query: string) => void;
  focus: () => void;
  selection: () => string;
  hasSelection: () => boolean;
  paste: (text: string) => void;
}

const controls = new Map<TermSessionId, TermControl>();

export function registerTermControl(id: TermSessionId, control: TermControl): () => void {
  controls.set(id, control);
  return () => {
    if (controls.get(id) === control) controls.delete(id);
  };
}

export function termControl(id: TermSessionId): TermControl | null {
  return controls.get(id) ?? null;
}
