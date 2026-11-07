/**
 * 光标状态的外部存储。
 *
 * 编辑器每一次选区变化都汇报到这里，状态栏那两段（Line:Column 与缩进）
 * 各自用 useSyncExternalStore 订阅。不走 React state 的原因：App 的渲染树太大，
 * 每次按键为一个数字重渲染整棵树不值；订阅者只有状态栏小组件自己。
 */

/** 光标快照；line/col 都是 1 起的人话坐标 */
export interface CaretInfo {
  /** 光标所在文档路径 */
  path: string;
  /** 1 起的行号 */
  line: number;
  /** 1 起的列号 */
  col: number;
  /** 主选区字符数；空光标为 0 */
  selectedChars: number;
  /** 光标数（多光标时状态栏显示「N carets」而不是行列） */
  carets: number;
}

/** 当前快照；null 表示没有活动编辑器 */
let current: CaretInfo | null = null;
/** 订阅者集合；useSyncExternalStore 回调 */
const listeners = new Set<() => void>();

/**
 * 编辑器选区变化时汇报新快照。
 *
 * @param info - 最新的光标快照
 * @remarks 值没变就不惊动订阅者
 */
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

/**
 * 清掉指定路径文档的快照。
 *
 * @param path - 被关闭的文档路径
 * @remarks 该路径不是当前快照所属路径时不动作
 */
export function clearCaret(path: string): void {
  if (current?.path !== path) return;
  current = null;
  for (const notify of listeners) notify();
}

/**
 * 订阅光标变化（useSyncExternalStore 的订阅入口）。
 *
 * @param onChange - 快照变化时的回调
 * @returns 取消订阅函数
 */
export function subscribeCaret(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * 取当前快照（useSyncExternalStore 的快照入口）。
 *
 * @returns 最新光标快照；无活动编辑器返回 null
 */
export function caretSnapshot(): CaretInfo | null {
  return current;
}
