import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
// 样式跟着这块面板自己引：终端是懒加载的，没开过终端就没人在页面上装过 xterm 的表，
// 那时运行窗口会拿默认样式排版——行叠成一片，看着就是一串乱码。
import "@xterm/xterm/css/xterm.css";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor } from "./ContextMenu";
import { useAiInputMenu } from "./AiInputContext";
import TermFindBar from "./TermFindBar";
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
import { openExternal, statEntries, writeFile } from "../lib/fs";
import { attachTermKeys } from "../lib/termKeys";
import { bufferText, findDecorations } from "../lib/termFind";
import type { TermFileLink } from "../lib/termFileLinks";
import type { TermControl, TermFindResults } from "../lib/termSurface";
import type { TerminalSettings } from "../lib/settings";
import { DEFAULT_SETTINGS, TERMINAL_FONT_SIZE_RANGE } from "../lib/settings";
import { useSettings } from "../hooks/useSettings";

interface RunPaneProps {
  /** 会话状态在 App 上，这里只画输出。 */
  run: RunController;
  /** 深浅色切换只改配色。 */
  dark: boolean;
  /** 点中输出里的文件路径：路径已确认存在，行列号从 1 起。和终端里点文件同一条路。 */
  onOpenFile: (path: string, line?: number, column?: number) => void;
}

/** 文件名里不能出现的字符换成下划线。 */
function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/gu, "_").replace(/^_+|_+$/gu, "") || "run";
}

function fontFamilyOf(options: TerminalSettings): string {
  return options.fontFamily ? `${options.fontFamily}, ${monoFont()}` : monoFont();
}

export default function RunPane({ run, dark, onOpenFile }: RunPaneProps) {
  const { settings, patch } = useSettings();
  const { t } = useI18n();
  const aiInputMenu = useAiInputMenu();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const scrollRef = useRef<NativeScrollBinding | null>(null);
  const findWatchersRef = useRef(new Set<(results: TermFindResults) => void>());
  /** 当前被看着的会话；订阅回调靠它决定要不要落笔。 */
  const activeRef = useRef<ProcSessionId | null>(null);
  /** 重放那一步的当前实现；挂载那条 effect 里量完尺寸要调它，不能引旧闭包。 */
  const replayRef = useRef<(() => void) | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findSeed, setFindSeed] = useState("");
  /** 每次切会话重放完自增一次：让开着的查找浮层在新缓冲上重跑（见 TermFindBar 的 revision）。 */
  const [replayTick, setReplayTick] = useState(0);
  const activeId = run.activeId;

  // 初值走 ref：挂载那条 effect 只跑一次，字体设置变了由下面单独的 effect 原地改。
  const optionsRef = useRef(settings.terminal);
  optionsRef.current = settings.terminal;
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;
  /** 相对路径按哪条会话的工作目录解析。 */
  const dirRef = useRef<string | null>(run.activeSession?.dir ?? null);
  dirRef.current = run.activeSession?.dir ?? null;

  // 只读输出台：构建工具的 ANSI 颜色要能显示，所以用 xterm 而不是 <pre>。
  // 这些能力都是从终端那份 xterm 学过来的：查找、可点的文件路径、缩放、WebGL 渲染、东亚宽度对齐。
  // 唯独不分栏——运行是只读的输出台，拆成几格没有意义。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const options = optionsRef.current;
    const term = new Terminal({
      fontFamily: fontFamilyOf(options),
      fontSize: options.fontSize,
      lineHeight: 1.45,
      disableStdin: true,
      // 运行输出是只读的，不该有光标；默认的方块光标在这里只会碍眼。
      cursorInactiveStyle: "none",
      scrollback: options.scrollback,
      convertEol: true,
      // 查找（SearchAddon）和东亚宽度（Unicode11）都要求开提议 API。
      allowProposedApi: true,
      theme: terminalColors(darkRef.current),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    const search = new SearchAddon({ highlightLimit: 2000 });
    term.loadAddon(search);
    const searchResults = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      const results = { index: resultIndex < 0 ? 0 : resultIndex + 1, count: resultCount };
      for (const watch of findWatchersRef.current) watch(results);
    });

    // 原生滚动层
    const scrollPort = mountNativeScrollPort(host);
    term.open(scrollPort.sticky);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // WebGL 渲染器：跑长日志时和终端一样吃图形加速；起不来就退回 xterm 自带画布。
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
        // 上下文丢了只拆 WebGL，缓冲还在，下一帧用画布把可见行画回去。
        if (term.rows >= 1) term.refresh(0, term.rows - 1);
      });
      term.loadAddon(webgl);
    } catch {
      webgl = null;
    }

    // URL 点击打开 + 可点的文件路径（报错里的 file:line:col）。
    const urlHandler = attachTerminalUrls(term, {
      fileBaseDir: () => dirRef.current,
      onOpenFile: (link: TermFileLink) => {
        void statEntries([link.path])
          .then((kinds) => {
            if (kinds[0]?.kind === "file") openFileRef.current(link.path, link.line, link.column);
          })
          .catch(() => {});
      },
    });

    const nativeScroll = bindNativeScroll(host, scrollPort.spacer, term);
    scrollRef.current = nativeScroll;

    // 缩放：Ctrl/Cmd +/-/0。只给缩放——粘贴对只读面板无意义，分栏运行不给。
    attachTermKeys(term, {
      zoom: (step) => {
        const current = optionsRef.current;
        const fontSize =
          step === 0
            ? DEFAULT_SETTINGS.terminal.fontSize
            : Math.min(
                TERMINAL_FONT_SIZE_RANGE.max,
                Math.max(TERMINAL_FONT_SIZE_RANGE.min, current.fontSize + step),
              );
        if (fontSize !== current.fontSize) patch({ terminal: { ...current, fontSize } });
      },
    });
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const current = optionsRef.current;
      const fontSize = Math.min(
        TERMINAL_FONT_SIZE_RANGE.max,
        Math.max(TERMINAL_FONT_SIZE_RANGE.min, current.fontSize + (event.deltaY < 0 ? 1 : -1)),
      );
      if (fontSize !== current.fontSize) patch({ terminal: { ...current, fontSize } });
    };
    // 挂在 .run-console 的捕获层：它在 host 之上，先于 bindNativeScroll 那个会
    // stopImmediatePropagation 的 host 捕获监听，Ctrl+滚轮才拦得下来。非 Ctrl 的滚轮原样放过。
    const zoomLayer = host.parentElement;
    zoomLayer?.addEventListener("wheel", onWheel, { passive: false, capture: true });

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
      zoomLayer?.removeEventListener("wheel", onWheel, { capture: true });
      searchResults.dispose();
      urlHandler.dispose();
      nativeScroll.dispose();
      scrollRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      webgl?.dispose();
      term.dispose();
      scrollPort.sticky.remove();
      scrollPort.spacer.remove();
    };
    // 挂载一次：字号字体变化走下面的 effect 原地改，不重建终端。
  }, []);

  // 深浅色：配色和查找高亮都跟着换。
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalColors(dark);
  }, [dark]);

  // 字号 / 字体 / 滚屏数变了原地改，并重算列数。
  const { fontSize, fontFamily, scrollback } = settings.terminal;
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamilyOf({ ...optionsRef.current, fontFamily });
    term.options.scrollback = scrollback;
    fitRef.current?.fit();
    scrollRef.current?.sync();
  }, [fontSize, fontFamily, scrollback]);

  // 工具窗口头部那颗「滚动到末尾」够不着这里的 xterm，用事件转一手。
  useEffect(() => {
    const onScrollEnd = () => scrollRef.current?.follow();
    window.addEventListener("forge:run-scroll-end", onScrollEnd);
    return () => window.removeEventListener("forge:run-scroll-end", onScrollEnd);
  }, []);

  // Ctrl/Cmd+F 开查找：attachTermKeys 不拦这条，这里在捕获层接住，和终端一致。
  const openFind = () => {
    const selection = termRef.current?.getSelection() ?? "";
    setFindSeed(selection && !selection.includes("\n") ? selection : "");
    setFindOpen(true);
  };
  const openFindRef = useRef(openFind);
  openFindRef.current = openFind;

  // 头部动作条那颗放大镜够不着这里的查找浮层，和「滚动到末尾」一样用事件转一手。
  useEffect(() => {
    const onRequest = () => openFindRef.current();
    window.addEventListener("forge:run-find", onRequest);
    return () => window.removeEventListener("forge:run-find", onRequest);
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      openFind();
    } else if (event.key === "Escape" && findOpen) {
      // 焦点不在查找框里时（比如刚点回输出），Esc 也负责关掉浮层。
      setFindOpen(false);
    }
  };

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
    // 换会话时旧的查找高亮不属于这一条了，先擦掉。
    searchRef.current?.clearDecorations();
    term.reset();
    const chunks = activeRef.current ? bufferOf(activeRef.current) : [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (i === chunks.length - 1) {
        // 最后一块解析完了再报一次，让开着的查找在新缓冲上重跑。
        term.write(chunk, () => setReplayTick((tick) => tick + 1));
      } else {
        term.write(chunk);
      }
    }
    if (chunks.length === 0) setReplayTick((tick) => tick + 1);
    scrollRef.current?.sync();
  };
  replayRef.current = replay;
  useEffect(() => {
    activeRef.current = activeId;
    replay();
  }, [activeId, bufferOf]);

  // 控制器把某条会话的缓冲清空时，画面上那份也要跟着擦。
  const onClear = run.onClear;
  useEffect(
    () =>
      onClear((id) => {
        if (id === activeRef.current) termRef.current?.clear();
      }),
    [onClear]
  );

  // 给查找浮层的一条本地控制：只填它用得上的那几个方法，其余按只读终端的样子给。
  const findControl = useMemo<TermControl>(
    () => ({
      clear: () => termRef.current?.clear(),
      findNext: (query, options, incremental) => {
        searchRef.current?.findNext(query, {
          ...options,
          incremental: incremental ?? false,
          decorations: findDecorations(darkRef.current),
        });
      },
      findPrevious: (query, options) => {
        searchRef.current?.findPrevious(query, {
          ...options,
          decorations: findDecorations(darkRef.current),
        });
      },
      clearFind: () => searchRef.current?.clearDecorations(),
      watchFind: (watch) => {
        findWatchersRef.current.add(watch);
        return () => {
          findWatchersRef.current.delete(watch);
        };
      },
      focus: () => termRef.current?.focus(),
      selection: () => termRef.current?.getSelection() ?? "",
      hasSelection: () => termRef.current?.hasSelection() ?? false,
      // 只读面板不往进程里粘东西。
      paste: () => {},
      text: () => (termRef.current ? bufferText(termRef.current) : ""),
    }),
    []
  );

  const exportOutput = async () => {
    const term = termRef.current;
    if (!term) return;
    const date = new Date().toISOString().slice(0, 10);
    const path = await save({
      defaultPath: `${fileSafe(run.activeSession?.name ?? "run")}-${date}.txt`,
      filters: [
        { name: t("terminal.textFiles"), extensions: ["txt", "log"] },
        { name: t("terminal.allFiles"), extensions: ["*"] },
      ],
    }).catch(() => null);
    if (!path) return;
    await writeFile(path, `${bufferText(term)}\n`, "lf", false).catch(() => {});
  };

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
        aiInputMenu({ kind: "text", text: rawSelection, source: t("panel.run") }),
        {
          label: t("run.selectAllOutput"),
          disabled: !hasOutput,
          onSelect: () => term?.selectAll(),
        },
        {
          label: t("terminal.find"),
          shortcut: "Ctrl+F",
          disabled: !hasOutput,
          onSelect: openFind,
        },
        {
          label: t("terminal.export"),
          disabled: !hasOutput,
          onSelect: () => void exportOutput(),
        },
        { separator: true },
        {
          label: t("terminal.clear"),
          disabled: !hasOutput,
          // 只清这一条会话攒下的输出，会话本身继续跑，照终端的清屏。
          onSelect: () => activeId && run.clearOutput(activeId),
        },
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
    <div className="run-pane" onKeyDownCapture={onKeyDown}>
      <div className="run-console" onContextMenu={requestMenu}>
        <div ref={hostRef} className="term-host" />
        {activeId ? null : <p className="run-hint">{t("run.hint")}</p>}
        {findOpen && activeId ? (
          <TermFindBar
            key={findSeed /* 每次从选区带出关键字时换一个，浮层重新起一份 */}
            control={findControl}
            initialQuery={findSeed}
            revision={replayTick}
            onClose={() => setFindOpen(false)}
          />
        ) : null}
      </div>

      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
