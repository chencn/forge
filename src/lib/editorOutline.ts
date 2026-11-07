/** 两处面包屑共享同一份编辑器大纲；光标移动只通知小组件，不重渲染 App。 */
export interface OutlineSymbol {
  name: string;
  kind: "function" | "method" | "class" | "interface" | "type" | "variable" | "property" | "enum" | "namespace";
  from: number;
  to: number;
  selectionFrom: number;
  children: OutlineSymbol[];
}

/** 一份大纲快照：符号树 + 光标所在位置。 */
export interface OutlineSnapshot {
  items: readonly OutlineSymbol[];
  position: number;
}

/** 无大纲时的空快照（共享单例）。 */
const EMPTY: OutlineSnapshot = { items: [], position: 0 };
/** 每个文件路径的最新快照。 */
const snapshots = new Map<string, OutlineSnapshot>();
/** 每个文件路径的订阅者。 */
const listeners = new Map<string, Set<() => void>>();

/** 取文件的大纲快照；没有返回空快照。 */
export function outlineSnapshot(path: string): OutlineSnapshot {
  return snapshots.get(path) ?? EMPTY;
}

/** 订阅文件的大纲变化；返回退订函数。 */
export function subscribeOutline(path: string, notify: () => void): () => void {
  let set = listeners.get(path);
  if (!set) listeners.set(path, set = new Set());
  set.add(notify);
  return () => {
    set.delete(notify);
    if (!set.size) listeners.delete(path);
  };
}

/** 上报新的大纲（items/position 都没变时跳过通知）。 */
export function reportOutline(path: string, items: readonly OutlineSymbol[], position: number): void {
  const previous = snapshots.get(path);
  if (previous?.items === items && previous.position === position) return;
  snapshots.set(path, { items, position });
  for (const notify of listeners.get(path) ?? []) notify();
}

/** 清掉文件的大纲（文档关闭时）。 */
export function clearOutline(path: string): void {
  if (!snapshots.delete(path)) return;
  for (const notify of listeners.get(path) ?? []) notify();
}

/** 逐层找包含光标的范围，按从外到内排列。 */
export function symbolChain(items: readonly OutlineSymbol[], position: number): OutlineSymbol[] {
  const chain: OutlineSymbol[] = [];
  let level = items;
  for (;;) {
    const hit = level.find((item) => item.from <= position && position <= item.to);
    if (!hit) return chain;
    chain.push(hit);
    level = hit.children;
  }
}
