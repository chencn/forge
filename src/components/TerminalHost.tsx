import { memo, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import {
  bindNativeScroll,
  termResize,
  termSetPaused,
  terminalColors,
  termWrite,
  termWriteBytes,
  windowsBuildNumber,
} from "../lib/term";
import type { NativeScrollBinding } from "../lib/term";
import {
  appendTermNotice,
  attachTermOutput,
  clearTermHistory,
  restartTerm,
  ringTermBell,
  setActiveTermFor,
  setTermCurrentDir,
  splitTerm,
  setTermTitle,
  termSessionById,
  termSessionFor,
  termSessionsFor,
  watchTermTabs,
} from "../lib/termStore";
import type { TermSession } from "../lib/termStore";
import { TermOutputBuffer } from "../lib/termOutputBuffer";
import { registerTermControl, termPark, termSlot, watchTermSlots } from "../lib/termSurface";
import type { TermFindOptions, TermFindResults } from "../lib/termSurface";
import { attachTerminalUrls } from "../lib/termUrl";
import { attachTermKeys } from "../lib/termKeys";
import { bufferText, findDecorations } from "../lib/termFind";
import type { TermFileLink } from "../lib/termFileLinks";
import { normalizeTermTitle } from "../lib/termTitle";
import { pasteLineCount, pasteNeedsConfirm } from "../lib/termPaste";
import { parseOsc7 } from "../lib/termOsc";
import { describeError } from "../lib/errors";
import { errorText, statEntries } from "../lib/fs";
import { monoFont } from "../lib/monacoEnv";
import { DEFAULT_SETTINGS, TERMINAL_FONT_SIZE_RANGE } from "../lib/settings";
import type { TerminalSettings } from "../lib/settings";
import { useSettings } from "../hooks/useSettings";
import { useI18n } from "../i18n";
import "@xterm/xterm/css/xterm.css";

/** 交给 xterm 还没解析完的字节到这么多就让后端停读。 */
const PAUSE_BYTES = 500_000;
/** 降到这么少再放开。两个水位分开，免得在一条线上来回开关。 */
const RESUME_BYTES = 100_000;

interface TerminalHostProps {
  dark: boolean;
  /** 当前激活的工作区根。只有它名下的会话才常驻画面，见 `keptLive`。 */
  cwd: string | null;
  /** 点中终端里的文件路径：路径已确认存在，行列号从 1 起。 */
  onOpenFile: (path: string, line?: number, column?: number) => void;
}

/**
 * 每条会话一个 xterm，活在面板外面。
 *
 * 面板收起只是把画面节点挪进屏幕外的停靠区，shell 和滚屏都留着。
 * 真正显示时再挪进 `TerminalPane` 的插槽，并按插槽尺寸 fit。
 */
function TerminalHost({ dark, cwd, onOpenFile }: TerminalHostProps) {
  const [sessions, setSessions] = useState(() => termSessionsFor(cwd).sessions);
  useEffect(() => {
    const sync = () => setSessions(termSessionsFor(cwd).sessions);
    sync();
    return watchTermTabs(sync);
  }, [cwd]);
  return (
    <>
      {sessions.map((session) => (
        <LiveTerm
          key={session.id}
          session={session}
          exited={session.exited}
          dark={dark}
          onOpenFile={onOpenFile}
        />
      ))}
    </>
  );
}

/** 把缓冲里已经有的可见行再画一遍。fit 和 WebGL 丢上下文都会先把画布抹掉。 */
function paintTerm(term: Terminal | null) {
  if (!term || term.rows < 1) return;
  term.refresh(0, term.rows - 1);
}

function fontFamilyOf(options: TerminalSettings): string {
  return options.fontFamily ? `${options.fontFamily}, ${monoFont()}` : monoFont();
}

let bellAudio: AudioContext | null = null;

/** 一声很短的提示音。用振荡器现做，不带音频文件。 */
function playBell() {
  try {
    bellAudio ??= new AudioContext();
    const context = bellAudio;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.06, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
  } catch {
    // 没有音频设备时就只闪一下。
  }
}

/** 已经写过退出提示的会话。xterm 重建时历史里已经带着那行，不再补一遍。 */
const noticed = new Set<string>();

interface LiveTermProps {
  session: TermSession;
  /** 会话对象原地改，单独递一份才能在退出时触发重渲染。 */
  exited: boolean;
  dark: boolean;
  onOpenFile: TerminalHostProps["onOpenFile"];
}

function LiveTerm({ session, exited, dark, onOpenFile }: LiveTermProps) {
  const { settings, patch } = useSettings();
  const zoomRef = useRef<(step: 1 | -1 | 0) => void>(() => {});
  zoomRef.current = (step) => {
    const current = settings.terminal;
    const fontSize =
      step === 0
        ? DEFAULT_SETTINGS.terminal.fontSize
        : Math.min(
            TERMINAL_FONT_SIZE_RANGE.max,
            Math.max(TERMINAL_FONT_SIZE_RANGE.min, current.fontSize + step),
          );
    if (fontSize !== current.fontSize) patch({ terminal: { ...current, fontSize } });
  };
  const { t } = useI18n();
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const optionsRef = useRef(settings.terminal);
  optionsRef.current = settings.terminal;
  const translateRef = useRef(t);
  translateRef.current = t;
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;

  useEffect(() => {
    let disposed = false;
    const wrapper = document.createElement("div");
    wrapper.className = "term-live-surface";
    const placeParent = () => termSlot(session.id) ?? termPark();
    placeParent().appendChild(wrapper);

    let term: Terminal | null = null;
    let buffer: TermOutputBuffer | null = null;
    let scrollBinding: NativeScrollBinding | null = null;
    /** 交给 xterm、还没解析完的字节数；后端停读与否看它。 */
    let inflight = 0;
    let paused = false;
    const disposers: Array<() => void> = [];
    const add = (dispose: () => void) => {
      if (disposed) dispose();
      else disposers.push(dispose);
    };

    const setPaused = (next: boolean) => {
      if (paused === next) return;
      paused = next;
      void termSetPaused(session.id, next).catch(() => {});
    };

    /** 写不进去时把原因写进终端本身：粘贴被吞掉却什么都不说，人会以为是终端坏了。 */
    const reportWrite = (cause: unknown) => {
      const message = describeError(errorText(cause), translateRef.current);
      term?.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
    };

    const sendText = (data: string) => {
      buffer?.flush();
      const current = termSessionById(session.id);
      if (!current) return;
      if (!current.exited) {
        void termWrite(session.id, data).catch(reportWrite);
        return;
      }
      if (data.includes("\r") && term) {
        void restartTerm(session.id, term.cols, term.rows).catch(reportWrite);
      }
    };

    const paste = async (text: string) => {
      if (!text || !term) return;
      if (pasteNeedsConfirm(text)) {
        const confirmed = await ask(
          translateRef.current("terminal.pasteConfirm", { lines: pasteLineCount(text) }),
          { title: translateRef.current("terminal.pasteConfirmTitle"), kind: "warning" },
        ).catch(() => false);
        if (!confirmed) return;
      }
      // 确认框开着的时候 shell 可能已经退出，或者终端已经拆掉。
      const current = termSessionById(session.id);
      if (disposed || !term || !current || current.exited) return;
      term.paste(text);
    };

    const place = () => {
      const slot = termSlot(session.id);
      const parent = slot ?? termPark();
      const moved = wrapper.parentElement !== parent;
      if (moved) parent.appendChild(wrapper);
      scrollBinding?.dispose();
      scrollBinding = null;
      if (!slot) {
        term?.blur();
        return;
      }
      const host = slot.closest<HTMLElement>(".term-host");
      const spacer = host?.querySelector<HTMLElement>(".term-spacer");
      if (term && host && spacer) {
        scrollBinding = bindNativeScroll(host, spacer, term);
        scrollBinding.sync();
      }
      if (slot.clientWidth < 20 || slot.clientHeight < 20) return;
      fitRef.current();
      // 分屏时一组几条同时挪进来，焦点只给激活的那条。
      if (moved && termSessionFor(session.cwd)?.id === session.id) term?.focus();
    };

    void (async () => {
      const build = await windowsBuildNumber();
      if (disposed) return;

      const options = optionsRef.current;
      term = new Terminal({
        fontFamily: fontFamilyOf(options),
        fontSize: options.fontSize,
        lineHeight: 1.45,
        cursorBlink: true,
        cursorStyle: options.cursorStyle,
        cursorInactiveStyle: options.cursorStyle === "block" ? "outline" : options.cursorStyle,
        scrollback: options.scrollback,
        cols: 80,
        rows: 24,
        theme: terminalColors(darkRef.current),
        allowProposedApi: true,
        convertEol: false,
        smoothScrollDuration: 0,
        customGlyphs: true,
        rescaleOverlappingGlyphs: true,
        reflowCursorLine: false,
        scrollOnEraseInDisplay: true,
        scrollOnUserInput: true,
        windowsPty: build != null ? { backend: "conpty", buildNumber: build } : undefined,
      });
      termRef.current = term;
      term.open(wrapper);
      const textarea = term.textarea;
      if (textarea) {
        const onFocus = () => {
          if (termSessionFor(session.cwd)?.id !== session.id) setActiveTermFor(session.cwd, session.id);
        };
        textarea.addEventListener("focus", onFocus);
        add(() => textarea.removeEventListener("focus", onFocus));
      }

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      const search = new SearchAddon({ highlightLimit: 2000 });
      term.loadAddon(search);
      const findWatchers = new Set<(results: TermFindResults) => void>();
      const found = search.onDidChangeResults(({ resultIndex, resultCount }) => {
        const results = { index: resultIndex < 0 ? 0 : resultIndex + 1, count: resultCount };
        for (const watch of findWatchers) watch(results);
      });
      add(() => found.dispose());
      const findOptions = (options: TermFindOptions, incremental = false) => ({
        ...options,
        incremental,
        decorations: findDecorations(darkRef.current),
      });
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          // 上下文丢了只拆 WebGL。缓冲还在，下一帧用画布把可见行画回去。
          requestAnimationFrame(() => paintTerm(term));
        });
        term.loadAddon(webgl);
      } catch {
        // 显卡上下文起不来时留着 xterm 自带的画布。
      }
      term.loadAddon(
        new ClipboardAddon(undefined, {
          readText: () => navigator.clipboard.readText(),
          writeText: (selection, text) => {
            if (selection === "c") void navigator.clipboard.writeText(text);
          },
        }),
      );
      const urls = attachTerminalUrls(term, {
        fileBaseDir: () => {
          const current = termSessionById(session.id);
          return current?.currentDir ?? current?.cwd ?? null;
        },
        onOpenFile: (link: TermFileLink) => {
          void statEntries([link.path])
            .then((kinds) => {
              if (kinds[0]?.kind === "file") openFileRef.current(link.path, link.line, link.column);
            })
            .catch(() => {});
        },
      });
      add(() => urls.dispose());
      attachTermKeys(term, {
        paste: () => {
          void navigator.clipboard
            .readText()
            .then(paste)
            .catch(() => {});
        },
        zoom: (step) => zoomRef.current(step),
        split: (direction) => {
          if (term) void splitTerm(session.id, direction, term.cols, term.rows).catch(reportWrite);
        },
      });
      const onWheel = (event: WheelEvent) => {
        if (!event.ctrlKey || event.deltaY === 0) return;
        event.preventDefault();
        event.stopPropagation();
        zoomRef.current(event.deltaY < 0 ? 1 : -1);
      };
      wrapper.addEventListener("wheel", onWheel, { passive: false, capture: true });
      add(() => wrapper.removeEventListener("wheel", onWheel, { capture: true }));
      let lastBell = 0;
      const bell = term.onBell(() => {
        const mode = optionsRef.current.bell;
        const now = Date.now();
        if (mode === "none" || now - lastBell < 400) return;
        lastBell = now;
        ringTermBell(session.id);
        wrapper.classList.remove("is-bell");
        // 重新挂类名之前读一次布局，动画才会从头再放。
        void wrapper.offsetWidth;
        wrapper.classList.add("is-bell");
        if (mode === "sound") playBell();
      });
      add(() => bell.dispose());
      const bellEnd = () => wrapper.classList.remove("is-bell");
      wrapper.addEventListener("animationend", bellEnd);
      add(() => wrapper.removeEventListener("animationend", bellEnd));
      const title = term.onTitleChange((raw) => setTermTitle(session.id, normalizeTermTitle(raw)));
      add(() => title.dispose());
      const osc7 = term.parser.registerOscHandler(7, (payload) => {
        const dir = parseOsc7(payload);
        if (dir) setTermCurrentDir(session.id, dir);
        return false;
      });
      add(() => osc7.dispose());

      const fit = () => {
        if (!term) return;
        const slot = termSlot(session.id);
        // 最大化、收起、插槽刚挂上时高度会先变成 0。这时去 fit，会把整屏重排成一两行，
        // 滚屏超出上限的部分被裁掉，画面也清掉，缩不回来。
        if (!slot || slot.clientWidth < 20 || slot.clientHeight < 20) return;
        const next = fitAddon.proposeDimensions();
        if (!next || next.cols < 2 || next.rows < 2) return;
        if (next.cols !== term.cols || next.rows !== term.rows) {
          fitAddon.fit();
          const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
          const pixels = (value: number | undefined) => Math.min(65_535, Math.max(0, Math.round(value ?? 0)));
          void termResize(
            session.id,
            term.cols,
            term.rows,
            pixels(screen?.clientWidth),
            pixels(screen?.clientHeight),
          );
        }
        paintTerm(term);
        scrollBinding?.sync();
      };
      fitRef.current = fit;

      buffer = new TermOutputBuffer({
        write: (data, done) => {
          if (!term) {
            done();
            return;
          }
          const size = data.byteLength;
          inflight += size;
          if (inflight >= PAUSE_BYTES) setPaused(true);
          term.write(data, () => {
            inflight -= size;
            if (inflight <= RESUME_BYTES) setPaused(false);
            done();
          });
        },
      });
      add(attachTermOutput(session.id, (data) => buffer?.enqueue(data, () => {})));
      const input = term.onData(sendText);
      add(() => input.dispose());
      const binary = term.onBinary((data) => {
        const current = termSessionById(session.id);
        if (current && !current.exited) void termWriteBytes(session.id, data).catch(() => {});
      });
      add(() => binary.dispose());
      add(
        registerTermControl(session.id, {
          clear: () => {
            clearTermHistory(session.id);
            term?.clear();
          },
          findNext: (query, options, incremental) => {
            search.findNext(query, findOptions(options, incremental));
          },
          findPrevious: (query, options) => {
            search.findPrevious(query, findOptions(options));
          },
          clearFind: () => search.clearDecorations(),
          watchFind: (watch) => {
            findWatchers.add(watch);
            return () => {
              findWatchers.delete(watch);
            };
          },
          focus: () => term?.focus(),
          selection: () => term?.getSelection() ?? "",
          hasSelection: () => term?.hasSelection() ?? false,
          paste: (text) => void paste(text),
          text: () => (term ? bufferText(term) : ""),
        }),
      );

      place();
      const slot = termSlot(session.id);
      if (slot && slot.clientWidth > 20 && termSessionFor(session.cwd)?.id === session.id) term.focus();
    })();

    const stopSlots = watchTermSlots(place);

    return () => {
      disposed = true;
      stopSlots();
      scrollBinding?.dispose();
      scrollBinding = null;
      for (const dispose of disposers) dispose();
      buffer?.dispose();
      term?.dispose();
      // 没有画面在追这条会话了，后端不能一直停着。
      setPaused(false);
      termRef.current = null;
      fitRef.current = () => {};
      wrapper.remove();
    };
  }, [session.id]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalColors(dark);
  }, [dark]);

  const { fontSize, fontFamily, scrollback, cursorStyle } = settings.terminal;
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamilyOf({ ...optionsRef.current, fontFamily });
    term.options.scrollback = scrollback;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorInactiveStyle = cursorStyle === "block" ? "outline" : cursorStyle;
    // 字号字体一变，一行能放的列数跟着变，PTY 那边也得知道。
    fitRef.current();
  }, [fontSize, fontFamily, scrollback, cursorStyle]);

  useEffect(() => {
    if (!exited || noticed.has(session.id)) return;
    noticed.add(session.id);
    const code = session.exitCode;
    const text =
      code === null ? t("terminal.exited") : t("terminal.exitedWithCode", { code });
    appendTermNotice(
      session.id,
      `\r\n\x1b[33m${text}\x1b[0m \x1b[2m${t("terminal.pressEnterToRestart")}\x1b[0m\r\n`,
    );
  }, [exited, session, t]);

  useEffect(() => {
    let observer: ResizeObserver | null = null;
    const watch = () => {
      observer?.disconnect();
      observer = null;
      const slot = termSlot(session.id);
      if (!slot) return;
      observer = new ResizeObserver(() => {
        if (slot.clientWidth >= 20 && slot.clientHeight >= 20) fitRef.current();
      });
      observer.observe(slot);
    };
    watch();
    const stop = watchTermSlots(watch);
    return () => {
      stop();
      observer?.disconnect();
    };
  }, [session.id]);

  return null;
}

/** 终端只认这几样（配色、工作区根、开文件的入口）；App 因敲字重渲染时不该碰 xterm。 */
export default memo(TerminalHost);
