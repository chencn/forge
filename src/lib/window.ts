import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const win = getCurrentWindow();

/**
 * 这个窗口的标签。
 *
 * 语言服务按它分会话身份：两个窗口开同一个工程各留一份进程，
 * 因为后端的 `lsp://message` 是全窗口广播，共用一条管道会把 JSON-RPC 的请求号串到别的窗口。
 */
export const windowLabel = win.label;

export type ThemeMode = "light" | "dark" | "system";

/**
 * 托盘菜单那两项的文字。
 *
 * 菜单是系统画的，走不了界面那套 i18n，只能由前端把当前语言的文案推进去。
 */
export function setTrayLabels(show: string, quit: string): Promise<void> {
  return invoke<void>("tray_labels", { show, quit }).catch(() => {});
}

/** 该存的存完了，让后端真退出去。 */
export function appExit(): Promise<void> {
  return invoke<void>("app_exit");
}

/**
 * 监听原生窗口失去焦点（Tauri 窗口切到后台或其它程序时触发；纯浏览器下静默忽略）。
 *
 * WebView2 在无边框窗口（decorations=false）下切走焦点时，DOM 的 window.blur
 * 未必每次都按时派发，把宿主层的焦点事件一起接上才能兜住所有切窗口场景。
 */
export function onWindowBlur(handler: () => void): () => void {
  let disposed = false;
  const unlisten = win
    .onFocusChanged(({ payload: focused }) => {
      if (!disposed && !focused) handler();
    })
    .catch(() => null);
  return () => {
    disposed = true;
    void unlisten.then((off) => off?.()).catch(() => {});
  };
}

/**
 * 监听原生窗口重新获得焦点（从后台切回前台时触发；对齐 IDEA 的 Frame Activation 机制）。
 *
 * 结合 Tauri 的 onFocusChanged 与 DOM 的 window.focus，确保切回窗口时可靠唤醒。
 */
export function onWindowFocus(handler: () => void): () => void {
  let disposed = false;
  const unlisten = win
    .onFocusChanged(({ payload: focused }) => {
      if (!disposed && focused) handler();
    })
    .catch(() => null);

  const onDomFocus = () => {
    if (!disposed) handler();
  };
  window.addEventListener("focus", onDomFocus);

  return () => {
    disposed = true;
    window.removeEventListener("focus", onDomFocus);
    void unlisten.then((off) => off?.()).catch(() => {});
  };
}

/** 把模式解析成实际生效的深浅色。 */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return mode === "dark" || (mode === "system" && prefersDark) ? "dark" : "light";
}

/** 自定义标题栏的三个窗口动作，decorations=false 后由前端自己画。 */
export function useWindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    // 在纯浏览器里跑（没有 Tauri 注入）时这些调用会拒绝，忽略即可，界面照常可用。
    void win
      .isMaximized()
      .then((value) => {
        if (!disposed) setMaximized(value);
      })
      .catch(() => {});
    const unlisten = win.onResized(() => {
      void win.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const minimize = useCallback(() => void win.minimize().catch(() => {}), []);
  const toggleMaximize = useCallback(() => void win.toggleMaximize().catch(() => {}), []);
  const dismiss = useCallback(() => void win.close().catch(() => {}), []);

  return { maximized, minimize, toggleMaximize, dismiss };
}
