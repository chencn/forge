import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { modelUri, monaco } from "../lib/monacoEditor";
import { isRetainingModels } from "../lib/modelRetention";
import { monoFont } from "../lib/monacoEnv";
import { basenameOf, samePath } from "../lib/format";
import { gutterTargets } from "../lib/runMarkers";
import { scriptKindOf } from "../lib/scriptRun";
import type { RunConfiguration } from "../lib/runConfigs";
import { useSettings } from "../hooks/useSettings";
import { useI18n } from "../i18n";
import type { OpenDocument, RevealTarget } from "../hooks/useDocuments";

/** 一颗 ▶ 占多宽。行号与代码之间那条带默认 10px，这里留出 1px 余量给指针命中。 */
const PIN_WIDTH = 12;

/**
 * 按文件路径记录每个 Monaco Model 最近一次同步的正文与编辑器视图状态（光标、选区、滚动位置）。
 * 放在模块级而非组件内部单槽 ref：切页签或跨工作区切根再切回时，不会因为单槽 path 变化而误调
 * `model.setValue()` 冲掉撤销栈，也能在编辑器跨根重挂后原样恢复光标与滚动位置。
 */
const mirrorByPath = new Map<string, string>();
const viewStateByPath = new Map<string, monaco.editor.ICodeEditorViewState | null>();

monaco.editor.onWillDisposeModel((model) => {
  const fsPath = model.uri.fsPath;
  mirrorByPath.delete(fsPath);
  for (const key of Array.from(mirrorByPath.keys())) {
    if (samePath(key, fsPath)) mirrorByPath.delete(key);
  }
  // 超限回收时 model 会关掉再重建，光标得留着。关标签不走这条，记录一起丢掉。
  if (isRetainingModels()) return;
  viewStateByPath.delete(fsPath);
  for (const key of Array.from(viewStateByPath.keys())) {
    if (samePath(key, fsPath)) viewStateByPath.delete(key);
  }
});

/** 换算到屏幕坐标之后的一个落点。 */
interface RunGutterPin {
  line: number;
  top: number;
  left: number;
  configs: RunConfiguration[];
  tip: string;
}

/** 脚本文件第 1 行那颗 ▶：它不来自运行配置，点了是把脚本发到终端里跑。 */
interface ScriptGutterPin {
  top: number;
  left: number;
  tip: string;
}

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
  /** 滚动位置变化时的比例回调（0~1），供分栏模式下与预览区联动。 */
  onScrollRatio?: (ratio: number) => void;
}

export default forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  {
    document,
    onChange,
    onSave,
    onBlur,
    reveal,
    onRevealDone,
    runConfigs,
    projectRoot,
    onRunConfig,
    onRunScript,
    onScrollRatio,
  }: CodeEditorProps,
  ref
) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const hostRef = useRef<HTMLDivElement>(null);
  /** 编辑器实例换过一次就 +1：挂模型那一支靠它认出「实例是新的，得重挂」。 */
  const [wiringNonce, setWiringNonce] = useState(0);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  /** 换 model 期间抑制一次回调，避免把上一个文件的内容写进新文档。 */
  const swapping = useRef(false);
  const pathRef = useRef<string | null>(null);
  /** model 是按哪一份文档的条件挂上的：这几样没变就不必再走 setModel / updateOptions。 */
  const wiredRef = useRef<{
    path: string;
    language: string;
    tabSize: number;
    readOnly: boolean;
    failed: boolean;
    lineEnding: string;
  } | null>(null);
  const changeRef = useRef(onChange);
  const saveRef = useRef(onSave);
  const blurRef = useRef(onBlur);
  const onRunRef = useRef(onRunConfig);
  /** 编辑器偏好在创建时读一次，之后靠下面的同步 effect 改，所以用 ref 传进挂载 effect。 */
  const optionsRef = useRef(settings.editor);
  optionsRef.current = settings.editor;
  changeRef.current = onChange;
  saveRef.current = onSave;
  blurRef.current = onBlur;
  onRunRef.current = onRunConfig;
  const onScrollRatioRef = useRef(onScrollRatio);
  onScrollRatioRef.current = onScrollRatio;

  useImperativeHandle(
    ref,
    () => ({
      setScrollRatio: (ratio: number) => {
        const editor = editorRef.current;
        if (!editor) return;
        const scrollHeight = editor.getScrollHeight();
        const clientHeight = editor.getLayoutInfo().height;
        const max = scrollHeight - clientHeight;
        if (max > 0) {
          editor.setScrollTop(Math.round(ratio * max));
        }
      },
      getScrollRatio: () => {
        const editor = editorRef.current;
        if (!editor) return 0;
        const scrollHeight = editor.getScrollHeight();
        const clientHeight = editor.getLayoutInfo().height;
        const max = scrollHeight - clientHeight;
        return max > 0 ? editor.getScrollTop() / max : 0;
      },
    }),
    []
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      value: "",
      readOnly: true,
      automaticLayout: true,
      fontFamily: monoFont(),
      fontSize: optionsRef.current.fontSize,
      lineHeight: 20,
      fontLigatures: false,
      minimap: { enabled: optionsRef.current.minimap, maxColumn: 90 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderLineHighlight: "all",
      padding: { top: 10, bottom: 12 },
      scrollbar: { verticalScrollbarSize: 11, horizontalScrollbarSize: 11, useShadows: false },
      overviewRulerLanes: 2,
      fixedOverflowWidgets: true,
      // monaco 给 hover 只留一档偏好：偏上时若上方放不下，它不翻到下方，而是把整块夹到
      // 窗口顶上 22px 处，于是浮框和波浪线彻底脱开。偏下没有这条夹取，落点始终贴着那一行。
      hover: { above: false },
      // 开着它时 Chromium 自己画右键菜单，语言走不到 monaco 的中文文案上。
      editContext: false,
    });
    editorRef.current = editor;
    // 换掉创建参数会重跑这一支而不会重跑挂模型那一支（它的依赖里没有这些），
    // 不清空挂接记录的话新建的那台编辑器会停在它自带的空模型上，正文一个字都不显示。
    wiredRef.current = null;
    setWiringNonce((current) => current + 1);

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
    const subscription = editor.onDidChangeModelContent(() => {
      if (swapping.current) return;
      const path = pathRef.current;
      const model = editor.getModel();
      if (!path || !model) return;
      const text = model.getValue();
      mirrorByPath.set(path, text);
      changeRef.current(path, text);
    });

    // 落点是屏幕坐标：滚动、换行高、换 model、正文增减行都会让它挪位置，四样都问一遍。
    // 失焦监听用 onDidBlurEditorWidget：打开内置查找框仍算在编辑器内，点向目录树/终端/标签栏才触发失焦保存。
    const saveCurrentViewState = () => {
      if (swapping.current) return;
      const currentPath = pathRef.current;
      if (currentPath && editor.getModel()) {
        viewStateByPath.set(currentPath, editor.saveViewState());
      }
    };
    const sync = [
      editor.onDidScrollChange((e) => {
        saveCurrentViewState();
        measureRef.current();
        if (e.scrollTopChanged) {
          const scrollHeight = editor.getScrollHeight();
          const clientHeight = editor.getLayoutInfo().height;
          const max = scrollHeight - clientHeight;
          if (max > 0) {
            onScrollRatioRef.current?.(e.scrollTop / max);
          }
        }
      }),
      editor.onDidChangeCursorSelection(() => saveCurrentViewState()),
      editor.onDidLayoutChange(() => measureRef.current()),
      editor.onDidChangeModel(() => measureRef.current()),
      editor.onDidChangeModelContent(() => measureRef.current()),
      editor.onDidBlurEditorWidget(() => blurRef.current?.()),
    ];

    return () => {
      saveCurrentViewState();
      for (const handle of sync) handle.dispose();
      subscription.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({
      fontSize: settings.editor.fontSize,
      minimap: { enabled: settings.editor.minimap, maxColumn: 90 },
    });
  }, [settings.editor.fontSize, settings.editor.minimap]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (!document || document.loading) {
      // 内容还没读回来时不建 model，否则会用空串建一个再也更新不到的模型。
      if (pathRef.current && editor.getModel()) {
        viewStateByPath.set(pathRef.current, editor.saveViewState());
      }
      editor.setModel(null);
      pathRef.current = null;
      wiredRef.current = null;
      return;
    }

    const readOnly = document.readOnly || document.error !== null;
    const wired = wiredRef.current;
    const sameWiring =
      wired !== null &&
      samePath(wired.path, document.path) &&
      wired.language === document.language &&
      wired.tabSize === settings.editor.tabSize &&
      wired.readOnly === readOnly &&
      wired.failed === (document.error !== null) &&
      wired.lineEnding === document.lineEnding;

    const model = sameWiring ? monaco.editor.getModel(modelUri(document.path)) : null;
    if (sameWiring && model) {
      // 挂模型的那几样条件没变，只剩正文。是编辑器自己交出去的那一份就不动：
      // 原来这里每次渲染都调一次 model.getValue()，把整份文件再拷一遍来比相等。
      if (mirrorByPath.get(document.path) !== document.contents) {
        swapping.current = true;
        model.setValue(document.contents);
        swapping.current = false;
        mirrorByPath.set(document.path, document.contents);
      }
      return;
    }

    // 切换 Model 前先把上一篇文档的光标与滚动位置存起来。
    if (pathRef.current && editor.getModel()) {
      viewStateByPath.set(pathRef.current, editor.saveViewState());
    }

    const uri = modelUri(document.path);
    let next = monaco.editor.getModel(uri);
    const fresh = next === null;
    swapping.current = true;
    if (!next) {
      next = monaco.editor.createModel(document.contents, document.language, uri);
    } else if (next.getLanguageId() !== document.language) {
      monaco.editor.setModelLanguage(next, document.language);
    }
    next.updateOptions({ tabSize: settings.editor.tabSize, insertSpaces: true });
    editor.setModel(next);
    next.setEOL(
      document.lineEnding === "crlf"
        ? monaco.editor.EndOfLineSequence.CRLF
        : monaco.editor.EndOfLineSequence.LF
    );
    editor.updateOptions({ readOnly, domReadOnly: readOnly });
    // 只有当文档正文在外部或虚拟文档重开时真的变了，才调用 setValue；
    // 平时切页签或切工程根回来时正文一致，绝不调 setValue，从而完整保留 Model 的撤销栈。
    if (!fresh && mirrorByPath.get(document.path) !== document.contents) {
      next.setValue(document.contents);
    }
    mirrorByPath.set(document.path, document.contents);
    pathRef.current = document.path;
    const savedView = viewStateByPath.get(document.path);
    if (savedView) {
      editor.restoreViewState(savedView);
    }
    swapping.current = false;
    wiredRef.current = {
      path: document.path,
      language: document.language,
      tabSize: settings.editor.tabSize,
      readOnly,
      failed: document.error !== null,
      lineEnding: document.lineEnding,
    };
  }, [document, settings.editor.tabSize, wiringNonce]);

  /**
   * 装订线上那几颗 ▶：这篇文档里哪几行有可跑的声明。
   *
   * 落点跟着上一次扫描走，和下面那份配置列表是同一份快照；改完构建文件要按「重新扫描」才刷新。
   */
  const targets = useMemo(
    () => gutterTargets(runConfigs, projectRoot, document?.path ?? ""),
    [document?.path, projectRoot, runConfigs]
  );

  /** 一颗 ▶：这一行的落点，以及点了要交出哪几条配置。 */
  const [pins, setPins] = useState<RunGutterPin[]>([]);
  /** 脚本文件第 1 行那颗 ▶：点了把脚本发到终端。非脚本文件时为 null。 */
  const [scriptPin, setScriptPin] = useState<ScriptGutterPin | null>(null);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  /** 当前文档是不是脚本文件；装订线那颗 ▶ 与「运行配置」那套互不相干。 */
  const scriptPath = document && scriptKindOf(document.path) ? document.path : null;
  const scriptPathRef = useRef(scriptPath);
  scriptPathRef.current = scriptPath;
  const translateRef = useRef(t);
  translateRef.current = t;

  /**
   * 把行号换算成屏幕坐标，摆到「行号与代码之间」那条带上——IDEA 那颗就画在那儿。
   *
   * monaco 的 `glyphMargin` 只能待在行号左边，布局顺序改不动，所以这一栏自己叠。
   * 行在视口外时 `getScrolledVisiblePosition` 返回 null，那一行干脆不摆：浮层不裁剪，
   * 气泡要能出到代码区上方。
   */
  const measure = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const layout = editor.getLayoutInfo();
    const left = layout.decorationsLeft + (layout.decorationsWidth - PIN_WIDTH) / 2;
    const next: RunGutterPin[] = [];
    for (const target of targetsRef.current) {
      const at = editor.getScrolledVisiblePosition({ lineNumber: target.line, column: 1 });
      if (!at) continue;
      const [first, ...rest] = target.configs;
      next.push({
        line: target.line,
        top: at.top,
        left,
        configs: target.configs,
        tip:
          rest.length === 0
            ? translateRef.current("run.gutter.run", { name: first.name })
            : translateRef.current("run.gutter.many", {
                name: first.name,
                count: target.configs.length,
              }),
      });
    }
    setPins(next);

    // 脚本那颗落在第 1 行；文件没打开、或不是脚本时收掉。
    const path = scriptPathRef.current;
    const head = path
      ? editor.getScrolledVisiblePosition({ lineNumber: 1, column: 1 })
      : null;
    setScriptPin(
      path && head
        ? {
            top: head.top,
            left,
            tip: translateRef.current("run.gutter.runInTerminal", { name: basenameOf(path) }),
          }
        : null
    );
  }, []);
  const measureRef = useRef(measure);
  measureRef.current = measure;

  useEffect(() => {
    measure();
  }, [measure, targets, t, scriptPath]);

  /**
   * 把搜索命中落成编辑器里的光标与选区。
   *
   * 后端给的列按字符数算，monaco 按 UTF-16 码元算，行里有 emoji 这类代理对时两者会错开，
   * 所以拿真实行内容折算一遍再用。文档还在读的时候 model 不存在，等 model effect 跑完
   * 这个 effect 会因为 document 变了再走一次，落点不会丢。
   */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal || !document || document.loading) return;
    if (!samePath(document.path, reveal.path)) return;
    const model = editor.getModel();
    if (!model) return;

    const units = Array.from(model.getLineContent(reveal.line));
    const from = Math.min(Math.max(0, reveal.column - 1), units.length);
    const to = Math.min(from + reveal.length, units.length);
    editor.revealLineInCenter(reveal.line);
    editor.setSelection({
      startLineNumber: reveal.line,
      startColumn: from + 1,
      endLineNumber: reveal.line,
      endColumn: to + 1,
    });
    editor.focus();
    onRevealDone();
  }, [document, onRevealDone, reveal]);

  return (
    <div className="code-host">
      <div ref={hostRef} className="code-editor" />
      <div className="run-gutter-layer">
        {pins.map((pin) => (
          <button
            key={pin.line}
            type="button"
            className="run-gutter-run"
            style={{ top: pin.top, left: pin.left }}
            data-tip={pin.tip}
            aria-label={pin.tip}
            onClick={() => onRunConfig(pin.configs)}
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
      </div>
    </div>
  );
});
