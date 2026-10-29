/**
 * 编辑器无关的那半份设施：扩展名表、字体串、语言显示名、文档 state 释放与选区读取。
 *
 * 这个模块**不许 import 编辑器引擎**：首屏只开图片、只读 Git 面板的用户不应该为了
 * 一个扩展名映射把整份 CodeMirror（连语法包）拖进启动路径。
 * 真正需要编辑器实例的两件事（释放文档 state、读选区）由引擎（`cmEditor.ts`）
 * 在自身加载时通过 `attachEditorBridge` 挂上来；没挂上时它们要么是无意义操作
 * （盘上没有 state 可读），要么退回本模块的静态表。
 */
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
  kts: "kotlin",
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
  cfg: "ini",
  properties: "properties",
  gradle: "gradle",
  cmake: "cmake",
  http: "http",
  rest: "http",
  dockerfile: "dockerfile",
  graphql: "graphql",
  lua: "lua",
  r: "r",
  dart: "dart",
  nsi: "nsis",
  nsh: "nsis",

  // 云原生与基础设施（Protobuf / Terraform HCL / Bicep）
  proto: "proto",
  tf: "hcl",
  tfvars: "hcl",
  hcl: "hcl",
  bicep: "bicep",

  // 现代前端、文档与模板（MDX / Pug / Handlebars / FreeMarker / Liquid / Twig）
  mdx: "mdx",
  pug: "pug",
  jade: "pug",
  handlebars: "handlebars",
  hbs: "handlebars",
  ftl: "freemarker2",
  ftlh: "freemarker2",
  ftlx: "freemarker2",
  liquid: "liquid",
  twig: "twig",

  // 常用语言体系（Scala / Elixir / Clojure / Julia / Perl / Solidity / CoffeeScript / F# / Objective-C）
  scala: "scala",
  sc: "scala",
  sbt: "scala",
  // 老表里只有 .gradle（Groovy 那门），.groovy 本体反倒漏了，这次补上。
  groovy: "groovy",
  ex: "elixir",
  exs: "elixir",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  edn: "clojure",
  jl: "julia",
  pl: "perl",
  pm: "perl",
  sol: "sol",
  coffee: "coffeescript",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  fsscript: "fsharp",
  m: "objective-c",

  // .NET 项目工程与界面（XML 家族）与 Razor 模板
  csproj: "xml",
  fsproj: "xml",
  vbproj: "xml",
  vcxproj: "xml",
  props: "xml",
  targets: "xml",
  xaml: "xml",
  axaml: "xml",
  svg: "xml",
  svgz: "xml",
  wxs: "xml",
  wxi: "xml",
  wxl: "xml",
  manifest: "xml",
  xsd: "xml",
  xsl: "xml",
  xslt: "xml",
  cshtml: "razor",

  // Ruby 生态
  gemspec: "ruby",
  rbx: "ruby",
  rjs: "ruby",

  // 科学计算、文档与着色器（reStructuredText / WGSL / TypeSpec）
  rst: "restructuredtext",
  wgsl: "wgsl",
  tsp: "typespec",

  // 数据库与数据分析（Cypher / SPARQL / DAX / PowerQuery）
  cyp: "cypher",
  cypher: "cypher",
  rq: "sparql",
  dax: "msdax",
  msdax: "msdax",
  pq: "powerquery",
  pqm: "powerquery",

  // Lisp 与工业/硬件（Scheme / Pascal / Tcl / SystemVerilog / Structured Text）
  scm: "scheme",
  ss: "scheme",
  sch: "scheme",
  rkt: "scheme",
  pas: "pascal",
  pp: "pascal",
  p: "pascal",
  tcl: "tcl",
  sv: "systemverilog",
  svh: "systemverilog",
  st: "st",
  iecst: "st",
};

/** 文件名到语言的少数特例，扩展名表覆盖不到（包含无扩展名的构建脚本与配置文件）。 */
const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gradlew: "shell",
  mvnw: "shell",
  gemfile: "ruby",
  rakefile: "ruby",
  fastfile: "ruby",
  podfile: "ruby",
  vagrantfile: "ruby",
  "build.sbt": "scala",
  // 扩展名是 .lock，跟 Cargo.toml 一样是 TOML，走同一套高亮。
  "cargo.lock": "ini",
  justfile: "shell",
  procfile: "shell",
  ".gitignore": "ini",
  ".gitmodules": "ini",
  ".gitconfig": "ini",
  ".gitattributes": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".bash_aliases": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
};

/** 路径与内容 → 语言 id，识别不到时退回纯文本。 */
export function languageForPath(path: string, contents?: string): string {
  const name = (path.split(/[\\/]/).pop() ?? "").toLocaleLowerCase();
  if (LANGUAGE_BY_NAME[name]) return LANGUAGE_BY_NAME[name];
  const named = languageByFileName(name);
  if (named) return named;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  if (ext && LANGUAGE_BY_EXTENSION[ext]) return LANGUAGE_BY_EXTENSION[ext];

  // 检查首行 Shebang 标记（如 #!/bin/sh, #!/usr/bin/env bash 等无扩展名脚本）
  if (contents && contents.startsWith("#!")) {
    const end = contents.indexOf("\n");
    const firstLine = (end >= 0 ? contents.slice(0, end) : contents).toLowerCase();
    if (firstLine.includes("bash") || firstLine.includes("/sh") || firstLine.includes("zsh")) {
      return "shell";
    }
    if (firstLine.includes("python")) {
      return "python";
    }
    if (firstLine.includes("node")) {
      return "javascript";
    }
    if (firstLine.includes("ruby")) {
      return "ruby";
    }
    if (firstLine.includes("perl")) {
      return "perl";
    }
  }

  return "plaintext";
}

/**
 * 扩展名对不上语言的工程文件。
 *
 * `go.mod` 的扩展名是 `mod`，`CMakeLists.txt` 的扩展名是 `txt`，
 * `Dockerfile.dev` 的扩展名是 `dev`。这些要按文件名认，不能等扩展名表。
 */
function languageByFileName(name: string): string | null {
  if (name === ".env" || name.startsWith(".env.")) return "ini";
  if (name === "go.mod" || name === "go.work" || name === "go.sum" || name === "go.work.sum") {
    return "gomod";
  }
  if (name === "cmakelists.txt") return "cmake";
  if (name === "pipfile" || name === "poetry.lock" || name === "uv.lock") return "ini";
  if (name === "pipfile.lock" || name === "composer.lock" || name === "package.resolved") {
    return "json";
  }
  if (name === "pubspec.lock") return "yaml";
  if (name === "gnumakefile" || name === "makefile.am" || name === "makefile.in") return "makefile";
  if (
    name === "containerfile" ||
    name.startsWith("containerfile.") ||
    name.startsWith("dockerfile.")
  ) {
    return "dockerfile";
  }
  if (
    /^(?:dev-)?requirements(?:[._-][\w.-]+)?\.(?:txt|in)$/.test(name) ||
    /^constraints(?:[._-][\w.-]+)?\.(?:txt|in)$/.test(name)
  ) {
    return "pip-requirements";
  }
  return null;
}

/**
 * 语言的兜底显示名。
 *
 * 状态栏与设置页给人看的是名字不是 id；这一份不依赖任何引擎，编辑器没加载也有答案。
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
  properties: "Properties",
  gomod: "Go Mod",
  gradle: "Gradle",
  cmake: "CMake",
  "pip-requirements": "Requirements",
  http: "HTTP",
  dockerfile: "Dockerfile",
  graphql: "GraphQL",
  lua: "Lua",
  r: "R",
  dart: "Dart",
  nsis: "NSIS",
  makefile: "Makefile",
  diff: "Diff",

  // 补充语言展示名
  proto: "Protobuf",
  hcl: "HCL",
  bicep: "Bicep",
  mdx: "MDX",
  pug: "Pug",
  handlebars: "Handlebars",
  freemarker2: "FreeMarker",
  liquid: "Liquid",
  twig: "Twig",
  scala: "Scala",
  elixir: "Elixir",
  clojure: "Clojure",
  julia: "Julia",
  perl: "Perl",
  sol: "Solidity",
  coffeescript: "CoffeeScript",
  fsharp: "F#",
  "objective-c": "Objective-C",
  razor: "Razor",
  restructuredtext: "reStructuredText",
  wgsl: "WGSL",
  typespec: "TypeSpec",
  cypher: "Cypher",
  sparql: "SPARQL",
  scheme: "Scheme",
  pascal: "Pascal",
  tcl: "Tcl",
  msdax: "DAX",
  powerquery: "PowerQuery",
  systemverilog: "SystemVerilog",
  st: "Structured Text",
};

/** 状态栏要给人看的语言名，不是引擎的内部 id。 */
export function languageLabel(id: string): string {
  return LANGUAGE_LABELS[id] ?? id;
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

/**
 * 路径 → 语言 id，认不出时给 null 而不是 plaintext。
 *
 * 筛选要的就是这个区别：「按文件类型筛」不能把扩展名表里没有的文件一律当成纯文本
 * 一起剪掉——[`languageForPath`] 那条是给编辑器选语法用的，认不出也要给个答案。
 */
export function languageIdOfPath(path: string): string | null {
  const name = (path.split(/[\\/]/).pop() ?? "").toLocaleLowerCase();
  if (LANGUAGE_BY_NAME[name]) return LANGUAGE_BY_NAME[name];
  const named = languageByFileName(name);
  if (named) return named;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  return ext && LANGUAGE_BY_EXTENSION[ext] ? LANGUAGE_BY_EXTENSION[ext] : null;
}

/**
 * 语言 id 与显示名，按显示名排好序——「按文件类型筛」那张勾选表的数据源。
 *
 * 只 surface 有扩展名可对上的那些：`go.mod` 这类按文件名认的没有勾选价值，
 * 列出来只会多出一行「Go Mod」让人怀疑它管的是哪些文件。
 */
export function languageChoices(): Array<{ id: string; label: string }> {
  const ids = new Set<string>();
  for (const id of Object.values(LANGUAGE_BY_EXTENSION)) ids.add(id);
  for (const id of Object.values(LANGUAGE_BY_NAME)) ids.add(id);
  ids.delete("plaintext");
  return [...ids]
    .map((id) => ({ id, label: languageLabel(id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * 等宽字体沿用 tokens.css 的取值，末尾补一层 CJK 等宽回退：
 * 拉丁等宽字体没有全角括号、引号这些标点，量不到字形就画方框。
 * 终端那两格（xterm）按 JS 字符串收字体，所以这条给它，编辑器那侧直接吃 `--font-mono`。
 */
const CJK_MONO = '"Microsoft YaHei Mono", "Noto Sans Mono CJK SC", "MS Gothic"';

export function monoFont(): string {
  const base = cssToken("--font-mono").replace(/,\s*monospace\s*$/, "");
  return base ? `${base}, ${CJK_MONO}, monospace` : `Menlo, Consolas, ${CJK_MONO}, monospace`;
}

/** 编辑器模块加载后挂上来的能力；为空表示首屏还没碰过编辑器。 */
interface EditorBridge {
  disposeModel(path: string): void;
  selectedText(limit: number): string;
}

let bridge: EditorBridge | null = null;

/** 由编辑器模块在自身初始化时调用，把自己接进这几条门面；返回退订。 */
export function attachEditorBridge(next: EditorBridge): () => void {
  bridge = next;
  return () => {
    if (bridge === next) bridge = null;
  };
}

/**
 * 跳到别的文件时的落点处理，由 App 注入。
 *
 * 语言服务的「跳转到定义」要打开的是另一份文件，编辑器只对「自己那份文档」有概念，
 * 所以必须在编辑器模块里注册 opener；而真正把文件读进来、开标签、定位是文档那一层的事，
 * 编辑器模块拿不到，只能留一个门面让 App 接上。
 */
type OpenTargetHandler = (path: string, line: number, column: number) => boolean;
let openTarget: OpenTargetHandler | null = null;

export function setOpenTargetHandler(handler: OpenTargetHandler | null): void {
  openTarget = handler;
}

/** 由编辑器模块的 opener 调用；没接上处理者时返回 false，交给调用方自己收尾。 */
export function openTargetInEditor(path: string, line: number, column: number): boolean {
  return openTarget ? openTarget(path, line, column) : false;
}

/** 关闭标签时释放那篇文档的常驻 state，否则切回来还是旧内容。编辑器没加载过时无事可做。 */
export function disposeModel(path: string): void {
  bridge?.disposeModel(path);
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
