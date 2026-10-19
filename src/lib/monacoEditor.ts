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
import { TokenizationRegistry } from "monaco-editor/editor/common/languages.js";
import { IConfigurationService } from "monaco-editor/platform/configuration/common/configuration.js";
import {
  StandaloneServices,
  updateConfigurationService,
} from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { installViewportTokenization } from "./viewportTokens";

// 超过约 30 万行时，这项为真会整篇停掉高亮。关掉之后屏幕上的行一直有颜色。
updateConfigurationService(
  StandaloneServices.get(IConfigurationService),
  { largeFileOptimizations: false },
  false
);

// 词法表在语言第一次用到时才填。这里先订上，大文件就不会在空闲时把整篇状态扫完。
installViewportTokenization(
  TokenizationRegistry,
  monaco.languages.getLanguages().map((language) => language.id)
);

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
  // 内置 tsserver 跑在渲染进程里。模型一创建，默认开着的诊断就会把 worker 拉起来，
  // 之后再关也停不掉。先全部关掉；只有配置明确是 builtin，才由 lspClient 打开。
  const suspended = {
    completionItems: false,
    hovers: false,
    definitions: false,
    references: false,
    rename: false,
    diagnostics: false,
    documentSymbols: false,
    signatureHelp: false,
    documentHighlights: false,
    codeActions: false,
  };
  monaco.typescript.typescriptDefaults.setModeConfiguration(suspended);
  monaco.typescript.javascriptDefaults.setModeConfiguration(suspended);

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

// 注册 properties 语言规范（Java / Spring / Gradle 等 .properties 配置文件）
monaco.languages.register({
  id: "properties",
  extensions: [".properties"],
  aliases: ["Properties", "properties"],
  mimetypes: ["text/x-properties"],
});

monaco.languages.setLanguageConfiguration("properties", {
  comments: {
    lineComment: "#",
  },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
});

monaco.languages.setMonarchTokensProvider("properties", {
  defaultToken: "",
  tokenPostfix: ".properties",
  tokenizer: {
    root: [
      // 注释：以 # 或 ! 开头的整行
      [/^\s*[#!].*$/, "comment"],
      // 属性键与分隔符：支持带点、短横线、下划线的多级属性名（如 spring.datasource.url=... 或 key: value）
      [/^(\s*)([^\s:=#!]+)(\s*[:=]\s*)/, ["", "key", "delimiter"]],
      // 变量占位符引用：${...}
      [/\$\{[^}]*\}/, "variable"],
      // 布尔开关字面量
      [/\b(true|false|yes|no|on|off)\b/i, "keyword"],
      // 常用数值
      [/\b\d+(\.\d+)?\b/, "number"],
      // 字符串字面量
      [/"([^"\\]|\\.)*"/, "string"],
      [/[']([^'\\]|\\.)*[']/, "string"],
      // 行末反斜杠续行符
      [/\\$/, "delimiter"],
    ],
  },
});

// `.http` 与 `.rest` 是同一种请求文件。高亮请求行、变量、分隔线和正文里的 JSON。
monaco.languages.register({
  id: "http",
  extensions: [".http", ".rest"],
  aliases: ["HTTP", "http"],
  mimetypes: ["text/x-http"],
});

monaco.languages.setLanguageConfiguration("http", {
  comments: { lineComment: "#" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
});

monaco.languages.setMonarchTokensProvider("http", {
  defaultToken: "",
  tokenPostfix: ".http",
  tokenizer: {
    root: [
      [/^#{3,}.*$/, "comment"],
      [/^\s*(?:#|\/\/).*$/, "comment"],
      [/^(@\S+)(\s*=\s*)(.*)$/, ["variable", "delimiter", "string"]],
      [
        /^(?:GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS|TRACE|CONNECT|PROPFIND|PROPPATCH|MKCOL|COPY|MOVE|LOCK|UNLOCK|GRAPHQL|QUERY|PURGE)\b/,
        { token: "keyword", next: "@request" },
      ],
      [/^https?:\/\/\S+/, { token: "string", next: "@request" }],
      [/^\{\{/, { token: "variable", next: "@request" }],
      // 响应页第一行是状态行，请求文件不会以这个开头。
      [/^HTTP\/\d+(?:\.\d+)?/, { token: "keyword", next: "@status" }],
      [/^\s*$/, ""],
    ],
    status: [
      [/\b[1-5]\d\d\b/, "number"],
      [/.$/, { token: "string", next: "@responseMeta" }],
      [/./, "string"],
    ],
    responseMeta: [
      [/^\s*$/, { token: "", next: "@responseHeaders" }],
      [/^https?:\/\/\S+/, "string"],
      [/^.*$/, "comment"],
    ],
    responseHeaders: [
      [/^\s*$/, { token: "", next: "@body" }],
      [/^([^:]+)(:)(.*)$/, ["type", "delimiter", "string"]],
      [/^.*$/, "comment"],
    ],
    request: [
      [/\{\{[^}]+\}\}/, "variable"],
      [/HTTP\/\d+(?:\.\d+)?/, "number"],
      [/.$/, { token: "string", next: "@headers" }],
      [/./, "string"],
    ],
    headers: [
      [/^#{3,}.*$/, { token: "comment", next: "@root" }],
      [/^\s*$/, { token: "", next: "@body" }],
      [/^\s*(?:#|\/\/).*$/, "comment"],
      [/^\s*[?&].*$/, "string"],
      [/\{\{[^}]+\}\}/, "variable"],
      [/^([^:]+)(:)(.*)$/, ["type", "delimiter", "string"]],
    ],
    body: [
      [/^#{3,}.*$/, { token: "comment", next: "@root" }],
      [/^>.*$/, "comment"],
      [/\{\{[^}]+\}\}/, "variable"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/<\/?[\w:.-]+(?:\s[^<>]*)?>/, "type"],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/-?\b\d+(?:\.\d+)?\b/, "number"],
      [/[{}[\],]/, "delimiter"],
    ],
  },
});

// go.mod / go.work / go.sum。扩展名不是 .go，内置 Go 语言对不上。
monaco.languages.register({
  id: "gomod",
  filenames: ["go.mod", "go.work", "go.sum", "go.work.sum"],
  aliases: ["Go Mod", "go.mod"],
});

monaco.languages.setLanguageConfiguration("gomod", {
  comments: { lineComment: "//" },
  brackets: [["(", ")"]],
  autoClosingPairs: [
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "`", close: "`" },
  ],
});

monaco.languages.setMonarchTokensProvider("gomod", {
  defaultToken: "",
  tokenPostfix: ".gomod",
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [
        /\b(?:module|go|toolchain|godebug|require|exclude|replace|retract|use|ignore|tool)\b/,
        "keyword",
      ],
      [/=>/, "delimiter"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/`[^`]*`/, "string"],
      [/\bv\d+\.\d+\.\d+(?:[-+][\w.+]+)?/, "number"],
      [/\b\d+\.\d+(?:\.\d+)?\b/, "number"],
      [/\bh1:[A-Za-z0-9+/=]+/, "string"],
      [/[()[\]]/, "delimiter"],
    ],
  },
});

// build.gradle / settings.gradle。Monaco 没有 Groovy，按 Gradle 里常见的词上色。
monaco.languages.register({
  id: "gradle",
  extensions: [".gradle"],
  aliases: ["Gradle", "gradle"],
});

monaco.languages.setLanguageConfiguration("gradle", {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
});

monaco.languages.setMonarchTokensProvider("gradle", {
  defaultToken: "",
  tokenPostfix: ".gradle",
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/'''/, "string", "@sqq"],
      [/"""/, "string", "@dqq"],
      [/'([^'\\]|\\.)*'/, "string"],
      [/"([^"\\]|\\.)*"/, "string"],
      [
        /\b(?:plugins|plugin|apply|from|dependencies|repositories|implementation|api|compileOnly|runtimeOnly|testImplementation|testCompileOnly|testRuntimeOnly|annotationProcessor|kapt|classpath|id|version|ext|allprojects|subprojects|task|tasks|sourceSets|java|application|mavenCentral|google|include|exclude|project|rootProject|buildscript|configurations|publishing)\b/,
        "keyword",
      ],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/\b\d+(?:\.\d+)?\b/, "number"],
      [/[{}()[\]]/, "delimiter"],
    ],
    comment: [
      [/[^\/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[\/*]/, "comment"],
    ],
    sqq: [
      [/[^']+/, "string"],
      [/'''/, "string", "@pop"],
      [/'/, "string"],
    ],
    dqq: [
      [/[^"]+/, "string"],
      [/"""/, "string", "@pop"],
      [/"/, "string"],
    ],
  },
});

// CMakeLists.txt / .cmake。扩展名经常是 txt，内置语言里没有 CMake。
monaco.languages.register({
  id: "cmake",
  extensions: [".cmake"],
  filenames: ["CMakeLists.txt"],
  aliases: ["CMake", "cmake"],
});

monaco.languages.setLanguageConfiguration("cmake", {
  comments: { lineComment: "#" },
  brackets: [["(", ")"]],
  autoClosingPairs: [
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
});

monaco.languages.setMonarchTokensProvider("cmake", {
  defaultToken: "",
  tokenPostfix: ".cmake",
  tokenizer: {
    root: [
      [/#.*$/, "comment"],
      [/\$\{[^}]*\}/, "variable"],
      [/"([^"\\]|\\.)*"/, "string"],
      [
        /\b(?:cmake_minimum_required|project|add_executable|add_library|add_subdirectory|target_link_libraries|target_include_directories|target_compile_definitions|target_compile_options|target_compile_features|find_package|find_library|find_path|set|unset|option|if|else|elseif|endif|foreach|endforeach|while|endwhile|function|endfunction|macro|endmacro|include|install|message|list|string|file|configure_file|add_custom_command|add_custom_target|enable_testing|add_test|set_target_properties|get_target_property|include_directories|link_directories|aux_source_directory)\b/,
        "keyword",
      ],
      [/\b(?:TRUE|FALSE|ON|OFF|YES|NO)\b/, "keyword"],
      [/\b\d+(?:\.\d+)?\b/, "number"],
      [/[()]/, "delimiter"],
    ],
  },
});

// requirements.txt。普通 .txt 仍是纯文本，只有依赖清单走这里。
monaco.languages.register({
  id: "pip-requirements",
  aliases: ["Requirements", "pip-requirements"],
});

monaco.languages.setLanguageConfiguration("pip-requirements", {
  comments: { lineComment: "#" },
});

monaco.languages.setMonarchTokensProvider("pip-requirements", {
  defaultToken: "",
  tokenPostfix: ".requirements",
  tokenizer: {
    root: [
      [/#.*$/, "comment"],
      [/^\s*-{1,2}\S+/, "keyword"],
      [/[=><!~]=|[><]/, "delimiter"],
      [/\b\d+(?:\.\d+)+(?:[-.][\w.+]+)?/, "number"],
      [/[\[\]]/, "delimiter"],
    ],
  },
});

// 增强 Monaco 内置 shell 语言高亮（覆盖 gradlew / mvnw / .sh / .bash 语法与双引号插值）
monaco.languages.setLanguageConfiguration("shell", {
  comments: {
    lineComment: "#",
  },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
  ],
});

monaco.languages.setMonarchTokensProvider("shell", {
  defaultToken: "",
  ignoreCase: false,
  tokenPostfix: ".shell",

  keywords: [
    "if", "then", "elif", "else", "fi", "case", "esac", "for", "while",
    "until", "do", "done", "in", "select", "return", "function", "continue", "break",
  ],

  builtins: [
    "echo", "printf", "read", "cd", "pwd", "ls", "dirname", "basename",
    "uname", "readlink", "expr", "test", "mkdir", "rm", "cp", "mv",
    "touch", "chmod", "chown", "cat", "grep", "sed", "awk", "cut",
    "find", "sort", "uniq", "tr", "wc", "xargs", "tar", "gzip",
    "curl", "wget", "kill", "sleep", "which", "command", "type",
    "source", "eval", "exec", "export", "set", "unset", "shift",
    "trap", "exit", "wait", "local", "readonly", "shopt", "alias",
  ],

  tokenizer: {
    root: [
      // Shebang 与注释
      [/^#!.*$/, "metatag"],
      [/^\s*#.*$/, "comment"],
      [/\s+#.*$/, "comment"],

      // 函数声明：foo () { 或 function foo
      [/^\s*function\s+([a-zA-Z_0-9\-]+)/, ["keyword", "function"]],
      [/^\s*([a-zA-Z_0-9\-]+)\s*\(\s*\)/, ["function", "delimiter"]],

      // 变量赋值：PRG=xxx 或 APP_HOME=xxx
      [/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\+?=)/, ["", "variable", "delimiter"]],

      // 单字符预定义变量与特殊变量：$0, $1, $*, $@, $?, $#, $$
      [/\$[0-9*@#?\-$!_]/, "variable.predefined"],
      // 变量引用：$VAR 与 ${VAR...}
      [/\$[a-zA-Z_][a-zA-Z0-9_]*/, "variable"],
      [/\$\{[^}]+\}/, "variable"],

      // 命令替换反引号：`...`
      [/`[^`]*`/, "variable.parameter"],

      // 命令行选项参数：-h, -z, --help
      [/\s(\-{1,2}[a-zA-Z0-9_\-]+)/, "attribute.name"],

      // 关键字与内置命令
      [
        /[a-zA-Z_][a-zA-Z0-9_]*/,
        {
          cases: {
            "@keywords": "keyword",
            "@builtins": "type.identifier",
            "@default": "",
          },
        },
      ],

      // 字符串：单引号纯文本，双引号支持插值
      [/'[^']*'/, "string"],
      [/"/, "string", "@qqstring"],

      // 数值
      [/\b\d+(\.\d+)?\b/, "number"],

      // 括号与符号
      [/[{}()\[\]]/, "@brackets"],
      [/[=><!~?&|+\-*\/\^;]/, "delimiter"],
    ],

    qqstring: [
      [/[^"\\$]+/, "string"],
      [/\$[0-9*@#?\-$!_]/, "variable.predefined"],
      [/\$[a-zA-Z_][a-zA-Z0-9_]*/, "variable"],
      [/\$\{[^}]+\}/, "variable"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
    ],
  },
});

// NSIS 安装脚本 (.nsi / .nsh)
monaco.languages.register({
  id: "nsis",
  extensions: [".nsi", ".nsh"],
  aliases: ["NSIS", "nsis"],
  mimetypes: ["text/x-nsis"],
});

monaco.languages.setLanguageConfiguration("nsis", {
  comments: {
    lineComment: ";",
    blockComment: ["/*", "*/"],
  },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
  ],
  folding: {
    markers: {
      start: /^\s*(?:!(?:macro|if|ifdef|ifndef)\b|Section(?:Group)?\b|Function\b|PageEx\b|\${(?:If|Unless|While|Do|Select|Switch)\b)/i,
      end: /^\s*(?:!(?:macroend|endif)\b|Section(?:Group)?End\b|FunctionEnd\b|PageExEnd\b|\${(?:EndIf|EndUnless|EndWhile|Loop|EndSelect|EndSwitch)\b)/i,
    },
  },
});

monaco.languages.setMonarchTokensProvider("nsis", {
  defaultToken: "",
  ignoreCase: true,
  tokenPostfix: ".nsi",

  keywords: [
    "Section", "SectionEnd", "SectionGroup", "SectionGroupEnd", "SectionIn",
    "SubSection", "SubSectionEnd", "Function", "FunctionEnd",
    "Page", "UninstPage", "PageEx", "PageExEnd", "PageCallbacks",
    "Var", "Goto", "Call", "Return", "Abort", "Quit",
    "If", "Else", "ElseIf", "EndIf", "Unless", "EndUnless",
    "While", "EndWhile", "Do", "Loop", "Break", "Continue",
    "Select", "Case", "Default", "EndSelect", "Switch", "EndSwitch",
  ],

  preprocessor: [
    "!define", "!undef", "!ifdef", "!ifndef", "!if", "!else", "!endif",
    "!insertmacro", "!macro", "!macroend", "!include", "!addincludedir",
    "!addplugindir", "!appendfile", "!cd", "!delfile", "!echo", "!error",
    "!execute", "!system", "!packhdr", "!finalize", "!tempfile", "!warning",
    "!verbose", "!ifmacrodef", "!ifmacrondef", "!searchparse", "!searchreplace",
  ],

  commands: [
    "OutFile", "Name", "Caption", "Icon", "UninstallIcon", "HeaderImage",
    "InstallDir", "InstallDirRegKey", "RequestExecutionLevel", "SetCompressor",
    "SetCompress", "CRCCheck", "AutoCloseWindow", "ShowInstDetails",
    "ShowUninstDetails", "SetOverwrite", "SetOutPath", "File", "Delete",
    "RMDir", "CreateDirectory", "CreateShortCut", "CopyFiles", "Rename",
    "Exec", "ExecWait", "ExecShell", "ExecShellWait", "Sleep", "BringToFront",
    "HideWindow", "ShowWindow", "SendMessage", "FindWindow", "IsWindow",
    "WriteRegStr", "WriteRegDWORD", "WriteRegBin", "WriteRegExpandStr",
    "ReadRegStr", "ReadRegDWORD", "DeleteRegKey", "DeleteRegValue",
    "EnumRegKey", "EnumRegValue", "WriteINIStr", "ReadINIStr", "FlushINI",
    "DeleteINISec", "DeleteINIStr", "StrCmp", "StrCmpS", "IntCmp", "IntCmpU",
    "IntOp", "IntFmt", "StrCpy", "StrLen", "Push", "Pop", "Exch",
    "ClearErrors", "SetErrors", "IfErrors", "IfFileExists", "IfRebootFlag",
    "SetRebootFlag", "IfSilent", "SetSilent", "DetailPrint", "MessageBox",
    "FindFirst", "FindNext", "FindClose", "FileOpen", "FileClose", "FileRead",
    "FileWrite", "FileSeek", "FileReadByte", "FileWriteByte", "GetTempFileName",
    "GetFullPathName", "GetFileTime", "GetFileTimeLocal", "GetFileAttributes",
    "SetFileAttributes", "GetSize", "GetDiskFreeSpace", "RegDLL", "UnRegDLL",
    "PluginDir", "InitPluginsDir", "EnableWindow", "GetDlgItem", "SetCtlColors",
    "CreateFont", "SetBrandingImage", "Unicode", "ManifestDPIAware", "ManifestDPIAwareness",
  ],

  tokenizer: {
    root: [
      // 单行注释：; 或 #
      [/^[ \t]*[;#].*$/, "comment"],
      [/[ \t]+[;#].*$/, "comment"],

      // 多行注释
      [/\/\*/, "comment", "@comment"],

      // Handlebars 模板标签（本项目安装脚本模板中包含 {{#if}} 等）
      [/\{\{[#\/]?[\w\-.]+\}\}/, "tag"],
      [/\{\{\{?[\w\-.]+?\}\}\}?/, "tag"],

      // 预处理指令（!define, !include 等）
      [
        /!\w+/,
        {
          cases: {
            "@preprocessor": "keyword.control",
            "@default": "keyword",
          },
        },
      ],

      // 宏引用与常量展开：${...}
      [/\$\{[^}]+\}/, "variable.other.constant"],

      // 寄存器与内置系统变量：$0-$9, $R0-$R9, $INSTDIR 等
      [
        /\$(?:[0-9]|R[0-9]|INSTDIR|OUTDIR|SYSDIR|WINDIR|PROGRAMFILES64|PROGRAMFILES|COMMONFILES|DESKTOP|STARTMENU|SMPROGRAMS|SENDTO|RECENT|FAVORITES|MUSIC|PICTURES|VIDEOS|NETHOOD|FONTS|TEMPLATES|APPDATA|LOCALAPPDATA|PRINTHOOD|INTERNET_CACHE|COOKIES|HISTORY|PROFILE|ADMINTOOLS|RESOURCES_LOCALIZED|RESOURCES|EXEFILE|EXEDIR|EXEPATH|HWNDPARENT|PLUGINSDIR|CMDLINE|LANGUAGE)\b/i,
        "variable.predefined",
      ],

      // 转义符：$$\r, $$\n, $$\t, $$\", $$\$, etc.
      [/\$(?:\\(?:[rnt"'\`$])|\$)/, "constant.character.escape"],

      // 用户变量：$VarName
      [/\$[a-zA-Z_]\w*/, "variable"],

      // 字符串字面量
      [/"/, "string", "@string_double"],
      [/'/, "string", "@string_single"],
      [/`/, "string", "@string_backtick"],

      // 标识符与关键字
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            "@keywords": "keyword",
            "@commands": "type.identifier",
            "@default": "identifier",
          },
        },
      ],

      // 十六进制数与十进制数
      [/0x[0-9a-fA-F]+\b/, "number.hex"],
      [/\b\d+\b/, "number"],

      // 括号与标点
      [/[{}()\[\]]/, "@brackets"],
      [/[=><!|&+\-*\/^,:]/, "delimiter"],
    ],

    comment: [
      [/[^\/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[\/*]/, "comment"],
    ],

    string_double: [
      [/[^"\\$]+/, "string"],
      [/\$\{[^}]+\}/, "variable.other.constant"],
      [/\$(?:[0-9]|R[0-9]|[a-zA-Z_]\w*)/, "variable"],
      [/\$(?:\\(?:[rnt"'\`$])|\$)/, "constant.character.escape"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
    ],

    string_single: [
      [/[^'\\$]+/, "string"],
      [/\$\{[^}]+\}/, "variable.other.constant"],
      [/\$(?:[0-9]|R[0-9]|[a-zA-Z_]\w*)/, "variable"],
      [/\$(?:\\(?:[rnt"'\`$])|\$)/, "constant.character.escape"],
      [/\\./, "string.escape"],
      [/'/, "string", "@pop"],
    ],

    string_backtick: [
      [/[^`\\$]+/, "string"],
      [/\$\{[^}]+\}/, "variable.other.constant"],
      [/\$(?:[0-9]|R[0-9]|[a-zA-Z_]\w*)/, "variable"],
      [/\$(?:\\(?:[rnt"'\`$])|\$)/, "constant.character.escape"],
      [/\\./, "string.escape"],
      [/`/, "string", "@pop"],
    ],
  },
});

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
      "diffEditor.insertedTextBackground": dark ? "#4ade8033" : "#22c55e40",
      "diffEditor.removedTextBackground": dark ? "#f8717133" : "#ef444440",
      "diffEditor.insertedLineBackground": dark ? "#4ade8026" : "#22c55e2e",
      "diffEditor.removedLineBackground": dark ? "#f8717126" : "#ef44442e",
      "diffEditorGutter.insertedLineBackground": dark ? "#4ade8066" : "#22c55e66",
      "diffEditorGutter.removedLineBackground": dark ? "#f8717166" : "#ef444466",
      "diffEditorOverview.insertedForeground": dark ? "#4ade80cc" : "#22c55ecc",
      "diffEditorOverview.removedForeground": dark ? "#f87171cc" : "#ef4444cc",
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
