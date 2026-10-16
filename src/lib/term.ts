import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import { tokenColor } from "./color";

/** 后端分配的终端会话 id。 */
export type TermSessionId = string;

/** 一段 PTY 输出：`data` 是 base64，避免 JSON 拆坏半个 UTF-8 序列。 */
export interface TermChunk {
  /** 归属的会话 id，多会话时靠它分发。 */
  id: TermSessionId;
  /** base64 编码的原始字节。 */
  data: string;
}

/** 会话结束事件：shell 自己退出或被关闭。 */
export interface TermExit {
  id: TermSessionId;
  /** 退出码；取不到时为 null。 */
  code: number | null;
}

/** 后端扫出来的一个 shell：真实路径 + 界面上显示的名字。 */
export interface ShellInfo {
  /** 写回设置的值，也是起进程时真正执行的那条。 */
  path: string;
  /** 界面上的名字，例如 PowerShell、Git Bash。 */
  name: string;
}

/** 扫这台机器上装着的 shell；排在第一的就是没另行设置时起的那个。 */
export function shellProbe(): Promise<ShellInfo[]> {
  return invoke<ShellInfo[]>("shell_probe");
}

/** 起一个终端；cwd 为 null 时落在后端进程的当前目录，shell 为空时用系统默认。 */
export function termOpen(
  cwd: string | null,
  shell: string,
  cols: number,
  rows: number
): Promise<TermSessionId> {
  return invoke<TermSessionId>("term_open", { cwd, shell, cols, rows });
}

/** 键盘输入原样交给 PTY，行编辑由 shell 负责。 */
export function termWrite(id: TermSessionId, data: string): Promise<void> {
  return invoke<void>("term_write", { id, data });
}

/** 视口尺寸变了要同步给 PTY，否则 shell 的换行位置按旧列数算。 */
export function termResize(id: TermSessionId, cols: number, rows: number): Promise<void> {
  return invoke<void>("term_resize", { id, cols, rows });
}

export function termClose(id: TermSessionId): Promise<void> {
  return invoke<void>("term_close", { id });
}

/** 收掉上一回页面留下的终端；重载时那条 term_close 往往来不及送达。 */
export function termReap(): Promise<void> {
  return invoke<void>("term_reap");
}

let windowsBuild: Promise<number | undefined> | null = null;

/**
 * Windows 构建号，给 xterm 的 ConPTY 换行补救用。
 *
 * 构造终端时就要带上，所以调用方在 `new Terminal` 之前等它。非 Windows 或读失败都是 undefined。
 */
export function windowsBuildNumber(): Promise<number | undefined> {
  windowsBuild ??= invoke<number | null>("term_windows_build")
    .then((value) => value ?? undefined)
    .catch(() => undefined);
  return windowsBuild;
}

/** base64 → 字节数组，交给 xterm 自己增量解码 UTF-8。 */
export function decodeChunk(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** 终端配色：包含完整 ANSI 16 色与滚动条颜色，并针对深浅色模式分别调优。 */
export function terminalColors(isDark?: boolean): Record<string, string> {
  const dark =
    isDark ??
    (typeof document !== "undefined" &&
      document.documentElement.getAttribute("data-theme") === "dark");

  if (dark) {
    return {
      background: tokenColor("--bg-primary"),
      foreground: tokenColor("--text-primary"),
      cursor: tokenColor("--accent-blue"),
      selectionBackground: tokenColor("--selection-bg"),
      // 滚动条滑块取设计令牌，与代码区 monaco 滚动条一致
      scrollbarSliderBackground: tokenColor("--scrollbar-thumb"),
      scrollbarSliderHoverBackground: tokenColor("--scrollbar-thumb-hover"),
      scrollbarSliderActiveBackground: tokenColor("--scrollbar-thumb-active"),
      black: tokenColor("--text-muted"),
      red: "#f87171",
      green: "#4ade80",
      // 黄色系：解决用户在终端敲命令“黄色太浅看不清”问题。
      // xterm 默认 brightYellow 为 #fce94f（亮柠檬黄，在深色背景下严重泛白发虚）。
      // 这里采用温润饱满且轮廓鲜明的高对比度金黄/暖黄色（#e5c07b / #f3cc62），清晰舒适。
      yellow: "#e5c07b",
      // 夜间底是黑的，目录名是蓝底上的浅色字。这块底要深，浅了字会糊进去。
      blue: "#1e40af",
      magenta: "#c084fc",
      cyan: "#38bdf8",
      white: "#e5e7eb",
      brightBlack: "#6b7280",
      brightRed: "#ef4444",
      brightGreen: "#22c55e",
      brightYellow: "#f3cc62",
      // 蓝字落在黑底上，用浅色才看得见。
      brightBlue: "#93c5fd",
      brightMagenta: "#a855f7",
      brightCyan: "#06b6d4",
      brightWhite: "#f9fafb",
    };
  }

  // 浅色主题（白底）：高亮黄容易泛白隐形，加深为深琥珀黄/赭黄以保证 WCAG 对比度和可读性
  return {
    background: tokenColor("--bg-primary"),
    foreground: tokenColor("--text-primary"),
    cursor: tokenColor("--accent-blue"),
    selectionBackground: tokenColor("--selection-bg"),
    scrollbarSliderBackground: tokenColor("--scrollbar-thumb"),
    scrollbarSliderHoverBackground: tokenColor("--scrollbar-thumb-hover"),
    scrollbarSliderActiveBackground: tokenColor("--scrollbar-thumb-active"),
    black: "#1f2937",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#b45309",
    // 白天底是白的，目录名是蓝底上的深色字。这块底要浅，深了字会糊进去。
    blue: "#dbeafe",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#4b5563",
    brightBlack: "#4b5563",
    brightRed: "#b91c1c",
    brightGreen: "#15803d",
    brightYellow: "#92400e",
    // 蓝字落在白底上，用深色才看得见。
    brightBlue: "#1d4ed8",
    brightMagenta: "#7e22ce",
    brightCyan: "#0e7490",
    brightWhite: "#111827",
  };
}

export type NativeScrollPort = {
  /** 粘性容器：xterm 画在这里，滚动时不动。 */
  sticky: HTMLElement;
  /** 撑高度的占位节点，高度按回滚缓冲行数写入 style。 */
  spacer: HTMLElement;
};

export type NativeScrollBinding = {
  /** 排一次「视口 → 滚动条」同步（内部用 rAF 合帧）。 */
  sync: () => void;
  /** 解绑滚动 / 滚轮监听与 xterm 订阅。 */
  dispose: () => void;
};

/**
 * 在宿主里铺一层和代码区相同的原生滚动结构。
 * 画面放在 sticky 里不动，spacer 把可滚动高度撑到回滚缓冲那么高。
 */
export function mountNativeScrollPort(host: HTMLElement): NativeScrollPort {
  const sticky = document.createElement("div");
  sticky.className = "term-sticky";
  const spacer = document.createElement("div");
  spacer.className = "term-spacer";
  spacer.setAttribute("aria-hidden", "true");
  host.appendChild(sticky);
  host.appendChild(spacer);
  return { sticky, spacer };
}

/**
 * 把宿主的原生滚动位置和 xterm 视口对齐。
 * 滚轮停在捕获阶段，避免 xterm preventDefault 把浏览器的惯性滚动取消掉。
 * 备用屏和鼠标跟踪仍交给 xterm（vim / less 把滚轮当按键或鼠标上报）。
 */
export function bindNativeScroll(
  host: HTMLElement,
  spacer: HTMLElement,
  term: Terminal
): NativeScrollBinding {
  let applying = false;
  let queued: number | ReturnType<typeof setTimeout> = 0;
  /** 用户离开底部之后，新输出只加长滚屏，不再改视口。 */
  let awayFromTail = false;
  /** 上次由程序停在的底部行。用户从这里往上翻，才算离开底部。 */
  let placedTail = 0;

  const measureCellHeight = (): number => {
    const rows = term.rows || 0;
    if (rows < 1) return 0;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const canvas = screen ? screen.querySelector("canvas") : null;
    const styled = (el: HTMLElement | null): number => {
      if (!el) return 0;
      if (el.clientHeight > 0) return el.clientHeight;
      const parsed = parseFloat(el.style && el.style.height);
      return parsed > 0 ? parsed : 0;
    };
    const height =
      styled(screen) || styled(canvas) || styled(host.querySelector<HTMLElement>(".term-sticky"));
    if (height <= 0) return 0;
    return height / rows;
  };

  let cachedCell = 0;
  const cellHeight = (): number => (cachedCell > 0 ? cachedCell : measureCellHeight());

  const syncFromTerm = (): void => {
    if (applying) return;
    const cell = measureCellHeight();
    if (cell <= 0) return;
    cachedCell = cell;
    let maxLine = 0;
    let viewportY = 0;
    try {
      const buf = term.buffer.active;
      maxLine = Math.max(0, buf.baseY);
      viewportY = buf.viewportY;
    } catch {
      return;
    }
    const nextHeight = maxLine * cell;
    const tail = maxLine * cell;
    const line = Math.round(host.scrollTop / cell);
    // 输出回调可能排在滚动事件前面。滚动条已经离开上次停住的底部，就不要再拽回去。
    if (!awayFromTail && placedTail > 0 && line < placedTail - 1) awayFromTail = true;
    // 撑高会同步触发 scroll。这段里挡住，避免宿主还停在旧位置时把画面拉走。
    applying = true;
    try {
      if (spacer.style.height !== `${nextHeight}px`) spacer.style.height = `${nextHeight}px`;
      if (!awayFromTail) {
        if (viewportY < maxLine) term.scrollToBottom();
        if (Math.abs(host.scrollTop - tail) > 1) host.scrollTop = tail;
        placedTail = maxLine;
      } else if (Math.abs(line - viewportY) > 1) {
        // 人在看上面的日志。新行进了缓冲，视口留在用户停下的那一行。
        term.scrollToLine(Math.min(line, maxLine));
      }
    } catch {
      // 忽略已释放实例
    }
    applying = false;
  };

  const sync = (): void => {
    if (queued) return;
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(cb, 16);
    queued = raf(() => {
      queued = 0;
      syncFromTerm();
    });
  };

  const onHostScroll = (): void => {
    if (applying) return;
    const cell = cellHeight();
    if (cell <= 0) return;
    const line = Math.round(host.scrollTop / cell);
    let viewportY = 0;
    let maxLine = 0;
    try {
      const buf = term.buffer.active;
      viewportY = buf.viewportY;
      maxLine = Math.max(0, buf.baseY);
    } catch {
      return;
    }
    if (line >= maxLine - 1) {
      awayFromTail = false;
      placedTail = maxLine;
      if (viewportY >= maxLine - 1) return;
      applying = true;
      try {
        term.scrollToBottom();
      } catch {
        // 忽略已释放实例
      }
      applying = false;
      return;
    }
    awayFromTail = true;
    if (Math.abs(line - viewportY) <= 1) return;
    applying = true;
    try {
      term.scrollToLine(Math.min(line, maxLine));
    } catch {
      // 忽略已释放实例
    }
    applying = false;
  };

  const onWheel = (event: WheelEvent): void => {
    if (event.shiftKey) return;
    let passThrough = false;
    try {
      passThrough =
        term.buffer.active.type === "alternate" || term.modes.mouseTrackingMode !== "none";
    } catch {
      return;
    }
    if (passThrough) return;
    // 往上翻要在滚动事件之前记下来。输出回调若先跑，不能把视口拽回底部。
    if (event.deltaY < 0) awayFromTail = true;
    // 不 preventDefault：浏览器才能对这条宿主原生滚动条做平滑惯性滑动。
    // stopImmediatePropagation 阻止 xterm 内部截获并吞噬滚轮。
    event.stopImmediatePropagation();
  };

  host.addEventListener("scroll", onHostScroll, { passive: true });
  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  const scrollSub = term.onScroll(() => sync());
  const parsedSub = term.onWriteParsed(() => sync());

  return {
    sync,
    dispose() {
      if (queued) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(queued as number);
        else clearTimeout(queued as ReturnType<typeof setTimeout>);
      }
      queued = 0;
      host.removeEventListener("scroll", onHostScroll);
      host.removeEventListener("wheel", onWheel, { capture: true });
      try {
        scrollSub.dispose();
        parsedSub.dispose();
      } catch {
        // 忽略
      }
    },
  };
}
