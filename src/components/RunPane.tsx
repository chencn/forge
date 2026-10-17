import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
// 样式跟着这块面板自己引：终端是懒加载的，没开过终端就没人在页面上装过 xterm 的表，
// 那时运行窗口会拿默认样式排版——行叠成一片，看着就是一串乱码。
import "@xterm/xterm/css/xterm.css";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor } from "./ContextMenu";
import type { RunController } from "../hooks/useRunSessions";
import type { ProcSessionId } from "../lib/proc";
import {
  bindNativeScroll,
  mountNativeScrollPort,
  terminalColors,
} from "../lib/term";
import type { NativeScrollBinding } from "../lib/term";
import { monoFont } from "../lib/monacoEnv";
import { useI18n } from "../i18n";
import { attachTerminalUrls, isHttpUrl } from "../lib/termUrl";
import { openExternal } from "../lib/fs";

interface RunPaneProps {
  /** 会话状态在 App 上，这里只画输出。 */
  run: RunController;
  /** 深浅色切换只改配色。 */
  dark: boolean;
}

export default function RunPane({ run, dark }: RunPaneProps) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const scrollRef = useRef<NativeScrollBinding | null>(null);
  /** 当前被看着的会话；订阅回调靠它决定要不要落笔。 */
  const activeRef = useRef<ProcSessionId | null>(null);
  /** 重放那一步的当前实现；挂载那条 effect 里量完尺寸要调它，不能引旧闭包。 */
  const replayRef = useRef<(() => void) | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const activeId = run.activeId;

  // 只读输出台：构建工具的 ANSI 颜色要能显示，所以用 xterm 而不是 <pre>。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: monoFont(),
      fontSize: 12,
      lineHeight: 1.45,
      disableStdin: true,
      // 运行输出是只读的，不该有光标；默认的方块光标在这里只会碍眼。
      cursorInactiveStyle: "none",
      scrollback: 8000,
      convertEol: true,
      theme: terminalColors(dark),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    // 原生滚动层
    const scrollPort = mountNativeScrollPort(host);
    term.open(scrollPort.sticky);
    termRef.current = term;

    // 装配 URL 点击打开与划选复制
    const urlHandler = attachTerminalUrls(term);

    const nativeScroll = bindNativeScroll(host, scrollPort.spacer, term);
    scrollRef.current = nativeScroll;

    let hidden = false;
    const syncSize = () => {
      if (host.clientWidth < 20 || host.clientHeight < 20) {
        hidden = true;
        return;
      }
      fit.fit();
      nativeScroll.sync();
      if (hidden) {
        hidden = false;
        replayRef.current?.();
      }
    };
    const observer = new ResizeObserver(syncSize);
    observer.observe(host);
    syncSize();
    return () => {
      observer.disconnect();
      urlHandler.dispose();
      nativeScroll.dispose();
      scrollRef.current = null;
      termRef.current = null;
      term.dispose();
      scrollPort.sticky.remove();
      scrollPort.spacer.remove();
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalColors(dark);
  }, [dark]);

  // 工具窗口头部那颗「滚动到末尾」够不着这里的 xterm，用事件转一手。
  useEffect(() => {
    const onScrollEnd = () => scrollRef.current?.follow();
    window.addEventListener("forge:run-scroll-end", onScrollEnd);
    return () => window.removeEventListener("forge:run-scroll-end", onScrollEnd);
  }, []);

  // 新输出直接落笔；进程在面板收起时照样跑，缓冲区由控制器记着。
  useEffect(
    () =>
      run.onAppend((id, chunk) => {
        if (id === activeRef.current) {
          termRef.current?.write(chunk);
          scrollRef.current?.sync();
        }
      }),
    [run.onAppend]
  );

  // 终端只有一个，切会话等于把那个会话的输出重放一遍。
  const bufferOf = run.bufferOf;
  const replay = () => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    for (const chunk of activeRef.current ? bufferOf(activeRef.current) : []) {
      term.write(chunk);
    }
    scrollRef.current?.sync();
  };
  replayRef.current = replay;
  useEffect(() => {
    activeRef.current = activeId;
    replay();
  }, [activeId, bufferOf]);

  const requestMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    const term = termRef.current;
    const rawSelection = term?.getSelection() ?? "";
    const selection = rawSelection.trim();
    const selectedUrl = isHttpUrl(selection) ? selection : null;
    const hasOutput = (term?.buffer.active.length ?? 0) > 0;
    /** 全选后取文本，再还原原选择：读整个缓冲区没有公开 API，这是 xterm 给的唯一路径。 */
    const copyAll = () => {
      if (!term) return;
      const saved = term.getSelection();
      term.selectAll();
      void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      if (saved) term.clearSelection();
    };
    setMenu({
      x: event.clientX,
      y: event.clientY,
      // 分组顺序照 IDEA 的 ConsoleView.PopupMenu：编辑动作（复制/全选）在前，
      // 分隔线之后是清空与会话动作。
      items: [
        ...(selectedUrl
          ? [
              {
                label: t("terminal.openLink"),
                onSelect: () => void openExternal(selectedUrl).catch(() => {}),
              },
              {
                label: t("terminal.copyLink"),
                onSelect: () => void navigator.clipboard.writeText(selectedUrl).catch(() => {}),
              },
              { separator: true },
            ]
          : []),
        {
          label: t("run.copyOutput"),
          // IDEA 空选中时复制光标所在整行；这里没有行光标，退一步复制全部输出。
          disabled: !hasOutput,
          onSelect: () => {
            if (rawSelection.length > 0) {
              void navigator.clipboard.writeText(rawSelection).catch(() => {});
            } else {
              copyAll();
            }
          },
        },
        {
          label: t("run.selectAllOutput"),
          disabled: !hasOutput,
          onSelect: () => term?.selectAll(),
        },
        { separator: true },
        {
          label: t("run.rerun"),
          // 页签上的重跑管的是这一条会话，不是下拉里选中的那条。
          disabled: !activeId,
          onSelect: () => activeId && run.restartSession(activeId),
        },
        {
          label: t("run.stop"),
          disabled: !run.activeRunning,
          onSelect: () => run.stop(activeId),
        },
        {
          label: t("run.clearAll"),
          disabled: run.sessions.length === 0,
          onSelect: run.clearAll,
        },
        {
          label: t("run.closeSession"),
          disabled: !activeId,
          onSelect: () => activeId && run.closeSession(activeId),
        },
      ],
    });
  };

  return (
    <div className="run-pane">
      <div className="run-console" onContextMenu={requestMenu}>
        <div ref={hostRef} className="term-host" />
        {activeId ? null : <p className="run-hint">{t("run.hint")}</p>}
      </div>

      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
