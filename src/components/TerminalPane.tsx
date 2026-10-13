import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor } from "./ContextMenu";
import {
  bindNativeScroll,
  decodeChunk,
  mountNativeScrollPort,
  terminalColors,
  termResize,
  termWrite,
} from "../lib/term";
import type { NativeScrollBinding } from "../lib/term";
import { needTermSession, restartTermSession, termSessionFor, watchTermSession } from "../lib/termStore";
import type { TermSession } from "../lib/termStore";
import { errorText } from "../lib/fs";
import { describeError } from "../lib/errors";
import { monoFont } from "../lib/monacoEnv";
import { useSettings } from "../hooks/useSettings";
import { useI18n } from "../i18n";
import "@xterm/xterm/css/xterm.css";

interface TerminalPaneProps {
  /** 新会话的起始目录；换工作区时重开一个 shell。 */
  cwd: string | null;
  /** 深浅色切换只改配色，不能把 shell 干掉。 */
  dark: boolean;
}

/** 工具窗口头部那两颗按钮要能命令终端：作用于当前激活的那条会话。 */
export interface TerminalPaneHandle {
  clear: () => void;
  restart: () => void;
}

export default forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane(
  { cwd, dark },
  ref
) {
  const { settings } = useSettings();
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionRef = useRef<TermSession | null>(null);
  const shellRef = useRef(settings.terminal.shell);
  shellRef.current = settings.terminal.shell;
  /** 换语言不该把 shell 重开一遍，报错文案现取。 */
  const translateRef = useRef(t);
  translateRef.current = t;
  /** 自增一次就重新走一遍挂会话的流程。 */
  const [epoch, setEpoch] = useState(0);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** 只有「重开会话」置真：别的重挂（换位置、切选项卡）都该沿用后台那条 shell。 */
  const freshRef = useRef(false);
  /** 量到真实尺寸才允许碰 PTY 的行列数。 */
  const [sized, setSized] = useState(false);
  /** 原生滚动层绑定控制面。 */
  const scrollRef = useRef<NativeScrollBinding | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      clear: () => termRef.current?.clear(),
      restart: () => {
        freshRef.current = true;
        setEpoch((value) => value + 1);
      },
    }),
    []
  );

  // 终端实例建一次；会话存在模块级，所以这里重建不等于重开 shell。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: monoFont(),
      fontSize: 12,
      lineHeight: 1.45,
      cursorBlink: true,
      // IDEA 终端光标是细竖线，不是 xterm 默认的方块（方块闪起来是一大坨）。
      cursorStyle: "bar",
      cursorInactiveStyle: "bar",
      scrollback: 5000,
      theme: terminalColors(dark),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    // 采用 snow-file-explorer 的原生滚动层结构：画面挂在粘性视口上，滚动条留给浏览器原生引擎
    const scrollPort = mountNativeScrollPort(host);
    term.open(scrollPort.sticky);
    termRef.current = term;

    const nativeScroll = bindNativeScroll(host, scrollPort.spacer, term);
    scrollRef.current = nativeScroll;

    const input = term.onData((data) => {
      const session = sessionRef.current;
      if (session && !session.exited) void termWrite(session.id, data);
    });
    const syncSize = () => {
      // 0×0 的宿主量出来的行列会把 ConPTY 带进死状态，量不到就当没发生。
      if (host.clientWidth < 20 || host.clientHeight < 20) return;
      fit.fit();
      setSized(true);
      const session = sessionRef.current;
      if (session && !session.exited) void termResize(session.id, term.cols, term.rows);
      nativeScroll.sync();
    };
    const observer = new ResizeObserver(syncSize);
    observer.observe(host);
    syncSize();

    return () => {
      observer.disconnect();
      nativeScroll.dispose();
      scrollRef.current = null;
      input.dispose();
      termRef.current = null;
      sessionRef.current = null;
      term.dispose();
      // 移除挂载的原生滚动 DOM 节点
      scrollPort.sticky.remove();
      scrollPort.spacer.remove();
      // 故意不关会话：界面收起来，shell 还得在后台跑。
    };
  }, []);

  // 挂上会话：能沿用就沿用，把攒下的输出补画；沿用不了才起新的。
  useEffect(() => {
    const term = termRef.current;
    if (!term || !sized) return;
    let cancelled = false;
    let written = 0;
    let lastId: string | null = null;

    const draw = (session: TermSession) => {
      // 换了会话就整体重放；同一条只补新增的片段。
      if (session.id !== lastId) {
        lastId = session.id;
        written = 0;
        term.reset();
      }
      sessionRef.current = session;
      const hadChunks = session.chunks.length > 0;
      while (written < session.chunks.length) {
        term.write(decodeChunk(session.chunks[written]));
        written += 1;
      }
      // 重放结束后锚定到最新输出底部并同步原生滚动条
      if (hadChunks) {
        term.scrollToBottom();
      }
      scrollRef.current?.sync();
    };

    const stop = watchTermSession(() => {
      const session = termSessionFor(cwd);
      if (session) {
        draw(session);
        return;
      }
      // 一条会话都不剩了（把最后一个页签关掉了）：把画面清干净，别留着上一条的残字。
      // 关掉的不是最后一条时 `termSessionFor(cwd)` 会给回邻居，走上面那支重放，到不了这里。
      if (lastId !== null) {
        lastId = null;
        written = 0;
        sessionRef.current = null;
        term.reset();
        scrollRef.current?.sync();
      }
    });
    const attach = async () => {
      const fresh = freshRef.current;
      freshRef.current = false;
      const current = termSessionFor(cwd);
      const session = fresh && current
        ? await restartTermSession(current.id, cwd, shellRef.current, term.cols, term.rows)
        : await needTermSession(cwd, shellRef.current, term.cols, term.rows);
      if (cancelled) return;
      draw(session);
      if (!session.exited) void termResize(session.id, term.cols, term.rows);
      term.scrollToBottom();
      scrollRef.current?.sync();
    };
    void attach().catch((cause: unknown) => {
      if (cancelled) return;
      // 起不来时把原因写在终端里，别留一块没有解释的空白。
      term.writeln(`\x1b[31m${describeError(errorText(cause), translateRef.current)}\x1b[0m`);
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, [cwd, epoch, sized]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalColors(dark);
  }, [dark]);

  const requestMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    const term = termRef.current;
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: t("action.copy"),
          disabled: !(term?.hasSelection() ?? false),
          onSelect: () => {
            const text = term?.getSelection();
            if (text) void navigator.clipboard.writeText(text);
          },
        },
        {
          label: t("action.paste"),
          onSelect: () => {
            void navigator.clipboard
              .readText()
              .then((text) => {
                const session = sessionRef.current;
                if (text && session && !session.exited) void termWrite(session.id, text);
              })
              .catch(() => {});
          },
        },
        { label: t("terminal.clear"), onSelect: () => term?.clear() },
        {
          label: t("terminal.restart"),
          onSelect: () => {
            freshRef.current = true;
            setEpoch((value) => value + 1);
          },
        },
      ],
    });
  };

  return (
    <>
      <div
        ref={hostRef}
        className="term-host"
        onContextMenu={(event) => {
          event.preventDefault();
          requestMenu(event);
        }}
      />
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
});
