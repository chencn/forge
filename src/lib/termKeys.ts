import type { Terminal } from "@xterm/xterm";

export interface TermKeyActions {
  /** 读剪贴板并粘贴进终端（要不要先确认由它决定）。只读面板不给。 */
  paste?: () => void;
  /** 字号 +1 / -1；0 表示恢复默认字号。 */
  zoom?: (step: 1 | -1 | 0) => void;
  /** 在旁边拆一条：左右或上下。运行面板不分栏，不给。 */
  split?: (direction: "row" | "column") => void;
}

/**
 * 终端里的快捷键。xterm 只认一个自定义按键处理器，所以都放在这一处。
 *
 * - 有选区时 Ctrl/Cmd+C 复制，不发 SIGINT；Ctrl+Shift+C 总是复制。
 * - Ctrl/Cmd+V、Ctrl+Shift+V、Shift+Insert 走 `actions.paste`：要经过大段粘贴的确认，
 *   而且交给 xterm 的 `paste()`，程序开了括号粘贴时多行才不会被逐行执行。
 *   Windows 上 Ctrl+V 不拦的话，shell 收到的是字面上的 ^V。
 * - Ctrl/Cmd 加 `=` / `+` / `-` / `0` 缩放终端字号。这几个组合在 shell 里没有约定用途。
 * - Ctrl+Shift+5 左右拆分，Ctrl+Shift+- 上下拆分（和 VS Code 一样）。
 *
 * 拦下来的键都要 preventDefault + stopPropagation：返回 false 只挡住 xterm，
 * 事件照样冒泡，外面的快捷键（编辑器的折叠、工作台的缩放）会再处理一遍。
 */
export function attachTermKeys(term: Terminal, actions: TermKeyActions): void {
  const swallow = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    return false;
  };
  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.type !== "keydown") return true;
    const key = event.key.toLowerCase();
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey;

    if (mod && key === "c" && (event.shiftKey || term.hasSelection())) {
      const text = term.getSelection();
      if (!text) return !event.shiftKey;
      void navigator.clipboard.writeText(text).catch(() => {});
      return false;
    }

    const pasteKey = (mod && key === "v") || (event.shiftKey && !mod && key === "insert");
    if (pasteKey) {
      if (!actions.paste) return true;
      // 不让浏览器再发一次原生 paste 事件，否则 xterm 自己也会粘一遍。
      event.preventDefault();
      actions.paste();
      return false;
    }

    if (mod && event.shiftKey && (event.code === "Digit5" || event.code === "Minus")) {
      if (!actions.split) return true;
      actions.split(event.code === "Digit5" ? "row" : "column");
      return swallow(event);
    }

    if (mod && !event.shiftKey && (event.code === "Equal" || event.code === "NumpadAdd")) {
      if (!actions.zoom) return true;
      actions.zoom(1);
      return swallow(event);
    }
    if (mod && event.shiftKey && event.code === "Equal") {
      if (!actions.zoom) return true;
      actions.zoom(1);
      return swallow(event);
    }
    if (mod && !event.shiftKey && (event.code === "Minus" || event.code === "NumpadSubtract")) {
      if (!actions.zoom) return true;
      actions.zoom(-1);
      return swallow(event);
    }
    if (mod && !event.shiftKey && (event.code === "Digit0" || event.code === "Numpad0")) {
      if (!actions.zoom) return true;
      actions.zoom(0);
      return swallow(event);
    }
    return true;
  });
}
