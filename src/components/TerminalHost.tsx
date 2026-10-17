import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { bindNativeScroll, termResize, terminalColors, termWrite, windowsBuildNumber } from "../lib/term";
import type { NativeScrollBinding } from "../lib/term";
import { attachTermOutput, clearTermHistory, termSessions, watchTermTabs } from "../lib/termStore";
import type { TermSession } from "../lib/termStore";
import { TermOutputBuffer } from "../lib/termOutputBuffer";
import { registerTermControl, termPark, termSlot, watchTermSlots } from "../lib/termSurface";
import { attachTerminalUrls } from "../lib/termUrl";
import { monoFont } from "../lib/monacoEnv";
import "@xterm/xterm/css/xterm.css";

interface TerminalHostProps {
  dark: boolean;
}

/**
 * 每条会话一个 xterm，活在面板外面。
 *
 * 面板收起只是把画面节点挪进屏幕外的停靠区，shell 和滚屏都留着。
 * 真正显示时再挪进 `TerminalPane` 的插槽，并按插槽尺寸 fit。
 */
export default function TerminalHost({ dark }: TerminalHostProps) {
  const [sessions, setSessions] = useState(() => termSessions().sessions);
  useEffect(() => watchTermTabs(() => setSessions(termSessions().sessions)), []);
  return (
    <>
      {sessions.map((session) => (
        <LiveTerm key={session.id} session={session} dark={dark} />
      ))}
    </>
  );
}

/** 把缓冲里已经有的可见行再画一遍。fit 和 WebGL 丢上下文都会先把画布抹掉。 */
function paintTerm(term: Terminal | null) {
  if (!term || term.rows < 1) return;
  term.refresh(0, term.rows - 1);
}

function LiveTerm({ session, dark }: { session: TermSession; dark: boolean }) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const darkRef = useRef(dark);
  darkRef.current = dark;

  useEffect(() => {
    let disposed = false;
    const wrapper = document.createElement("div");
    wrapper.className = "term-live-surface";
    const placeParent = () => termSlot(session.id) ?? termPark();
    placeParent().appendChild(wrapper);

    let term: Terminal | null = null;
    let buffer: TermOutputBuffer | null = null;
    let scrollBinding: NativeScrollBinding | null = null;
    const disposers: Array<() => void> = [];
    const add = (dispose: () => void) => {
      if (disposed) dispose();
      else disposers.push(dispose);
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
      if (moved) term?.focus();
    };

    void (async () => {
      const build = await windowsBuildNumber();
      if (disposed) return;

      term = new Terminal({
        fontFamily: monoFont(),
        fontSize: 12,
        lineHeight: 1.45,
        cursorBlink: true,
        cursorStyle: "bar",
        cursorInactiveStyle: "bar",
        scrollback: 10_000,
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

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      const search = new SearchAddon();
      term.loadAddon(search);
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
      const urls = attachTerminalUrls(term);
      add(() => urls.dispose());

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
          void termResize(session.id, term.cols, term.rows);
        }
        paintTerm(term);
        scrollBinding?.sync();
      };
      fitRef.current = fit;

      buffer = new TermOutputBuffer({
        write: (data, done) => term?.write(data, done),
      });
      add(attachTermOutput(session.id, (data) => buffer?.enqueue(data, () => {})));
      const input = term.onData((data) => {
        buffer?.flush();
        const current = termSessions().sessions.find((item) => item.id === session.id);
        if (current && !current.exited) void termWrite(session.id, data);
      });
      add(() => input.dispose());
      add(
        registerTermControl(session.id, {
          clear: () => {
            clearTermHistory(session.id);
            term?.clear();
          },
          findNext: (query) => {
            search.findNext(query, { incremental: true });
          },
          findPrevious: (query) => {
            search.findPrevious(query);
          },
          focus: () => term?.focus(),
          selection: () => term?.getSelection() ?? "",
          hasSelection: () => term?.hasSelection() ?? false,
          paste: (text) => {
            if (text) void termWrite(session.id, text);
          },
        }),
      );

      place();
      const slot = termSlot(session.id);
      if (slot && slot.clientWidth > 20) term.focus();
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
      termRef.current = null;
      fitRef.current = () => {};
      wrapper.remove();
    };
  }, [session.id]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalColors(dark);
  }, [dark]);

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
