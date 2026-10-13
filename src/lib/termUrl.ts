import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { openExternal } from "./fs";

/** 匹配行内常见 http/https 链接候选串 */
const URL_PATTERN = /https?:\/\/[^\s<>"'{}|\\^`[\]]+/gi;

/** 匹配末尾常见的标点字符（英文及全角标点） */
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?'"“”‘’`，。；：！？]$/;

/** 括号配对定义，用于判断末尾闭括号是否属于外部嵌套包裹 */
const BRACKET_PAIRS = [
  { open: "(", close: ")" },
  { open: "[", close: "]" },
  { open: "{", close: "}" },
  { open: "（", close: "）" },
  { open: "【", close: "】" },
];

/**
 * 清除 URL 末尾由于文本排版产生的标点符号。
 *
 * 如果括号在 URL 内部成对闭合（例如维基百科条目 `https://en.wikipedia.org/wiki/C_(programming_language)`），
 * 则保留末尾闭括号；若闭括号数量多于开括号（如 `(http://localhost:3000)`），则剥离最外层闭括号。
 */
export function cleanTrailingPunctuation(raw: string): string {
  let cleaned = raw;

  while (TRAILING_PUNCTUATION_REGEX.test(cleaned)) {
    cleaned = cleaned.slice(0, -1);
  }

  for (const pair of BRACKET_PAIRS) {
    while (cleaned.endsWith(pair.close)) {
      const openCount = cleaned.split(pair.open).length - 1;
      const closeCount = cleaned.split(pair.close).length - 1;
      if (closeCount > openCount) {
        cleaned = cleaned.slice(0, -1);
      } else {
        break;
      }
    }
  }

  while (TRAILING_PUNCTUATION_REGEX.test(cleaned)) {
    cleaned = cleaned.slice(0, -1);
  }

  return cleaned;
}

/** 提取出的一个 URL 及对应的终端单元格列范围（1-based 闭区间） */
export interface ExtractedTerminalUrl {
  url: string;
  startCol: number;
  endCol: number;
}

/**
 * 从 xterm 的 IBufferLine 提取纯文本内容以及字符下标到终端单元格列号的映射表。
 *
 * 终端中的中文字符与全角标点通常占用 2 个 cell（宽字符），第二列宽为 0。
 * 构建映射表能够确保中英混排时 URL 的下划线和高亮位置与字符严格对齐。
 */
export function extractLineWithColMapping(line: IBufferLine): {
  text: string;
  charToCol: number[];
} {
  let text = "";
  const charToCol: number[] = [];
  const len = line.length;

  for (let col = 0; col < len; col += 1) {
    const cell = line.getCell(col);
    if (!cell) break;
    // 宽字符后半部分宽为 0，不对应新的独立字符
    if (cell.getWidth() === 0) {
      continue;
    }
    const chars = cell.getChars();
    if (!chars) {
      text += " ";
      charToCol.push(col + 1);
    } else {
      text += chars;
      for (let i = 0; i < chars.length; i += 1) {
        charToCol.push(col + 1);
      }
    }
  }

  const trimmedText = text.trimEnd();
  return {
    text: trimmedText,
    charToCol: charToCol.slice(0, trimmedText.length),
  };
}

/**
 * 在给定的纯文本和列坐标映射中，找出所有合法的 URL 及其在终端中的 1-based 列区间。
 */
export function findUrlsInText(text: string, charToCol: number[]): ExtractedTerminalUrl[] {
  const results: ExtractedTerminalUrl[] = [];
  const regex = new RegExp(URL_PATTERN.source, "gi");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const startIndex = match.index;
    const cleaned = cleanTrailingPunctuation(raw);
    if (!cleaned) continue;

    const startChar = startIndex;
    const endChar = startIndex + cleaned.length - 1;

    if (startChar < charToCol.length && endChar < charToCol.length) {
      results.push({
        url: cleaned,
        startCol: charToCol[startChar],
        endCol: charToCol[endChar],
      });
    }
  }

  return results;
}

/**
 * 判断传入的字符串是否为标准的 http/https 链接。
 */
export function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export interface TerminalUrlOptions {
  /** 自定义打开链接的处理函数，默认调用系统外部浏览器打开 */
  onOpenUrl?: (url: string) => void;
}

/**
 * 为 xterm 实例装配 URL 链接识别与交互系统：
 * 1. 自动高亮识别行内的 URL 并在鼠标悬停时展示手型与下划线；
 * 2. 直接单击时在系统默认浏览器中打开该 URL；
 * 3. 鼠标划选、拖拽时禁止触发打开，保障用户选区完整；
 * 4. 选中文本后按 Ctrl+C (Windows/Linux) 或 Cmd+C (macOS) 自动复制选中文本到剪贴板，
 *    避免误发中断信号终止前台进程。
 */
export function attachTerminalUrls(
  term: Terminal,
  options?: TerminalUrlOptions
): { dispose: () => void } {
  const openUrl = options?.onOpenUrl ?? ((url: string) => {
    void openExternal(url).catch(() => {});
  });

  // 记录鼠标按下时的坐标，用于区分“纯点击”与“划选拖拽”
  let lastMouseDownX = 0;
  let lastMouseDownY = 0;

  const onMouseDown = (event: MouseEvent) => {
    lastMouseDownX = event.clientX;
    lastMouseDownY = event.clientY;
  };

  // 在终端 DOM 元素上挂载鼠标按下监听
  let element: HTMLElement | null = term.element ?? null;
  const ensureElementListener = () => {
    if (!element && term.element) {
      element = term.element;
      element.addEventListener("mousedown", onMouseDown, true);
    }
  };
  if (element) {
    element.addEventListener("mousedown", onMouseDown, true);
  }

  // 注册 xterm 链接提供器
  const linkProvider: ILinkProvider = {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
      ensureElementListener();
      const buffer = term.buffer.active;
      const line = buffer.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const { text, charToCol } = extractLineWithColMapping(line);
      if (!text.includes("http://") && !text.includes("https://")) {
        callback(undefined);
        return;
      }

      const foundUrls = findUrlsInText(text, charToCol);
      if (foundUrls.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = foundUrls.map((item) => ({
        text: item.url,
        range: {
          start: { x: item.startCol, y: bufferLineNumber },
          end: { x: item.endCol, y: bufferLineNumber },
        },
        decorations: {
          pointerCursor: true,
          underline: true,
        },
        activate(event: MouseEvent, text: string) {
          // 只允许鼠标左键点击打开
          if (event.button !== 0) return;

          // 若终端当前存在非空选区，说明用户正在进行选择操作，绝不触发打开
          if (term.hasSelection() && term.getSelection().length > 0) {
            return;
          }

          // 若页面有全局选区，同样视为选择操作
          const selection = window.getSelection()?.toString() ?? "";
          if (selection.trim().length > 0) {
            return;
          }

          // 鼠标拖拽位移超过 4px 视为划选，不触发打开
          const moved = Math.hypot(
            event.clientX - lastMouseDownX,
            event.clientY - lastMouseDownY
          );
          if (moved > 4) {
            return;
          }

          // 纯单击：唤起默认浏览器打开链接
          openUrl(text);
        },
      }));

      callback(links);
    },
  };

  const linkDisposable = term.registerLinkProvider(linkProvider);

  // 选中文本时按 Ctrl+C / Cmd+C 自动复制选中文本
  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    const isCopyKey =
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "c";

    if (isCopyKey && event.type === "keydown") {
      if (term.hasSelection()) {
        const text = term.getSelection();
        if (text) {
          void navigator.clipboard.writeText(text).catch(() => {});
          // 拦截该按键事件，防止向 shell 发送 SIGINT 中断字符，并保留当前选区
          return false;
        }
      }
    }
    return true;
  });

  return {
    dispose: () => {
      linkDisposable.dispose();
      if (element) {
        element.removeEventListener("mousedown", onMouseDown, true);
        element = null;
      }
    },
  };
}
