/**
 * 光标状态的外部存储：编辑器每一次选区变化都汇报到这里，状态栏那两段
 * （Line:Column 与缩进）各自用 useSyncExternalStore 订阅。
 *
 * 不走 React state 的原因：App 的渲染树太大，每次按键为一个数字重渲染
 * 整棵树不值；订阅者只有状态栏小组件自己。
 */

/** 光标快照。line/col 都是 1 起的人话坐标。 */
export interface CaretInfo {
  path: string;
  line: number;
  col: number;
  /** 主选区字符数；空光标为 0。 */
  selectedChars: number;
  /** 光标数（多光标时状态栏显示「N carets」而不是行列）。 */
  carets: number;
}

let current: CaretInfo | null = null;
const listeners = new Set<() => void>();

/** 编辑器选区变化时汇报；值没变就不惊动订阅者。 */
export function reportCaret(info: CaretInfo): void {
  const prev = current;
  if (
    prev &&
    prev.path === info.path &&
    prev.line === info.line &&
    prev.col === info.col &&
    prev.selectedChars === info.selectedChars &&
    prev.carets === info.carets
  ) {
    return;
  }
  current = info;
  for (const notify of listeners) notify();
}

/** 该路径的文档被关掉时清掉它的快照，别让状态栏停在旧数字上。 */
export function clearCaret(path: string): void {
  if (current?.path !== path) return;
  current = null;
  for (const notify of listeners) notify();
}

/** useSyncExternalStore 的订阅入口。 */
export function subscribeCaret(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** useSyncExternalStore 的快照。 */
export function caretSnapshot(): CaretInfo | null {
  return current;
}
