/**
 * 编辑器无关的那半份 monaco 设施：扩展名表、字体串、语言显示名、模型释放与选区读取。
 *
 * 这个模块**不许 import monaco-editor**：首屏只开图片、只读 Git 面板的用户
 * 不应该为了一个扩展名映射把 `editor.api`（约 2.7MB）拖进启动路径。
 * 真正需要编辑器实例的四件事（释放 model、读选区、取语言别名、按键位方案）
 * 由 `monacoEditor.ts` 在自身加载时通过 `attachMonacoBridge` 挂上来；
 * 没挂上时它们要么是无意义操作（盘上没有 model 可读），要么退回本模块的静态表。
 */
import { toHex } from "./color";
import type { KeymapScheme } from "./settings";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  xml: "xml",
  rs: "rust",
  go: "go",
  py: "python",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  bat: "bat",
  cmd: "bat",
  ps1: "powershell",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  dockerfile: "dockerfile",
  graphql: "graphql",
  lua: "lua",
  r: "r",
  dart: "dart",
};

/** 文件名到语言的少数特例，扩展名表覆盖不到。 */
const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitignore": "ini",
  ".env": "ini",
};

/** 路径 → Monaco 语言 id，识别不到时退回纯文本。 */
export function languageForPath(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? "").toLocaleLowerCase();
  if (LANGUAGE_BY_NAME[name]) return LANGUAGE_BY_NAME[name];
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1)] ?? "plaintext";
}

/**
 * monaco 没注册别名、或编辑器还没加载时的兜底显示名。
 * 取值与 monaco 各语言的第一条别名一致，加载完成后由 bridge 那份覆盖。
 */
const LANGUAGE_LABELS: Record<string, string> = {
  plaintext: "Plain Text",
  typescript: "TypeScript",
  javascript: "JavaScript",
  json: "JSON",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  xml: "XML",
  rust: "Rust",
  go: "Go",
  python: "Python",
  java: "Java",
  kotlin: "Kotlin",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  ruby: "Ruby",
  php: "PHP",
  swift: "Swift",
  shell: "Shell",
  bat: "Batch",
  powershell: "PowerShell",
  sql: "SQL",
  markdown: "Markdown",
  yaml: "YAML",
  ini: "Ini",
  dockerfile: "Dockerfile",
  graphql: "GraphQL",
  lua: "Lua",
  r: "R",
  dart: "Dart",
  makefile: "Makefile",
  diff: "Diff",
};

/** 状态栏要给人看的语言名，不是 monaco 的内部 id。 */
export function languageLabel(id: string): string {
  return bridge?.languageLabel(id) ?? LANGUAGE_LABELS[id] ?? id;
}

/**
 * 一项语言服务所管的那几门语言的显示名，多种语言并列。
 *
 * 设置页与状态条显示它，不显示服务名：`csharp-ls`、`intelephense` 是进程的名字，
 * 对应 C# 与 PHP 两门语言，两者混着写会让人以为列表里多了几个看不懂的语言。
 */
export function languageNames(ids: string[]): string {
  return ids.map(languageLabel).join(" / ");
}

function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * 等宽字体沿用 tokens.css 的取值，末尾补一层 CJK 等宽回退：
 * 拉丁等宽字体没有全角括号、引号这些标点，Monaco 量不到字形就画方框。
 */
const CJK_MONO = '"Microsoft YaHei Mono", "Noto Sans Mono CJK SC", "MS Gothic"';

export function monoFont(): string {
  const base = cssToken("--font-mono").replace(/,\s*monospace\s*$/, "");
  return base ? `${base}, ${CJK_MONO}, monospace` : `Menlo, Consolas, ${CJK_MONO}, monospace`;
}

/** 取当前 CSS 变量的颜色值，供编辑器主题与终端配色用。 */
export function themeToken(name: string): string {
  return toHex(cssToken(name));
}

/** 编辑器模块加载后挂上来的能力；null 表示首屏还没碰过编辑器。 */
interface MonacoBridge {
  disposeModel(path: string): void;
  disposeAllModels(): void;
  selectedText(limit: number): string;
  languageLabel(id: string): string;
}

let bridge: MonacoBridge | null = null;

/** 由 `monacoEditor.ts` 在模块初始化时调用，把自己接进这四条门面。 */
export function attachMonacoBridge(next: MonacoBridge): void {
  bridge = next;
}

/**
 * 跳到别的文件时的落点处理，由 App 注入。
 *
 * 语言服务的「跳转到定义」要打开的是另一份文件，Monaco 默认对非当前 model 什么都不做，
 * 所以必须在编辑器模块里注册 opener；而真正把文件读进来、开标签、定位是文档那一层的事，
 * 编辑器模块拿不到，只能留一个门面让 App 接上。
 */
type OpenTargetHandler = (path: string, line: number, column: number) => boolean;
let openTarget: OpenTargetHandler | null = null;

export function setOpenTargetHandler(handler: OpenTargetHandler | null): void {
  openTarget = handler;
}

/** 由编辑器模块的 opener 调用；没接上处理者时返回 false，让 Monaco 走它自己的兜底。 */
export function openTargetInEditor(path: string, line: number, column: number): boolean {
  return openTarget ? openTarget(path, line, column) : false;
}

/** 关闭标签时释放 model，否则切回来还是旧内容。编辑器没加载过时无事可做。 */
export function disposeModel(path: string): void {
  bridge?.disposeModel(path);
}

export function disposeAllModels(): void {
  bridge?.disposeAllModels();
}

/**
 * 编辑器里选中的那段文字，给「在文件里查找」预填。
 *
 * 没有编辑器实例时必然没有选区，直接给空串——这也是这条门面可以留在本模块的理由：
 * 取选区不需要为此把编辑器加载起来。
 */
export function selectedText(limit = 10000): string {
  return bridge?.selectedText(limit) ?? "";
}

/**
 * 键位方案存在这一层，而不是让 App 直接调 `applyKeymap`：
 * 那条命令需要 monaco，而换方案的时机（开机就装）比编辑器本身早得多。
 * 编辑器模块加载时取当前值装一次，之后跟着这里的变更走。
 */
let scheme: KeymapScheme = "idea";
const schemeListeners = new Set<(next: KeymapScheme) => void>();

export function setKeymapScheme(next: KeymapScheme): void {
  if (scheme === next) return;
  scheme = next;
  for (const notify of schemeListeners) notify(next);
}

export function keymapScheme(): KeymapScheme {
  return scheme;
}

/** 订阅方案变化，返回退订。 */
export function onKeymapScheme(listener: (next: KeymapScheme) => void): () => void {
  schemeListeners.add(listener);
  return () => {
    schemeListeners.delete(listener);
  };
}
