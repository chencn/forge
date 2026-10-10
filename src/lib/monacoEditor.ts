/**
 * monaco 本体：编辑器实例、worker 装配、主题与 model 生命周期。
 *
 * 只有这个模块 import `monaco-editor`。组件需要编辑器时引这里，
 * 只要扩展名表 / 字体串 / 语言名时引 `monacoEnv.ts`——两者的体积差着两个数量级。
 */
import * as monaco from "monaco-editor";
import { tokenColor } from "./color";
// monaco 0.57 的 exports 映射把 ./esm/vs/* 挂在包根下，worker 要按新写法引。
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import {
  attachMonacoBridge,
  keymapScheme,
  onKeymapScheme,
  openTargetInEditor,
  themeToken,
} from "./monacoEnv";
import { applyKeymap } from "./keymap";

// 走本地 worker，不依赖 CDN：桌面应用离线也要能补全和高亮。
(globalThis as unknown as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
      case "xml":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// 配置 Monaco 内置 TypeScript / JavaScript 编译器选项：
// 避免默认空配置导致 moduleResolution 退回 Classic 从而产生 TS2792 报错，以及开启 React JSX 支持。
if (monaco.typescript) {
  const compilerOptions: monaco.typescript.CompilerOptions = {
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    allowNonTsExtensions: true,
    noEmit: true,
  };
  monaco.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
  monaco.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);

  // 通配模块声明：内置 Worker 无磁盘 node_modules 访问能力，提供后备声明避免第三方包导入误报 TS2792/TS2307
  const fallbackDts = "declare module '*';\ndeclare module '*.css';\ndeclare module '*.svg';\n";
  monaco.typescript.typescriptDefaults.addExtraLib(fallbackDts, "ts:fallback-modules.d.ts");
  monaco.typescript.javascriptDefaults.addExtraLib(fallbackDts, "ts:fallback-modules.d.ts");
}

/**
 * 跳到别的文件时的打开处理。
 *
 * Monaco 默认只认「当前 model」，语言服务返回的定义落在别的文件时什么都不做，
 * 跨文件跳转就成了点了没反应。这里把目标交给 App 那层（读文件、开标签、定位）。
 * 目标就是当前文件时必须返回 false 交回 Monaco：它自己会把光标挪过去，
 * 拦下来转交 App 反而绕一圈、还落不到点上。
 */
monaco.editor.registerEditorOpener({
  openCodeEditor(source, resource, selectionOrPosition) {
    if (resource.scheme !== "file") return false;
    const current = source.getModel()?.uri;
    if (current && current.toString() === resource.toString()) return false;
    const line =
      selectionOrPosition && "startLineNumber" in selectionOrPosition
        ? selectionOrPosition.startLineNumber
        : (selectionOrPosition?.lineNumber ?? 1);
    const column =
      selectionOrPosition && "startColumn" in selectionOrPosition
        ? selectionOrPosition.startColumn
        : (selectionOrPosition?.column ?? 1);
    return openTargetInEditor(resource.fsPath, line, column);
  },
});

/** 文件 URI，让同一份文件在 Monaco 里只对应一个 model（保留撤销栈）。 */
export function modelUri(path: string): monaco.Uri {
  return monaco.Uri.file(path);
}

/** 关闭标签时释放 model，否则切回来还是旧内容。 */
function disposeModel(path: string): void {
  monaco.editor.getModel(modelUri(path))?.dispose();
}

function disposeAllModels(): void {
  for (const model of monaco.editor.getModels()) model.dispose();
}

/**
 * 编辑器里选中的那段文字，给「在文件里查找」预填。
 *
 * 取的是 IDEA 那条 `FindUtil.initStringToFindWithSelection` 的做法：读有文字焦点的那台
 * 编辑器的选区，超过一万字符就当没选，整份压缩过的 js 灌进搜索框只会搜不出东西。
 * 焦点在终端或输入框里时返回空串，搜索词保持上次的。
 */
function selectedText(limit: number): string {
  const editor = monaco.editor.getEditors().find((item) => item.hasTextFocus());
  if (!editor) return "";
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection || selection.isEmpty()) return "";
  const text = model.getValueInRange(selection);
  return text.length > limit ? "" : text;
}

/** 语言 id → monaco 注册的第一条别名，比 `monacoEnv` 那份静态兜底准。 */
let labelByLanguage: Map<string, string> | null = null;

function languageLabel(id: string): string {
  if (!labelByLanguage) {
    labelByLanguage = new Map<string, string>();
    for (const entry of monaco.languages.getLanguages()) {
      const alias = entry.aliases?.find((name) => name.length > 0);
      if (alias) labelByLanguage.set(entry.id, alias);
    }
  }
  return labelByLanguage.get(id) ?? "";
}

/** 按当前 CSS 变量注册 Monaco 主题，深浅色只有一份来源。 */
export function applyMonacoTheme(dark: boolean): void {
  const background = tokenColor("--bg-primary") || (dark ? "#0a0a0a" : "#ffffff");
  const foreground = tokenColor("--text-primary") || (dark ? "#f5f5f5" : "#111827");
  const muted = tokenColor("--text-muted") || "#9ca3af";
  const selection = tokenColor("--selection-bg") || "#3b82f633";
  const lineHighlight = dark ? "#1a1a1a" : "#f3f4f6";
  const widgetBorder = tokenColor("--border-color") || "#e5e7eb";
  const island = tokenColor("--surface-island-strong") || (dark ? "#181818" : "#ffffff");
  const highlightBg = tokenColor("--accent-blue-bg");
  const highlightText = tokenColor("--accent-blue-text");

  monaco.editor.defineTheme("forge", {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": background,
      "editor.foreground": foreground,
      "editorLineNumber.foreground": muted,
      "editorLineNumber.activeForeground": foreground,
      "editor.selectionBackground": selection,
      "editor.lineHighlightBackground": lineHighlight,
      "editorWidget.background": background,
      "editorWidget.border": widgetBorder,
      "editorSuggestWidget.background": island,
      "editorSuggestWidget.border": widgetBorder,
      "editorSuggestWidget.selectedBackground": highlightBg,
      "editorSuggestWidget.selectedForeground": highlightText,
      "editorHoverWidget.background": island,
      "editorHoverWidget.border": widgetBorder,
      // 编辑器自带的右键菜单不读 CSS，颜色只能从主题里给。
      "menu.background": themeToken("--bg-tertiary"),
      "menu.foreground": foreground,
      "menu.separatorBackground": widgetBorder,
      "widget.shadow": dark ? "#000000aa" : "#0f172a40",
      "diffEditor.insertedTextBackground": "#22c55e22",
      "diffEditor.removedTextBackground": "#ef444422",
      "diffEditor.insertedLineBackground": "#22c55e14",
      "diffEditor.removedLineBackground": "#ef444414",
      "scrollbarSlider.background": selection,
    },
  });
  monaco.editor.setTheme("forge");
}

attachMonacoBridge({ disposeModel, disposeAllModels, selectedText, languageLabel });

/**
 * monaco 的主题归属在这一头，不在任何组件上。
 *
 * `useSettings` 把算出来的主题写进 `<html data-theme>`，这里盯那一处属性：
 * 挂组件身上迟早会漏——开着比对页时编辑区那台 code editor 根本没挂载，切了主题没人为 monaco
 * 重设一遍，比对两侧的底色就停在旧主题上。属性一落地就重取 CSS 变量再定义一次，
 * 所有已存在的编辑器（含比对）跟着翻。
 */
const darkNow = () => document.documentElement.dataset.theme === "dark";

applyMonacoTheme(darkNow());
new MutationObserver(() => applyMonacoTheme(darkNow())).observe(document.documentElement, {
  attributeFilter: ["data-theme"],
});

/**
 * 键位方案装在 monaco 的键绑定服务上，换方案先把上一套整体撤掉。
 *
 * 这一段的时机跟着编辑器模块走：App 只往 `monacoEnv` 里存值，
 * 首屏没有编辑器时不必为几条键绑定把 monaco 加载起来。
 */
let keymapRules: monaco.IDisposable | null = null;
const installKeymap = (scheme: ReturnType<typeof keymapScheme>) => {
  keymapRules?.dispose();
  keymapRules = applyKeymap(scheme);
};
installKeymap(keymapScheme());
onKeymapScheme(installKeymap);

export { monaco };
