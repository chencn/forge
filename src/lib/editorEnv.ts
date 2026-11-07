/**
 * 编辑器无关的那半份设施：语言目录、语言显示名、字体串、文档 state 释放与选区读取。
 *
 * 这个模块**不许 import 编辑器引擎**：首屏只开图片、只读 Git 面板的用户不应该为了
 * 一个扩展名映射把整份 CodeMirror（连语法包）拖进启动路径。
 * 真正需要编辑器实例的两件事（释放文档 state、读选区）由引擎（`cmEditor.ts`）
 * 在自身加载时通过 `attachEditorBridge` 挂上来；没挂上时它们要么是无意义操作
 * （盘上没有 state 可读），要么退回本模块的静态表。
 *
 * 语言目录与编辑器语言表（`languages/*.toml`，71 门）逐字对齐：id、显示名、
 * 扩展名与文件名，供编辑器识别与显示。
 * 目录之外的少数语言（batch、nsis、solidity 这类编辑器还有语法但目录里没有的）
 * 放在 `EDITOR_EXTRA`，只参与识别与显示。
 */

/** 语言目录里的一项；`filenames` 是扩展名覆盖不到的特例，支持 `*` 通配。 */
interface CatalogLanguage {
  id: string;
  name: string;
  extensions: readonly string[];
  filenames?: readonly string[];
}

/** 目录内 71 门语言，条目顺序与语言表目录一致。 */
const CATALOG: readonly CatalogLanguage[] = [
  { id: "c", name: "C", extensions: ["c", "h"] },
  { id: "clojure", name: "Clojure", extensions: ["clj", "cljs", "cljc", "cljd", "edn", "bb"], filenames: ["deps.edn", "project.clj", "bb.edn"] },
  { id: "cmake", name: "CMake", extensions: ["cmake"], filenames: ["CMakeLists.txt", "CMakeCache.txt"] },
  { id: "cpp", name: "C++", extensions: ["cpp", "cc", "cxx", "c++", "hpp", "hh", "hxx", "h++", "ipp", "tpp", "inl", "ixx", "cppm"] },
  { id: "csharp", name: "C#", extensions: ["cs", "csx"] },
  { id: "css", name: "CSS", extensions: ["css", "pcss", "postcss"] },
  { id: "dart", name: "Dart", extensions: ["dart"] },
  { id: "diff", name: "Diff", extensions: ["diff", "patch", "rej"] },
  { id: "dockerfile", name: "Dockerfile", extensions: ["dockerfile", "containerfile"], filenames: ["Dockerfile", "Containerfile", "Dockerfile.*", "Containerfile.*", "*.Dockerfile"] },
  { id: "dotenv", name: ".env", extensions: ["env"], filenames: [".env", ".env.*", ".flaskenv"] },
  { id: "elixir", name: "Elixir", extensions: ["ex", "exs"], filenames: ["mix.lock"] },
  { id: "erlang", name: "Erlang", extensions: ["erl", "hrl", "escript", "app.src"], filenames: ["rebar.config", "rebar.lock", "sys.config"] },
  { id: "fsharp", name: "F#", extensions: ["fs", "fsi", "fsx"] },
  { id: "gdscript", name: "GDScript", extensions: ["gd"] },
  { id: "gdshader", name: "Godot Shader", extensions: ["gdshader", "gdshaderinc"] },
  { id: "gitattributes", name: "Git Attributes", extensions: [], filenames: [".gitattributes"] },
  { id: "go", name: "Go", extensions: ["go"] },
  { id: "godot-resource", name: "Godot Resource", extensions: ["tscn", "tres", "godot", "import"], filenames: ["export_presets.cfg", "override.cfg", "extension_list.cfg"] },
  { id: "gomod", name: "Go Module", extensions: [], filenames: ["go.mod"] },
  { id: "gowork", name: "Go Workspace", extensions: [], filenames: ["go.work"] },
  { id: "graphql", name: "GraphQL", extensions: ["graphql", "graphqls", "gql"] },
  { id: "groovy", name: "Groovy", extensions: ["groovy", "gradle", "gvy", "gy", "gsh"], filenames: ["Jenkinsfile"] },
  { id: "haskell", name: "Haskell", extensions: ["hs", "hs-boot", "hsig"] },
  { id: "hcl", name: "HCL", extensions: ["hcl", "nomad", "pkr.hcl"] },
  { id: "html", name: "HTML", extensions: ["html", "htm", "xhtml", "shtml", "html.tmpl"] },
  { id: "http", name: "HTTP Request", extensions: ["http", "rest"] },
  {
    id: "ignore",
    name: "Ignore File",
    extensions: ["gitignore", "dockerignore"],
    filenames: [
      ".gitignore", ".gitignore_global", ".dockerignore", ".npmignore", ".prettierignore",
      ".eslintignore", ".stylelintignore", ".hgignore", ".ignore", ".rgignore", ".fdignore",
      ".helmignore", ".vscodeignore", ".gcloudignore", ".slugignore", ".cfignore", ".containerignore",
    ],
  },
  {
    id: "ini",
    name: "INI",
    extensions: ["ini", "cfg", "conf", "cnf", "inf", "reg", "url", "desktop", "service", "socket", "timer"],
    filenames: [
      ".editorconfig", ".gitconfig", ".gitmodules", ".npmrc", ".yarnrc", ".pypirc", ".flake8",
      ".pylintrc", "pylintrc", "setup.cfg", "tox.ini", "pytest.ini", "mypy.ini", ".coveragerc",
      "php.ini", ".hgrc", "hgrc", "credentials",
    ],
  },
  { id: "java", name: "Java", extensions: ["java"] },
  { id: "javascript", name: "JavaScript", extensions: ["js", "mjs", "cjs"] },
  { id: "javascriptreact", name: "JavaScript JSX", extensions: ["jsx"] },
  {
    id: "json",
    name: "JSON",
    extensions: ["json", "geojson", "topojson", "webmanifest", "har", "avsc", "jsonl", "ndjson", "json.map"],
    filenames: [".prettierrc", ".watchmanconfig", "composer.lock", ".arcconfig"],
  },
  {
    id: "jsonc",
    name: "JSON with Comments",
    extensions: ["jsonc", "code-workspace", "code-snippets"],
    filenames: [
      "tsconfig.json", "jsconfig.json", "tsconfig.*.json", "jsconfig.*.json", ".eslintrc",
      ".eslintrc.json", ".jshintrc", ".babelrc", ".swcrc", "devcontainer.json", ".devcontainer.json",
      "launch.json", "tasks.json", "settings.json", "extensions.json", "keybindings.json",
      "tslint.json", "api-extractor.json", "typedoc.json", "deno.json", "biome.json", "turbo.json",
      "language-configuration.json",
    ],
  },
  { id: "julia", name: "Julia", extensions: ["jl"] },
  { id: "kotlin", name: "Kotlin", extensions: ["kt", "kts"] },
  { id: "latex", name: "LaTeX", extensions: ["tex", "ltx", "sty", "cls", "dtx", "ins", "bbx", "cbx"] },
  { id: "less", name: "Less", extensions: ["less"] },
  { id: "log", name: "Log", extensions: ["log"] },
  { id: "lua", name: "Lua", extensions: ["lua", "luau", "rockspec"], filenames: [".luacheckrc"] },
  {
    id: "makefile",
    name: "Makefile",
    extensions: ["mk", "mak", "make"],
    filenames: ["Makefile", "makefile", "GNUmakefile", "BSDmakefile", "Makefile.am", "Makefile.in", "Kbuild"],
  },
  {
    id: "markdown",
    name: "Markdown",
    extensions: ["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdx", "ronn", "workbook"],
  },
  { id: "nix", name: "Nix", extensions: ["nix"] },
  { id: "objective-c", name: "Objective-C", extensions: ["m"] },
  { id: "objective-cpp", name: "Objective-C++", extensions: ["mm"] },
  { id: "ocaml", name: "OCaml", extensions: ["ml", "mll", "mly"] },
  { id: "ocaml-interface", name: "OCaml Interface", extensions: ["mli"] },
  { id: "perl", name: "Perl", extensions: ["pl", "pm", "pod", "psgi", "cgi"], filenames: ["cpanfile", "Makefile.PL", "Build.PL"] },
  { id: "php", name: "PHP", extensions: ["php", "phtml", "php3", "php4", "php5", "phps", "phpt"] },
  {
    id: "plaintext",
    name: "Plain Text",
    extensions: ["txt", "text"],
    filenames: ["LICENSE", "LICENCE", "COPYING", "AUTHORS", "NOTICE", "CODEOWNERS", "README", "CHANGELOG", "CONTRIBUTORS", "requirements.txt"],
  },
  { id: "powershell", name: "PowerShell", extensions: ["ps1", "psm1", "psd1", "pssc", "psrc"] },
  { id: "properties", name: "Properties", extensions: ["properties", "prefs"], filenames: ["gradle.properties", "local.properties"] },
  { id: "proto", name: "Protocol Buffers", extensions: ["proto"] },
  { id: "python", name: "Python", extensions: ["py", "pyi", "pyw"], filenames: ["SConstruct", "SConscript"] },
  { id: "r", name: "R", extensions: ["r", "rprofile"], filenames: [".Rprofile"] },
  {
    id: "ruby",
    name: "Ruby",
    extensions: ["rb", "rake", "gemspec", "ru", "rbi", "jbuilder", "podspec"],
    filenames: [
      "Gemfile", "Rakefile", "Podfile", "Vagrantfile", "Brewfile", "Guardfile", "Fastfile",
      "Appfile", "Capfile", "Dangerfile", "Steepfile", ".irbrc", ".pryrc",
    ],
  },
  { id: "rust", name: "Rust", extensions: ["rs"] },
  { id: "sass", name: "Sass", extensions: ["sass"] },
  { id: "scala", name: "Scala", extensions: ["scala", "sc", "sbt", "mill"] },
  { id: "scss", name: "SCSS", extensions: ["scss"] },
  {
    id: "shellscript",
    name: "Shell Script",
    extensions: ["sh", "bash", "zsh", "ksh", "ash", "dash", "bats", "command"],
    filenames: [
      ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases", ".profile",
      ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".kshrc", "PKGBUILD", "APKBUILD",
      ".envrc", "gradlew", "mvnw", "justfile", "procfile",
    ],
  },
  { id: "sql", name: "SQL", extensions: ["sql", "ddl", "dml", "psql", "pgsql", "mysql"] },
  { id: "svelte", name: "Svelte", extensions: ["svelte"] },
  { id: "swift", name: "Swift", extensions: ["swift", "swiftinterface"] },
  { id: "terraform-vars", name: "Terraform Variables", extensions: ["tfvars"] },
  { id: "terraform", name: "Terraform", extensions: ["tf", "tofu", "tftest.hcl"], filenames: [".terraformrc", "terraform.rc"] },
  { id: "toml", name: "TOML", extensions: ["toml"], filenames: ["Cargo.lock", "Pipfile", "poetry.lock", "uv.lock", "pdm.lock", "Gopkg.lock"] },
  { id: "typescript", name: "TypeScript", extensions: ["ts", "mts", "cts"] },
  { id: "typescriptreact", name: "TypeScript JSX", extensions: ["tsx"] },
  { id: "vue", name: "Vue", extensions: ["vue"] },
  {
    id: "xml",
    name: "XML",
    extensions: ["xml", "xsd", "xsl", "xslt", "svg", "plist", "csproj", "fsproj", "vbproj", "props", "targets", "nuspec", "xaml", "axaml", "resx", "wsdl", "fxml", "iml", "jnlp", "rss", "atom", "xliff", "xlf", "storyboard", "xib", "tld", "pom"],
    filenames: ["NuGet.Config", "Directory.Build.targets", "web.config", "app.config"],
  },
  {
    id: "yaml",
    name: "YAML",
    extensions: ["yaml", "yml"],
    filenames: [".clang-format", ".clang-tidy", ".clangd", ".gemrc", "pnpm-lock.yaml", "CITATION.cff"],
  },
  { id: "zig", name: "Zig", extensions: ["zig", "zon"] },
];

/**
 * 目录之外的编辑器专用语言：语言目录里没有这几门，但编辑器这边
 * 语法包还在、老工程还会打开，识别与显示照旧，只是不进语言服务目录。
 */
const EDITOR_EXTRA: readonly CatalogLanguage[] = [
  { id: "batch", name: "Batch", extensions: ["bat", "cmd"] },
  { id: "nsis", name: "NSIS", extensions: ["nsi", "nsh"] },
  { id: "bicep", name: "Bicep", extensions: ["bicep"] },
  { id: "pug", name: "Pug", extensions: ["pug", "jade"] },
  { id: "handlebars", name: "Handlebars", extensions: ["handlebars", "hbs"] },
  { id: "freemarker2", name: "FreeMarker", extensions: ["ftl", "ftlh", "ftlx"] },
  { id: "liquid", name: "Liquid", extensions: ["liquid"] },
  { id: "twig", name: "Twig", extensions: ["twig"] },
  { id: "coffeescript", name: "CoffeeScript", extensions: ["coffee"] },
  { id: "sol", name: "Solidity", extensions: ["sol"] },
  { id: "wgsl", name: "WGSL", extensions: ["wgsl"] },
  { id: "typespec", name: "TypeSpec", extensions: ["tsp"] },
  { id: "cypher", name: "Cypher", extensions: ["cyp", "cypher"] },
  { id: "sparql", name: "SPARQL", extensions: ["rq"] },
  { id: "msdax", name: "DAX", extensions: ["dax", "msdax"] },
  { id: "powerquery", name: "PowerQuery", extensions: ["pq", "pqm"] },
  { id: "scheme", name: "Scheme", extensions: ["scm", "ss", "sch", "rkt"] },
  { id: "pascal", name: "Pascal", extensions: ["pas", "pp", "p"] },
  { id: "tcl", name: "Tcl", extensions: ["tcl"] },
  { id: "systemverilog", name: "SystemVerilog", extensions: ["sv", "svh"] },
  { id: "st", name: "Structured Text", extensions: ["st", "iecst"] },
  { id: "razor", name: "Razor", extensions: ["cshtml"] },
  { id: "restructuredtext", name: "reStructuredText", extensions: ["rst"] },
  { id: "fsharp", name: "F#", extensions: ["fsscript"] },
  { id: "xml", name: "XML", extensions: ["vcxproj", "wxs", "wxi", "wxl", "manifest", "svgz"] },
];

/** 扩展名 → 语言 id：目录表优先，编辑器专用补充表兜底。 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {};
for (const language of [...CATALOG, ...EDITOR_EXTRA]) {
  for (const ext of language.extensions) {
    if (!(ext in LANGUAGE_BY_EXTENSION)) LANGUAGE_BY_EXTENSION[ext] = language.id;
  }
}

/** 文件名精确表与通配模式：文件名命中优先于扩展名。 */
const LANGUAGE_BY_NAME: Record<string, string> = {};
/** 文件名通配模式表（`Makefile*` 这类），文件名精确表没中才查它。 */
const FILENAME_PATTERNS: Array<{ re: RegExp; id: string }> = [];
/** 文件名通配转正则：`*` 匹配任意串，其余字符按字面量转义。 */
function filenameToRegExp(text: string): RegExp {
  let source = "";
  for (const char of text) {
    if (char === "*") source += ".*";
    else if (".+^${}()|[]\\".includes(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`^${source}$`, "i");
}
for (const language of [...CATALOG, ...EDITOR_EXTRA]) {
  for (const filename of language.filenames ?? []) {
    if (!filename.includes("*")) {
      if (!(filename.toLowerCase() in LANGUAGE_BY_NAME)) {
        LANGUAGE_BY_NAME[filename.toLowerCase()] = language.id;
      }
      continue;
    }
    FILENAME_PATTERNS.push({ re: filenameToRegExp(filename.toLowerCase()), id: language.id });
  }
}

/**
 * 首行识别表：扩展名认不出的脚本靠它。条目与各语言 toml 的
 * `first-line` 一致，顺序是从特例到泛化（先锚定的声明，再 shebang）。
 */
const FIRST_LINE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^#\s*syntax\s*=\s*docker\/dockerfile/i, "dockerfile"],
  [/^<\?php/i, "php"],
  [/^%YAML/i, "yaml"],
  [/^<\?xml\b/i, "xml"],
  [/^(diff --git |--- |Index: )/, "diff"],
  [/\bpython[0-9.]*\b/, "python"],
  [/\bRscript\b/, "r"],
  [/\bruby\b/, "ruby"],
  [/\bperl[0-9.]*\b/, "perl"],
  [/\bjulia\b/, "julia"],
  [/\belixir\b/, "elixir"],
  [/\bescript\b/, "erlang"],
  [/\bmake\b/, "makefile"],
  [/\bpwsh\b/, "powershell"],
  [/\blua(jit)?[0-9.]*\b/, "lua"],
  [/\bbash\b|\bzsh\b|\bksh\b|\bdash\b|\bash\b|\bsh\b/, "shellscript"],
  [/\b(node|nodejs|deno|bun)\b/, "javascript"],
  [/\bgroovy\b/, "groovy"],
];

/** 路径与内容 → 语言 id，识别不到时退回纯文本。 */
export function languageForPath(path: string, contents?: string): string {
  const name = (path.split(/[\\/]/).pop() ?? "").toLocaleLowerCase();
  const byName = LANGUAGE_BY_NAME[name] ?? FILENAME_PATTERNS.find((entry) => entry.re.test(name))?.id;
  if (byName) return byName;
  // 多段后缀从最长开始试（a.json.map → "json.map" 命中 JSON；pkr.hcl → "hcl"），
  // 用最长后端口径——取最后一段会把多段扩展名退化掉。
  let dot = name.indexOf(".");
  while (dot >= 0) {
    const ext = name.slice(dot + 1);
    const language = LANGUAGE_BY_EXTENSION[ext];
    if (language) return language;
    dot = name.indexOf(".", dot + 1);
  }

  // 首行兜底：无扩展名的脚本、以及凭文件名认不出的内容型文件。
  if (contents) {
    const firstLine = contents.slice(0, contents.indexOf("\n") >= 0 ? contents.indexOf("\n") : contents.length);
    for (const [pattern, id] of FIRST_LINE) {
      if (pattern.test(firstLine)) return id;
    }
  }
  return "plaintext";
}

/** 语言的兜底显示名。状态栏与设置页给人看的是名字不是 id。 */
const LANGUAGE_LABELS: Record<string, string> = {};
for (const language of [...CATALOG, ...EDITOR_EXTRA]) {
  if (!(language.id in LANGUAGE_LABELS)) LANGUAGE_LABELS[language.id] = language.name;
}

/** 状态栏要给人看的语言名，不是引擎的内部 id。 */
export function languageLabel(id: string): string {
  return LANGUAGE_LABELS[id] ?? id;
}

/** 读一个 CSS 自定义属性的值（取不到返回空串）。 */
function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * 等宽字体沿用 tokens.css 的取值，末尾补一层 CJK 等宽回退：
 * 拉丁等宽字体没有全角括号、引号这些标点，量不到字形就画方框。
 * 终端那两格（xterm）按 JS 字符串收字体，所以这条给它，编辑器那侧直接吃 `--font-mono`。
 */
const CJK_MONO = '"Microsoft YaHei Mono", "Noto Sans Mono CJK SC", "MS Gothic"';

/** 等宽字体栈：`--font-mono` 打头，补 CJK 等宽回退与 monospace 兜底。 */
export function monoFont(): string {
  const base = cssToken("--font-mono").replace(/,\s*monospace\s*$/, "");
  return base ? `${base}, ${CJK_MONO}, monospace` : `Menlo, Consolas, ${CJK_MONO}, monospace`;
}

/** 编辑器模块加载后挂上来的能力；为空表示首屏还没碰过编辑器。 */
interface EditorBridge {
  disposeModel(path: string): void;
  selectedText(limit: number): string;
}

/** 编辑器模块挂上来的能力单例；null 表示首屏还没碰过编辑器。 */
let bridge: EditorBridge | null = null;

/** 由编辑器模块在自身初始化时调用，把自己接进这几条门面；返回退订。 */
export function attachEditorBridge(next: EditorBridge): () => void {
  bridge = next;
  return () => {
    if (bridge === next) bridge = null;
  };
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
