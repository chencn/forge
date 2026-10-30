import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type { MinimapConfig } from "@replit/codemirror-minimap";
import {
  EditorView,
  applyChangeMarks,
  applyFontMetrics,
  captureState,
  emptyState,
  gutterWidth,
  lineTop,
  lineText,
  loadLanguage,
  minimapConfigOf,
  minimapExtension,
  minimapGutters,
  pathOf,
  persistView,
  primeMinimap,
  replaceRange,
  restoreView,
  revealRange,
  saveKeymap,
  scrollRatio,
  selectAll,
  selectedRange,
  selectedText,
  setMinimap,
  setMounted,
  setScrollRatio,
  setKeymap,
  setRainbowBrackets,
  stateFor,
  textOf,
  textReplacement,
  toDiskText,
  type ChangeMark,
  type LineEnding,
} from "../lib/cmEditor";
import { lspExtensions } from "../lib/cm/lsp";
import { attachMinimapPointer } from "../lib/cm/minimapPointer";
import { forgeKeymap } from "../lib/cm/keymap";
import { basenameOf, samePath } from "../lib/format";
import { gutterTargets } from "../lib/runMarkers";
import { scriptKindOf } from "../lib/scriptRun";
import { httpRequestLabel, isHttpFile, parseHttpFile } from "../lib/httpFile";
import type { RunConfiguration } from "../lib/runConfigs";
import { useSettings } from "../hooks/useSettings";
import { useI18n } from "../i18n";
import type { OpenDocument, RevealTarget } from "../hooks/useDocuments";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor, MenuItem } from "./ContextMenu";
import { useAiInputMenu } from "./AiInputContext";
import { changeBaselineKey, gutterChanges, headFile, type ChangeBaseline } from "../lib/lineChanges";

/** 一颗 ▶ 占多宽。行号与代码之间那条带里留给指针命中的宽度，同原来 Monaco 那版一致。 */
const PIN_WIDTH = 12;

/** 供分栏模式下双向同步滚动位置的指令句柄。 */
export interface CodeEditorHandle {
  setScrollRatio: (ratio: number) => void;
  getScrollRatio: () => number;
}

interface CodeEditorProps {
  /** 当前标签对应的文档；为 null 时编辑器留空。 */
  document: OpenDocument | null;
  onChange: (path: string, contents: string) => void;
  onSave: () => void;
  /** 焦点离开整个编辑器挂件（点向目录树、终端、提交面板等外部区域）时触发。 */
  onBlur?: () => void;
  /** 搜索命中的落点；不属于当前文档或已经消费掉时为 null。 */
  reveal: RevealTarget | null;
  /** 跳完之后由这边通知，避免同一次定位被重复应用。 */
  onRevealDone: () => void;
  /** 全工程识别出来的运行配置，装订线上那颗 ▶ 从这里面挑。 */
  runConfigs: RunConfiguration[];
  /** 工程根绝对路径：配置里记的是相对源文件，靠它对回当前这篇文档。 */
  projectRoot: string;
  /** 点了装订线那颗 ▶：一条就直接跑，几条就交出去让他挑。 */
  onRunConfig: (configs: RunConfiguration[]) => void;
  /** 点了脚本文件第 1 行那颗 ▶：把这份脚本发到对应终端里执行。 */
  onRunScript: (path: string) => void;
  /** 点了 `.http` / `.rest` 请求行上的 ▶：发送这一条请求。正文用编辑器里的最新内容。 */
  onRunHttp: (path: string, line: number, contents: string) => void;
  /** 滚动位置变化时的比例回调（0~1），供分栏模式下与预览区联动。 */
  onScrollRatio?: (ratio: number) => void;
  /**
   * 相对上次提交的基线。null 表示这篇不画（未跟踪、冲突、仓库外、已删除）。
   * 右侧响应页那台编辑器不传。
   */
  changeBaseline?: ChangeBaseline | null;
}

/** 换算到编辑器坐标之后的一颗 ▶。 */
interface GutterPin {
  line: number;
  top: number;
  left: number;
  tip: string;
  configs?: RunConfiguration[];
}

export default forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor({
  document: doc,
  onChange,
  onSave,
  onBlur,
  reveal,
  onRevealDone,
  runConfigs,
  projectRoot,
  onRunConfig,
  onRunScript,
  onRunHttp,
  onScrollRatio,
  changeBaseline = null,
}: CodeEditorProps, ref) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const aiInputMenu = useAiInputMenu();
  const [contextMenu, setContextMenu] = useState<MenuAnchor | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 换文档时抑制一次回调，避免把上一篇的内容写进新文档。 */
  const swapping = useRef(false);
  const pathRef = useRef<string | null>(null);
  /** 这篇 state 是按哪几样条件配的；没变就只换正文，不重配。 */
  const wiredRef = useRef<{ language: string; tabSize: number; readOnly: boolean; failed: boolean } | null>(null);

  const changeRef = useRef(onChange);
  const saveRef = useRef(onSave);
  const blurRef = useRef(onBlur);
  const optionsRef = useRef(settings.editor);
  const onScrollRatioRef = useRef(onScrollRatio);
  const translateRef = useRef(t);
  const lastScrollTop = useRef(0);
  const marksRef = useRef<ChangeMark[]>([]);
  /**
   * 这篇文档磁盘上的行尾。编辑器里只有 `\n`，交回应用（存盘、LSP、运行）时要换回去，
   * 否则 CRLF 文件改一个字就把整篇的行尾洗掉。
   */
  const endingRef = useRef<LineEnding>("lf");
  endingRef.current = doc?.lineEnding ?? "lf";
  const measureRef = useRef<() => void>(() => {});
  const refreshMarksRef = useRef<() => void>(() => {});
  /** ▶ 那层挂进哪个元素：编辑器的行号槽。挂载完才有值。 */
  const [pinHost, setPinHost] = useState<HTMLElement | null>(null);
  const pinHostRef = useRef<HTMLElement | null>(null);
  /**
   * 每回量高都对着编辑器重新找一次行号槽。
   *
   * `setState`（换文档、语法包加载完重配）会把整层 `.cm-gutters` 拆掉重造，
   * 老的那份从此刻起脱离文档——portal 还挂在它上面，▶ 就一个都不显示了。
   */
  /**
   * ▶ 层挂在编辑器的滚动盒本体上：把 scrollDOM 置为 relative，文档坐标（lineTop）
   * 在这里随内容一起滚，行高怎么变都天然与行对齐。
   *
   * 不能挂行号槽（.cm-gutters）：那是 sticky 盒，坐标系是视口——文档坐标挂进去，
   * 滚动条一离开顶部 ▶ 就整体漂移（行号是引擎按视口系重摆的，所以只有 ▶ 错位）。
   */
  const ensurePinHost = useCallback((view: EditorView) => {
    const next = view.scrollDOM;
    if (next === pinHostRef.current) return;
    if (getComputedStyle(next).position === "static") next.style.position = "relative";
    pinHostRef.current = next;
    setPinHost(next);
  }, []);
  changeRef.current = onChange;
  saveRef.current = onSave;
  blurRef.current = onBlur;
  optionsRef.current = settings.editor;
  onScrollRatioRef.current = onScrollRatio;
  translateRef.current = t;

  useImperativeHandle(
    ref,
    () => ({
      setScrollRatio: (ratio: number) => {
        const view = viewRef.current;
        if (view) setScrollRatio(view, ratio);
      },
      getScrollRatio: () => {
        const view = viewRef.current;
        return view ? scrollRatio(view) : 0;
      },
    }),
    []
  );

  /**
   * 键位方案跟着设置走。
   *
   * 「默认」档返回空扩展，也就是引擎自带那一套；换档只重配这一格，不重建编辑器。
   */
  const syncKeymap = useCallback(() => {
    const view = viewRef.current;
    if (view) {
      setKeymap(view, forgeKeymap(optionsRef.current.keymap));
      setRainbowBrackets(view, optionsRef.current.rainbowBrackets);
    }
  }, []);

  /**
   * 小地图那一格：宿主 div 每次现造，色带按当前改动现算；关掉时给 null。
   *
   * 宿主不能复用：库在开关之间只摘外框、不清里面的旧画布，复用会让那张空白的
   * 一直留在里面。配置本身跟着 state 一起建（见 `minimapExtension`）——库的行表只在
   * 建 state 那一刻算，事后加进来就是一片空白。
   *
   * 点击与拖动也在这里顺手挂到宿主上：宿主是库现造的，只有这一刻拿得到它和 view
   * 的对应关系（见 `attachMinimapPointer`）。
   */
  const minimapConfig = useCallback((marks: ChangeMark[]): MinimapConfig | null => {
    if (!optionsRef.current.minimap) return null;
    const dark = window.document.documentElement.dataset.theme === "dark";
    return {
      create: (view) => {
        const dom = window.document.createElement("div");
        attachMinimapPointer(dom, view);
        return { dom };
      },
      displayText: "characters",
      showOverlay: "always",
      gutters: [minimapGutters(marks, dark)],
    };
  }, []);

  /**
   * 小地图的配置每次现算：开关来自设置，色带来自当前改动标记。
   *
   * `showMinimap` 不会自己监听这两样，所以设置换了、或 HEAD 原文刚读回来时，
   * 都要由这里重新派发一次。
   */
  const syncMinimap = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = minimapConfig(marksRef.current);
    const wasOn = minimapConfigOf(view) !== null;
    setMinimap(view, next);
    if (wasOn || !next) return;
    // 从关到开：行表建的时候读到的是「关」，库不会自己重算（见 minimapExtension）。
    // 补两笔净正文不变的改动逼它算一遍，并且不能让外面以为用户改过正文。
    swapping.current = true;
    try {
      primeMinimap(view);
    } finally {
      swapping.current = false;
    }
  }, [minimapConfig]);

  /**
   * 每台视图、每一篇文档都要带上的那几样扩展。
   *
   * 单独提出来是因为它要同时喂给两处：空态（没开任何文件）建 state 时喂一次，
   * 挂上真文档时再喂一次——常驻 state 只在**建**的时候吃 `extra`，两处漏一处，
   * 那篇文档就没有正文监听（打字不回写、改没改过看不出来）、没有 Ctrl+S，整组 LSP 也不在。
   */
  const permanentExtensions = useMemo(
    () => [
      ...lspExtensions,
      // 小地图得在建 state 时就带上：库的行表只在那一刻算（见 minimapExtension）。
      // 这里给的是空色带，真色带由 syncMinimap 之后补上。
      minimapExtension(minimapConfig([])),
      saveKeymap(() => saveRef.current()),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          captureState(update.view);
          measureRef.current();
          refreshMarksRef.current();
          if (!swapping.current) {
            const path = pathOf(update.view.state);
            if (path) changeRef.current(path, toDiskText(textOf(update.view), endingRef.current));
          }
          return;
        }
        // ▶ 按文档坐标摆，滚动不用重算；只有行高变了（字号、折行）才需要重新落点。
        if (update.geometryChanged) measureRef.current();
        // 行号槽整层被换掉（`setState`、开关小地图）时，portal 得跟着换宿主，否则 ▶ 全没。
        ensurePinHost(update.view);
        const top = update.view.scrollDOM.scrollTop;
        if (top !== lastScrollTop.current) {
          lastScrollTop.current = top;
          const max = update.view.scrollDOM.scrollHeight - update.view.scrollDOM.clientHeight;
          if (max > 0) onScrollRatioRef.current?.(top / max);
        }
      }),
    ],
    [ensurePinHost, minimapConfig]
  );

  /**
   * 把视图对到一篇文档上；`contents` 取编辑器手上那份（语法装载完成后的重配用它，
   * 不能拿 React 手里那份——可能已经落后一个字）。
   *
   * `restore` 给 false 的那一路是「语法包加载完了重配一次」：这篇正打在屏幕上，
   * 光标就该留在原位，把上次存的落点贴回去会把光标弹走。
   */
  const attach = useCallback(
    (view: EditorView, path: string, contents: string, language: string, readOnly: boolean, restore = true) => {
      swapping.current = true;
      view.setState(
        stateFor(
          { path, contents, language, readOnly, tabSize: optionsRef.current.tabSize },
          permanentExtensions
        )
      );
      swapping.current = false;
      pathRef.current = path;
      setMounted(path, view);
      wiredRef.current = { language, tabSize: optionsRef.current.tabSize, readOnly, failed: false };
      if (restore) {
        // 恢复光标与滚动位置不算外部改动：不压住这一次回调，上一篇的内容会被写进这篇文档。
        swapping.current = true;
        restoreView(path, view);
        swapping.current = false;
      }
      measureRef.current();
      syncMinimap();
      syncKeymap();
    },
    [permanentExtensions, syncKeymap, syncMinimap]
  );

  // ---------------------------------------------------------------- 挂载

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: emptyState(permanentExtensions),
      parent: host,
    });
    viewRef.current = view;
    applyFontMetrics(host, optionsRef.current.fontSize);
    wiredRef.current = null;
    // ▶ 那一层挂进行号槽：槽是 sticky 的、高度跟着整篇内容，挂进去就跟着内容一起滚。
    ensurePinHost(view);

    // 失焦保存：查找条、补全浮层、悬停浮层都在 view.dom 里，焦点落进它们仍算在编辑器内。
    // 原来用 Monaco 的 onDidBlurEditorWidget 就是为了这件事，这里换成 focusout + 归属判断。
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && view.dom.contains(next)) return;
      if (!view.dom.isConnected) return;
      blurRef.current?.();
    };
    view.dom.addEventListener("focusout", onFocusOut);

    return () => {
      const path = pathRef.current;
      if (path) {
        persistView(path, view);
        setMounted(path, null);
      }
      view.dom.removeEventListener("focusout", onFocusOut);
      view.destroy();
      viewRef.current = null;
    };
  }, [ensurePinHost]);

  useEffect(() => {
    const host = hostRef.current;
    if (host) applyFontMetrics(host, settings.editor.fontSize);
  }, [settings.editor.fontSize]);

  useEffect(() => {
    syncMinimap();
  }, [syncMinimap, settings.editor.minimap]);

  useEffect(() => {
    syncKeymap();
  }, [syncKeymap, settings.editor.keymap]);

  // ---------------------------------------------------------------- 挂文档

  /**
   * 把视图对到当前文档。
   *
   * 常驻 state 按路径存，所以切页签回来撤销栈、光标、滚动位置都还在。只有正文确实从
   * 外部变了（保存回写、磁盘重载、虚拟文档重开）才整篇换上——平时一个字都不动，
   * 否则撤销栈会被压一层空改动。
   */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    if (!doc || doc.loading) {
      const previous = pathRef.current;
      if (previous) {
        persistView(previous, view);
        setMounted(previous, null);
      }
      pathRef.current = null;
      wiredRef.current = null;
      view.setState(emptyState(permanentExtensions));
      measureRef.current();
      syncMinimap();
      syncKeymap();
      return;
    }

    const readOnly = doc.readOnly || doc.error !== null;
    const wired = wiredRef.current;
    const sameWiring =
      wired !== null &&
      pathRef.current !== null &&
      samePath(pathRef.current, doc.path) &&
      wired.language === doc.language &&
      wired.tabSize === settings.editor.tabSize &&
      wired.readOnly === readOnly &&
      wired.failed === (doc.error !== null);

    if (sameWiring) {
      const replace = textReplacement(view.state, doc.contents);
      if (replace) {
        swapping.current = true;
        view.dispatch(replace);
        swapping.current = false;
      }
      return;
    }

    const previous = pathRef.current;
    if (previous) {
      persistView(previous, view);
      setMounted(previous, null);
    }
    attach(view, doc.path, doc.contents, doc.language, readOnly);

    // 语法包是异步装进来的：落定后重配一次，语言 id 没变但 `languageOf` 有值了。
    // 这一趟不换正文、也不贴回旧光标：这篇可能已经打了几个字，贴回去会把光标弹到上次的位置。
    const wanted = doc.language;
    const forPath = doc.path;
    void loadLanguage(wanted, forPath).then(() => {
      const live = viewRef.current;
      if (!live || pathRef.current !== forPath) return;
      attach(live, forPath, textOf(live), wanted, live.state.readOnly, false);
    });
  }, [doc, settings.editor.tabSize, attach, syncMinimap]);

  // ---------------------------------------------------------------- 改动色条

  const baselinePropRef = useRef(changeBaseline);
  baselinePropRef.current = changeBaseline;
  const baselineKey = changeBaselineKey(changeBaseline);

  /**
   * 行号旁按整段改动画色条，小地图左侧那条细带用同一批标记。
   *
   * 打字只重算差异（防抖 200ms）；HEAD 原文按提交哈希缓存，状态没变就不再起 git。
   */
  useEffect(() => {
    let timer = 0;
    let ticket = 0;
    let readyKey = "";
    let original = "";

    const paint = () => {
      const view = viewRef.current;
      const spec = baselinePropRef.current;
      if (!view || !spec || readyKey !== changeBaselineKey(spec)) return;
      marksRef.current =
        !spec.allowEmpty && original === ""
          ? []
          : gutterChanges(original, textOf(view)).map((mark) => ({
              startLine: mark.startLine,
              endLine: mark.endLine,
              kind: mark.kind,
              edge: mark.edge,
            }));
      applyChangeMarks(view, marksRef.current);
      syncMinimap();
    };

    const load = () => {
      const spec = baselinePropRef.current;
      const mine = (ticket += 1);
      const key = changeBaselineKey(spec);
      window.clearTimeout(timer);
      const clear = () => {
        marksRef.current = [];
        const view = viewRef.current;
        if (view) applyChangeMarks(view, []);
        syncMinimap();
      };
      if (!spec) {
        readyKey = "";
        original = "";
        clear();
        return;
      }
      if (key === readyKey) {
        paint();
        return;
      }
      readyKey = "";
      clear();
      void headFile(spec.root, spec.head, spec.path).then((text) => {
        if (mine !== ticket) return;
        const current = baselinePropRef.current;
        if (!current || changeBaselineKey(current) !== key) return;
        readyKey = key;
        original = text;
        paint();
      });
    };

    refreshMarksRef.current = () => {
      window.clearTimeout(timer);
      // 换文档时整篇换上发生在 swapping 里，那一份正文已经是新的，不必再等打字防抖。
      timer = window.setTimeout(paint, swapping.current ? 0 : 200);
    };

    load();
    // 深浅色切换只影响小地图那条带的色值：行号槽的色条是 CSS 变量，自己会跟。
    const observer = new MutationObserver(() => syncMinimap());
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      window.clearTimeout(timer);
      ticket += 1;
      observer.disconnect();
      refreshMarksRef.current = () => {};
    };
  }, [baselineKey, syncMinimap, t]);

  // ---------------------------------------------------------------- ▶ 落点

  const targets = useMemo(
    () => gutterTargets(runConfigs, projectRoot, doc?.path ?? ""),
    [doc?.path, projectRoot, runConfigs]
  );
  const [pins, setPins] = useState<GutterPin[]>([]);
  const [scriptPin, setScriptPin] = useState<GutterPin | null>(null);
  const [httpPins, setHttpPins] = useState<GutterPin[]>([]);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const scriptPath = doc && scriptKindOf(doc.path) ? doc.path : null;
  const httpPath = doc && isHttpFile(doc.path) ? doc.path : null;
  const httpTargets = useMemo(() => {
    if (!doc || !httpPath) return [];
    return parseHttpFile(doc.contents).requests.map((request) => ({
      line: request.line,
      name: httpRequestLabel(request),
    }));
  }, [doc, httpPath]);
  const scriptPathRef = useRef(scriptPath);
  scriptPathRef.current = scriptPath;
  const httpPathRef = useRef(httpPath);
  httpPathRef.current = httpPath;
  const httpTargetsRef = useRef(httpTargets);
  httpTargetsRef.current = httpTargets;

  /**
   * 把行号换算成**文档坐标**，摆到「行号与代码之间」那条带上——IDEA 那颗就画在那儿。
   *
   * 这一栏是自己叠的：CodeMirror 的折叠扣槽占着行号右边，顺序改不动。整层挂进行号槽
   * 里，跟内容一起滚——早先按视口坐标摆，滚动时它一动不动，只能靠滚动事件重算。
   */
  const measure = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    ensurePinHost(view);
    const left = gutterWidth(view) - PIN_WIDTH - 3;
    const next: GutterPin[] = [];
    for (const target of targetsRef.current) {
      const top = lineTop(view, target.line);
      if (top === null) continue;
      const [first, ...rest] = target.configs;
      next.push({
        line: target.line,
        top,
        left,
        configs: target.configs,
        tip:
          rest.length === 0
            ? translateRef.current("run.gutter.run", { name: first.name })
            : translateRef.current("run.gutter.many", { name: first.name, count: target.configs.length }),
      });
    }
    setPins(next);

    const path = scriptPathRef.current;
    const head = path ? lineTop(view, 1) : null;
    setScriptPin(
      path && head !== null
        ? { line: 1, top: head, left, tip: translateRef.current("run.gutter.runInTerminal", { name: basenameOf(path) }) }
        : null
    );

    const httpNext: GutterPin[] = [];
    for (const target of httpTargetsRef.current) {
      const top = lineTop(view, target.line);
      if (top === null) continue;
      httpNext.push({ line: target.line, top, left, tip: translateRef.current("run.gutter.runHttp", { name: target.name }) });
    }
    setHttpPins(httpNext);
  }, []);
  measureRef.current = measure;

  useEffect(() => {
    measure();
  }, [measure, targets, t, scriptPath, httpTargets]);

  // ---------------------------------------------------------------- 搜索命中

  /**
   * 把搜索命中落成编辑器里的光标与选区。
   *
   * 后端给的列按字符数算，CodeMirror 按 UTF-16 码元算，行里有 emoji 这类代理对时两者
   * 会错开，所以拿真实行内容折算一遍再用。文档还在读时没有正文，等挂文档那一支跑完
   * 这个 effect 会因为 doc 变了再走一次，落点不会丢。
   */
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal || !doc || doc.loading) return;
    if (!samePath(doc.path, reveal.path)) return;
    const units = Array.from(lineText(view.state, reveal.line));
    const from = Math.min(Math.max(0, reveal.column - 1), units.length);
    const to = Math.min(from + reveal.length, units.length);
    revealRange(view, reveal.line, from, to);
    onRevealDone();
  }, [doc, onRevealDone, reveal]);

  // ---------------------------------------------------------------- 右键菜单

  /**
   * 右键菜单。
   *
   * 没选东西时也开——那正是「粘贴 / 全选」用得着的时候，原来这一条直接 return，
   * 于是落回 Chromium 自己那份英文菜单。现在一律拦掉原生菜单，只在编辑区里换成本应用的。
   */
  const menuAt = (event: ReactMouseEvent<HTMLDivElement>) => {
    const view = viewRef.current;
    if (!view) return;
    event.preventDefault();
    event.stopPropagation();
    if (!doc?.path) return;
    const readOnly = view.state.readOnly;
    const selection = selectedRange(view);
    const caret = view.state.selection.main.head;
    const caretLine = view.state.doc.lineAt(caret).number;
    const from = selection?.from ?? caret;
    const to = selection?.to ?? caret;
    const startLine = selection?.line ?? caretLine;
    const endLine = selection?.endLine ?? caretLine;
    const items: MenuItem[] = [
      ...(selection
        ? [
            // 复制出去的那段带这篇文档的行尾：粘到编辑器外的 CRLF 文件里不该变成 LF
            // （原来 Monaco 的 getValueInRange 就是按 model 的 EOL 给的）。
            {
              label: t("action.copy"),
              onSelect: () => void navigator.clipboard.writeText(toDiskText(selectedText(view), endingRef.current)),
            },
            {
              label: t("menu.cut"),
              disabled: readOnly,
              onSelect: () => {
                void navigator.clipboard.writeText(toDiskText(selectedText(view), endingRef.current));
                replaceRange(view, selection.from, selection.to, "");
              },
            },
          ]
        : []),
      {
        label: t("action.paste"),
        disabled: readOnly,
        onSelect: () =>
          void navigator.clipboard
            .readText()
            .then((value) => {
              replaceRange(view, from, to, value);
            })
            .catch(() => {}),
      },
      { label: t("action.selectAll"), onSelect: () => selectAll(view) },
      { separator: true },
      aiInputMenu({ kind: "file", path: doc.path, startLine, endLine }),
    ];
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  return (
    <div className="code-host">
      <div ref={hostRef} className="code-editor" onContextMenuCapture={menuAt} />
      {pinHost
        ? createPortal(
            <div className="run-gutter-layer">
              {pins.map((pin) => (
                <button
                  key={pin.line}
                  type="button"
                  className="run-gutter-run"
                  style={{ top: pin.top, left: pin.left }}
                  data-tip={pin.tip}
                  aria-label={pin.tip}
                  onClick={() => pin.configs && onRunConfig(pin.configs)}
                />
              ))}
              {scriptPin && scriptPath ? (
                <button
                  type="button"
                  className="run-gutter-run"
                  style={{ top: scriptPin.top, left: scriptPin.left }}
                  data-tip={scriptPin.tip}
                  aria-label={scriptPin.tip}
                  onClick={() => onRunScript(scriptPath)}
                />
              ) : null}
              {httpPins.map((pin) => (
                <button
                  key={`http-${pin.line}`}
                  type="button"
                  className="run-gutter-run"
                  style={{ top: pin.top, left: pin.left }}
                  data-tip={pin.tip}
                  aria-label={pin.tip}
                  onClick={() => {
                    const path = httpPathRef.current;
                    if (!path) return;
                    const view = viewRef.current;
                    const contents = view ? toDiskText(textOf(view), endingRef.current) : (doc?.contents ?? "");
                    onRunHttp(path, pin.line, contents);
                  }}
                />
              ))}
            </div>,
            pinHost
          )
        : null}
      {contextMenu ? <ContextMenu anchor={contextMenu} onClose={() => setContextMenu(null)} /> : null}
    </div>
  );
});
