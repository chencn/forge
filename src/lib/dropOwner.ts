/**
 * 外部文件拖进窗口时，谁接手。
 *
 * Tauri 的 drag-drop 事件是窗口级的：工程侧原本把落进来的路径一律当成「打开文件 / 添加项目」。
 * 聊天输入框要的是「拖到这里 = 附加图片」，而且两者不能同时发生——同一次拖放既附加又打开就是重复动作。
 * 所以悬停中的目标先认领，没人认领才走原来的整窗路由。坐标已经换算成 CSS 像素。
 */
export interface DropOwner {
  /** 指针是否落在这个目标上（相对视口的 CSS 像素）。 */
  contains: (x: number, y: number) => boolean;
  /** 悬停状态变了：目标用它渲染自己的投放提示。 */
  hovered: (hovering: boolean) => void;
  /** 接手这批路径，只在 `contains` 命中时调用。 */
  take: (paths: string[]) => void;
}

export type DropPhase = "enter" | "over" | "drop" | "leave";

const owners: DropOwner[] = [];

/** 注册一个投放目标，返回注销函数。同一个目标重复注册会各自生效，调用方只该注册一次。 */
export function registerDropOwner(owner: DropOwner): () => void {
  owners.push(owner);
  return () => {
    const at = owners.indexOf(owner);
    if (at >= 0) owners.splice(at, 1);
  };
}

/**
 * 把一次 drag-drop 分派给悬停中的目标。
 *
 * 返回「是否被认领」：`enter`/`over` 时调用方据此决定要不要显示整窗提示，
 * `drop` 时据此决定还要不要把文件打开进工程。
 */
export function dispatchDrop(phase: DropPhase, paths: readonly string[], x: number, y: number): boolean {
  if (phase === "leave") {
    for (const candidate of owners) candidate.hovered(false);
    return false;
  }
  // 后注册的目标盖在先注册的之上：侧栏里的输入框优先于整窗路由。
  const owner = [...owners].reverse().find((candidate) => candidate.contains(x, y));
  // 落下的那一刻提示已经没意义了，所以 drop 一律熄灭，不再先点亮再收回。
  for (const candidate of owners) candidate.hovered(phase !== "drop" && candidate === owner);
  if (phase !== "drop" || !owner) return owner !== undefined;
  owner.take([...paths]);
  return true;
}

/**
 * Tauri 给的是相对 webview 的**物理**像素，`getBoundingClientRect()` 是 CSS 像素。
 * 换算系数取 `devicePixelRatio`；缩放变化后下一次事件就用新值，不需要缓存。
 */
export function dropPosition(position: { x: number; y: number }): { x: number; y: number } {
  const ratio = window.devicePixelRatio || 1;
  return { x: position.x / ratio, y: position.y / ratio };
}

/** 只有测试与调试用：当前注册了几个目标。 */
export function dropOwnerCount(): number {
  return owners.length;
}
