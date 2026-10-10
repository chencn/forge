import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modelUri, monaco } from "../lib/monacoEditor";
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

interface CodeEditorProps {
  /** 当前标签对应的文档；为 null 时编辑器留空。 */
  document: OpenDocument | null;
  onChange: (path: string, contents: string) => void;
  onSave: () => void;
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
}

export default function CodeEditor({
  document,
  onChange,
  onSave,
  reveal,
  onRevealDone,
  runConfigs,
  projectRoot,
  onRunConfig,
  onRunScript,
}: CodeEditorProps) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const hostRef = useRef<HTMLDivElement>(null);
  /** 编辑器实例换过一次就 +1：挂模型那一支靠它认出「实例是新的，得重挂」。 */
  const [wiringNonce, setWiringNonce] = useState(0);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  /** 换 model 期间抑制一次回调，避免把上一个文件的内容写进新文档。 */
  const swapping = useRef(false);
  const pathRef = useRef<string | null>(null);
  /**
   * 编辑器这边交出去的最新一份，连同它是哪条路径的。
   * 用它认出「文档里的正文是我刚敲的那一份」，那种不用再取一遍全文来比。
   */
  const mirrorRef = useRef<{ path: string; text: string }>({ path: "", text: "" });
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
  const onRunRef = useRef(onRunConfig);
  /** 编辑器偏好在创建时读一次，之后靠下面的同步 effect 改，所以用 ref 传进挂载 effect。 */
  const optionsRef = useRef(settings.editor);
  optionsRef.current = settings.editor;
  changeRef.current = onChange;
  saveRef.current = onSave;
  onRunRef.current = onRunConfig;

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
      mirrorRef.current = { path, text };
      changeRef.current(path, text);
    });

    // 落点是屏幕坐标：滚动、换行高、换 model、正文增减行都会让它挪位置，四样都问一遍。
    const sync = [
      editor.onDidScrollChange(() => measureRef.current()),
      editor.onDidLayoutChange(() => measureRef.current()),
      editor.onDidChangeModel(() => measureRef.current()),
      editor.onDidChangeModelContent(() => measureRef.current()),
    ];

    return () => {
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
      if (
        mirrorRef.current.path !== document.path ||
        mirrorRef.current.text !== document.contents
      ) {
        swapping.current = true;
        model.setValue(document.contents);
        swapping.current = false;
        mirrorRef.current = { path: document.path, text: document.contents };
      }
      return;
    }

    const uri = modelUri(document.path);
    let next = monaco.editor.getModel(uri);
    const fresh = next === null;
    swapping.current = true;
    if (!next) {
      next = monaco.editor.createModel(document.contents, document.language, uri);
    }
    next.updateOptions({ tabSize: settings.editor.tabSize, insertSpaces: true });
    editor.setModel(next);
    next.setEOL(
      document.lineEnding === "crlf"
        ? monaco.editor.EndOfLineSequence.CRLF
        : monaco.editor.EndOfLineSequence.LF
    );
    editor.updateOptions({ readOnly, domReadOnly: readOnly });
    // 切过来的 model 里可能是上次编辑留下的那一份，跟文档对不上时以文档为准
    // （从 git 历史开的那份虚拟文档每一遍都是新内容，就靠这一步落进去）。
    // 判据要和「仅正文」那支一致，不能只看路径：挂模型的某一档变了但正文也同时换了时
    // （行尾在外部被改、读取失败后重试成功），只比路径会把新正文漏掉，
    // 而 wiredRef 已记成新档，之后每遍都判「无需再挂」——编辑器就长期停在旧文本上。
    if (
      !fresh &&
      (mirrorRef.current.path !== document.path || mirrorRef.current.text !== document.contents)
    ) {
      next.setValue(document.contents);
    }
    // 记「我们刚推下去的那一份」，不记 `next.getValue()`：后者按 model 的行尾渲染，
    // CRLF 文档下它和 `contents` 只差在行尾，下一遍会被判成不一致而白重设一次正文。
    mirrorRef.current = { path: document.path, text: document.contents };
    pathRef.current = document.path;
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
}
