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

/** 后端扫出来的一个 shell。 */
export interface ShellInfo {
  /** 写回设置、会话记着的值。多数就是路径；WSL 发行版共用 wsl.exe，写成 `wsl:<发行版>`。 */
  id: string;
  /** 起进程时真正执行的那条。 */
  path: string;
  /** 界面上的名字，例如 PowerShell、Git Bash、WSL: Ubuntu。 */
  name: string;
  /** 起进程时附带的参数。 */
  args: string[];
}

/** 扫这台机器上装着的 shell；排在第一的就是没另行设置时起的那个。 */
export function shellProbe(): Promise<ShellInfo[]> {
  return invoke<ShellInfo[]>("shell_probe");
}

/** 起一个终端；cwd 为 null 时落在后端进程的当前目录，shell 为空时用系统默认。 */
/** 配置档带来的额外参数与环境变量；值为空串的变量会被摘掉。 */
export interface TermLaunch {
  args: string[];
  env: Record<string, string>;
}

export function termOpen(
  cwd: string | null,
  shell: string,
  cols: number,
  rows: number,
  launch?: TermLaunch
): Promise<TermSessionId> {
  return invoke<TermSessionId>("term_open", { cwd, shell, cols, rows, launch: launch ?? null });
}

/** 各工作区根的页签布局，内容由 `termLayout.ts` 定义。读不到给空表。 */
export function termLayoutLoad(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("term_layout_load").catch(() => ({}));
}

export function termLayoutSave(layout: Record<string, unknown>): Promise<void> {
  return invoke<void>("term_layout_save", { layout }).catch(() => {});
}

/** 键盘输入原样交给 PTY，行编辑由 shell 负责。 */
export function termWrite(id: TermSessionId, data: string): Promise<void> {
  return invoke<void>("term_write", { id, data });
}

/** 不是 UTF-8 的输入（老式鼠标上报）按字节原样写进 PTY。 */
export function termWriteBytes(id: TermSessionId, data: string): Promise<void> {
  const bytes = Array.from(data, (char) => char.charCodeAt(0) & 0xff);
  return invoke<void>("term_write_bytes", { id, data: bytes });
}

/** 画不过来时让后端停读，追上了再放开。 */
export function termSetPaused(id: TermSessionId, paused: boolean): Promise<void> {
  return invoke<void>("term_set_paused", { id, paused });
}

/**
 * 视口尺寸变了要同步给 PTY，否则 shell 的换行位置按旧列数算。
 * 像素尺寸给按像素排版的程序（图片协议、部分 TUI）用，不知道时传 0。
 */
export function termResize(
  id: TermSessionId,
  cols: number,
  rows: number,
  pixelWidth = 0,
  pixelHeight = 0
): Promise<void> {
  return invoke<void>("term_resize", { id, cols, rows, pixelWidth, pixelHeight });
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
  /** 回到最底，并继续让新输出带着画面和滚动条走。 */
  follow: () => void;
  /** 现在是否跟着尾部（新输出会带着画面走）。 */
  following: () => boolean;
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
  term: Terminal,
  /** 跟随状态变了就说一声：面板靠它决定要不要显示「跳到最新」。 */
  onFollowChange?: (following: boolean) => void
): NativeScrollBinding {
  let applying = false;
  let queued: number | ReturnType<typeof setTimeout> = 0;
  /** 用户把滚动条离开底部之后，新输出不再改画面，也不改滚动条位置。 */
  let awayFromTail = false;

  /** 改「是否离开尾部」只走这一处，顺带把变化报给面板。 */
  const setAway = (value: boolean): void => {
    if (awayFromTail === value) return;
    awayFromTail = value;
    onFollowChange?.(!value);
  };

  const boxHeight = (el: HTMLElement | null): number => {
    if (!el) return 0;
    if (el.clientHeight > 0) return el.clientHeight;
    const parsed = parseFloat(el.style && el.style.height);
    return parsed > 0 ? parsed : 0;
  };

  const measureCellHeight = (): number => {
    const rows = term.rows || 0;
    if (rows < 1) return 0;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const canvas = screen?.querySelector("canvas") ?? host.querySelector("canvas");
    const sticky = host.querySelector<HTMLElement>(".term-sticky");
    const slot = host.querySelector<HTMLElement>(".term-slot");
    const height = boxHeight(screen) || boxHeight(canvas) || boxHeight(slot) || boxHeight(sticky);
    if (height > 0) return height / rows;
    // 画面还没排上尺寸时，用字号撑出滚动范围，避免进度条一直停在开头。
    const fontSize = Number(term.options.fontSize) || 12;
    const lineHeight = Number(term.options.lineHeight) || 1;
    return fontSize * (lineHeight > 0 ? lineHeight : 1);
  };

  const maxScrollTop = (): number => Math.max(0, host.scrollHeight - host.clientHeight);

  const atBottom = (): boolean => {
    const max = maxScrollTop();
    return max <= 1 || host.scrollTop >= max - 2;
  };

  const pinHostToBottom = (): void => {
    const max = maxScrollTop();
    if (Math.abs(host.scrollTop - max) > 1) host.scrollTop = max;
  };

  const readBuffer = (): { maxLine: number; viewportY: number } | null => {
    try {
      const buf = term.buffer.active;
      return { maxLine: Math.max(0, buf.baseY), viewportY: buf.viewportY };
    } catch {
      return null;
    }
  };

  const syncFromTerm = (): void => {
    if (applying) return;
    const cell = measureCellHeight();
    if (cell <= 0) return;
    const lines = readBuffer();
    if (!lines) return;
    // 滚轮已经记了「离开底部」，但这一下其实没滚开（人还停在尾部）。继续跟随。
    if (awayFromTail && atBottom()) setAway(false);
    // 撑高会同步触发 scroll。这段里挡住，避免宿主还停在旧位置时把画面拉走。
    applying = true;
    try {
      const nextHeight = `${lines.maxLine * cell}px`;
      if (spacer.style.height !== nextHeight) spacer.style.height = nextHeight;
      if (!awayFromTail) {
        if (lines.viewportY < lines.maxLine) term.scrollToBottom();
        // 先读 scrollHeight，把刚写上的 spacer 高度算进可滚动范围，再落到真正的底部。
        // 用行高估出来的尾部会被夹在旧的最大值上，进度条就停在原地。
        void host.scrollHeight;
        pinHostToBottom();
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

  const follow = (): void => {
    setAway(false);
    try {
      term.scrollToBottom();
    } catch {
      // 忽略已释放实例
    }
    syncFromTerm();
  };

  const onHostScroll = (): void => {
    if (applying) return;
    const cell = measureCellHeight();
    if (cell <= 0) return;
    const lines = readBuffer();
    if (!lines) return;
    if (atBottom()) {
      setAway(false);
      if (lines.viewportY >= lines.maxLine) return;
      applying = true;
      try {
        term.scrollToBottom();
      } catch {
        // 忽略已释放实例
      }
      applying = false;
      return;
    }
    setAway(true);
    const line = Math.min(lines.maxLine, Math.max(0, Math.round(host.scrollTop / cell)));
    if (Math.abs(line - lines.viewportY) <= 1) return;
    applying = true;
    try {
      term.scrollToLine(line);
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
    // 已经在最上面时再往上滑不会动滚动条，不能因此停掉跟随。
    if (event.deltaY < 0 && host.scrollTop > 1) setAway(true);
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
    follow,
    following: () => !awayFromTail,
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
