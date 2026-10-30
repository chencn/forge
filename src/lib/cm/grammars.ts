/**
 * 语法树高亮的唯一入口：Lezer 语法（@codemirror/language-data）出 `tok-*` 类，
 * 类名到颜色的映射在 styles.css，用的是 tokens.css 那套 `--syn-*`。
 *
 * 编辑器里的同一套颜色走的是 cm/highlight.ts 的 HighlightStyle——两者是同一批
 * Lezer tag 的两种落地方式，所以正文代码块、md 预览和编辑器三处永远不会配色漂移。
 *
 * 这一层刻意保持"同步出 HTML、异步备语法"：marked 的 renderer 必须是同步的，
 * 而语法包是按语言懒加载的。调用方先 await prepareHighlight() 把这篇用过的语言装进内存，
 * 之后同步渲染就能直接拿到高亮结果——渲染核心因此只有一条路径，React 也不会
 * 把我们注入的 span 冲掉。
 *
 * 这里不碰 DOMPurify，也不碰 DOM：聊天把这份模块放进渲染 Worker 里跑。
 */
import { LanguageDescription, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { extraGrammar } from "./extraGrammars";

/** 显式声明"这就是纯文本"的围栏标记：不去猜语法，也别浪费一次加载。 */

/**
 * 注释符补全（对齐 openidea 的后端 commentTokens 注入）：官方 lang-* 包多数自带
 * commentTokens，但 language-data 里那批 legacy 模式（shell/lua/perl/erlang…）
 * 和 extraGrammars 的 simpleMode 全都没有——缺了它们 Ctrl+/ 就是死键。
 * 表只列「确认官方没带」的；官方已带的（js/ts/css/html/python/rust/java/c…）不要重复注入。
 */
const COMMENT_TOKENS: Record<string, { line?: string; block?: [string, string] }> = {
  gomod: { line: "//" }, "go-work": { line: "//" }, gowork: { line: "//" },
  "pip-requirements": { line: "#" },
  makefile: { line: "#" },
  hcl: { line: "#" }, terraform: { line: "#" }, "terraform-vars": { line: "#" },
  bicep: { line: "//" },
  graphql: { line: "#" },
  elixir: { line: "#" },
  st: { line: "//" },
  msdax: { line: "//" },
  powerquery: { line: "//" },
  sol: { line: "//" },
  wgsl: { line: "//" },
  typespec: { line: "//" },
  yaml: { line: "#" }, toml: { line: "#" }, dotenv: { line: "#" },
  properties: { line: "#" }, ini: { line: ";" }, gitignore: { line: "#" }, gitattributes: { line: "#" },
  shell: { line: "#" }, bash: { line: "#" }, shellsession: { line: "#" }, powershell: { line: "#" },
  dockerfile: { line: "#" },
  lua: { line: "--" }, perl: { line: "#" }, r: { line: "#" }, ruby: { line: "#" },
  erlang: { line: "%" }, haskell: { line: "--" }, nix: { line: "#" }, zig: { line: "//" },
  gdscript: { line: "#" }, sass: { line: "//" }, less: { line: "//" },
  clojure: { line: ";;" }, scheme: { line: ";" }, fsharp: { line: "//" },
  vb: { line: "'" }, vim: { line: '"' }, "objective-c": { line: "//" }, "objective-c++": { line: "//" },
};

/**
 * 语法配色补丁（1:1 抄 openidea cm/languages.ts EXTRA_TAGS/patchSupport）：
 * Java 注解、CSS/SCSS/Sass 的 tag↔attribute 互换、YAML 键染关键字——官方语法包的
 * 缺口，IntelliJ 里这些是别的颜色。键是 LanguageDescription.name，走 LRLanguage.configure。
 */
import { styleTags, tags as t } from "@lezer/highlight";
import { LRLanguage } from "@codemirror/language";
const CSS_TAGS: Parameters<typeof styleTags>[0] = {
  "FeatureName PropertyName": t.attributeName,
  "ValueName FontName Unit": t.attributeValue,
  "ClassName IdName PseudoClassName ColorLiteral CallTag": t.tagName,
};
const EXTRA_TAGS: Record<string, Parameters<typeof styleTags>[0]> = {
  Java: { "MarkerAnnotation/Identifier Annotation/Identifier MarkerAnnotation Annotation": t.annotation },
  CSS: CSS_TAGS,
  SCSS: CSS_TAGS,
  Sass: CSS_TAGS,
  YAML: { "Key/Literal Key/QuotedLiteral": t.keyword },
};

/** 给语法包装上 commentTokens 覆盖层；表里没有的语言原样返回。 */
function withCommentTokens(support: LanguageSupport, lang: string): LanguageSupport {
  const tokens = COMMENT_TOKENS[lang.toLowerCase()];
  if (!tokens || !support.language) return support;
  // Language.data 是官方的 language-data 注入口（每实例一个 facet）
  return new LanguageSupport(support.language, [
    support.support ?? [],
    support.language.data.of({ commentTokens: tokens }),
  ]);
}

/** 配色补丁：只对 LR 语法生效（对齐 openidea patchSupport）。键用 LanguageDescription.name。 */
function patchSyntaxTags(support: LanguageSupport, name: string): LanguageSupport {
  const extra = EXTRA_TAGS[name];
  if (!extra || !(support.language instanceof LRLanguage)) return support;
  return new LanguageSupport(support.language.configure({ props: [styleTags(extra)] }), support.support);
}

const PLAIN = new Set(["", "text", "txt", "plaintext", "plain", "none", "log", "output", "console"]);

/**
 * 这些语言 id 会被 `matchLanguageName` 认成别的语言，宁可不上语法也别拿错的去染：
 * `restructuredtext` → LaTeX（`r` 那一串后缀撞上了），`javascriptreact` → Java。
 * 两者都是编辑器侧的 id（围栏里没人这么写），但同一条解析路径两份都要走，所以放这里。
 */
const WRONG = new Set(["javascriptreact", "typescriptreact"]);

/** id 与 Lezer 那张表叫法不一致的那些，以及正文/围栏里常见的简写。 */
const SPELLINGS: Record<string, string> = {
  proto: "protobuf",
  gradle: "groovy",
  // 自家补的那批（cm/extraGrammars.ts）的简写与别名。
  kt: "kotlin",
  kts: "kotlin",
  groovy: "groovy",
  solidity: "sol",
  gql: "graphql",
  dax: "msdax",
  pq: "powerquery",
  tsp: "typespec",
  requirements: "pip-requirements",
  tex: "latex",
  sty: "latex",
  ml: "ocaml",
  mli: "ocaml",
  haskell: "haskell", lhs: "haskell", erl: "erlang", patch: "diff",
  // 没有对应语法的这几门走最近的亲戚：Twig / FreeMarker / Handlebars 都是 Jinja 那一路
  // 的 {{ }} 模板，Razor 是 HTML + C#，MDX 与 reST 先按 Markdown 染（比素文本强，
  // 又不会像把 reST 认成 LaTeX 那样整篇串色）。
  twig: "jinja",
  freemarker2: "jinja",
  handlebars: "jinja",
  hbs: "jinja",
  razor: "html",
  mdx: "markdown",
  rst: "markdown",
  restructuredtext: "markdown",
  gyp: "python",
  cjs: "javascript",
  mjs: "javascript",
  jsx: "JSX",
  tsx: "TSX",
  py: "python",
  py3: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  md: "markdown",
  jsonc: "json",
  json5: "json",
  docker: "dockerfile",
  ps1: "powershell",
  bat: "batch",
  cmd: "batch",
  htm: "html",
  "c++": "cpp",
  "f#": "fsharp",
  clj: "clojure",
};

/**
 * 按文档后缀纠回来的两门：语言 id 表里没有 tsx/jsx 这一档（`editorEnv` 把它们记成
 * typescript/javascript，那是给 tsserver 用的），但 JSX 正文用纯 TS 语法解析会一路报错。
 */
const BY_EXTENSION: Record<string, string> = { tsx: "TSX", jsx: "JSX" };

const descriptions = new Map<string, LanguageDescription | null>();

/** 路径最后一段的后缀（不含点）；`Makefile`、`.gitignore` 这类给出空串。 */
export function pathExtension(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * 找一门语言的语法描述。`fileExt` 是文档后缀，只用来纠 tsx/jsx 这种
 * 「语言 id 说得不够细」的情况；围栏里没有文件名，传空即可。
 *
 * 不用 `matchFilename` 兜底：`a.cmake.in` 会按 `in` 认成 Properties，而 id `cmake` 才是
 * 对的答案；后缀能多说出来的这几门已经写进 BY_EXTENSION 了。
 */
export function describeGrammar(lang: string, fileExt = ""): LanguageDescription | null {
  const key = lang.trim().toLowerCase();
  const ext = fileExt.trim().toLowerCase();
  if (!key || PLAIN.has(key) || WRONG.has(key)) return null;
  const cacheKey = ext ? `${key}|${ext}` : key;
  if (descriptions.has(cacheKey)) return descriptions.get(cacheKey) ?? null;
  const name = (ext ? BY_EXTENSION[ext] : undefined) ?? SPELLINGS[key] ?? key;
  // 自己补的那批先查：它们在 language-data 里根本没有条目，硬查只会拿到 null。
  const custom = extraGrammar(name);
  const found = custom
    ? LanguageDescription.of({ name, support: patchSyntaxTags(withCommentTokens(custom, name), name) })
    : LanguageDescription.matchLanguageName(languages, name, true);
  descriptions.set(cacheKey, found ?? null);
  return found ?? null;
}

const loaded = new Map<string, LanguageSupport | null>();
const inFlight = new Map<string, Promise<LanguageSupport | null>>();

/**
 * 把某门语言的语法包装进内存；已经装好时同步就有结果。
 *
 * `@codemirror/language-data` 每种语言一个动态 import，装不动就是「这门没有语法」——
 * 桌面应用离线跑不该因此抛错，所以只留一条 catch 路。认不出语言时不进缓存，
 * 免得一个拼错的围栏标记把这个名字永久钉死。
 */
export function loadGrammar(lang: string, fileExt = ""): Promise<LanguageSupport | null> {
  const description = describeGrammar(lang, fileExt);
  if (!description) return Promise.resolve(null);
  if (description.support) return Promise.resolve(description.support);
  const key = description.name.toLowerCase();
  const cached = loaded.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  let running = inFlight.get(key);
  if (!running) {
    running = description
      .load()
      .catch(() => null)
      .then((support) => {
        inFlight.delete(key);
        const value = support
          ? patchSyntaxTags(withCommentTokens(support, description.name), description.name)
          : null;
        loaded.set(key, value);
        return value;
      });
    inFlight.set(key, running);
  }
  return running;
}

/** 已经就位的那份语法包装；还没装载完时返回 null。 */
export function grammarSupport(lang: string, fileExt = ""): LanguageSupport | null {
  return describeGrammar(lang, fileExt)?.support ?? null;
}

/** 认不认得这门语言（不要求语法包已装载）：调用方据此决定走高亮还是走素文本。 */
export function hasGrammar(lang: string): boolean {
  return describeGrammar(lang) !== null;
}

/**
 * 把还没装进来的语法装上；没装过东西时返回 false，调用方据此省掉一次重渲染。
 *
 * 这里只认围栏标记（没有文件名可问），所以走的是不带后缀的那条判定。
 */
export async function prepareHighlight(langs: Iterable<string>): Promise<boolean> {
  const missing: Array<Promise<unknown>> = [];
  for (const lang of langs) {
    const description = describeGrammar(lang);
    if (description && !description.support) missing.push(loadGrammar(lang));
  }
  if (!missing.length) return false;
  await Promise.all(missing);
  return true;
}

/** 扫出正文里所有围栏标注的语言，供 prepareHighlight 用。 */
export function fenceLanguages(source: string): string[] {
  const out: string[] = [];
  const re = /^[ \t]*(?:```|~~~)[ \t]*([^\s`:]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) out.push(match[1].toLowerCase());
  return out;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 高亮成 HTML；语法还没就位、或解析抛错时返回 null，由调用方决定退回素文本。
 *
 * `highlightCode` 的回调按"一段文本 + 一组类名"给，换行单独回调一次——所以这里
 * 收到的文本块不含 `\n`，行尾要自己补回去，否则多行代码会被拼成一行。
 */
export function highlightCodeHtml(text: string, lang: string): string | null {
  const description = describeGrammar(lang);
  const support = description?.support;
  if (!support) return null;
  try {
    const tree = support.language.parser.parse(text);
    let html = "";
    highlightCode(
      text,
      tree,
      classHighlighter,
      (chunk, classes) => {
        const escaped = escapeHtml(chunk);
        html += classes ? `<span class="${classes}">${escaped}</span>` : escaped;
      },
      () => {
        html += "\n";
      }
    );
    return html;
  } catch {
    return null;
  }
}
