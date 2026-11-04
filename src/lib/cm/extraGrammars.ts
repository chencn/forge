/**
 * 老 Monaco 自带、CodeMirror 的 `@codemirror/language-data` 与 `legacy-modes` 里都没有的那些语言。
 *
 * 换引擎最容易掉的就是这一批：表里还在、语法包里没有，打开就是一篇素的。这里一门一段
 * `simpleMode`（正则切 token 的迷你语法），够把注释、字符串、数字、关键字分开——
 * 它们原来的 Monaco 版本也只是 Monarch 的同一档精度。
 *
 * 只认「这门语言」本身；Twig/FreeMarker/Handlebars 这类走 Jinja 近似、Razor 走 HTML、
 * MDX/reST 走 Markdown 的，写在 `grammars.ts` 的 SPELLINGS 里，说明也放那边。
 */
import { LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { simpleMode } from "@codemirror/legacy-modes/mode/simple-mode";
// 官方 legacy 模式里现成的几门：直接包一层补齐 IDEA 有而 language-data 没有的语言。
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { oCaml } from "@codemirror/legacy-modes/mode/mllike";
import { sass } from "@codemirror/legacy-modes/mode/sass";
import { stex } from "@codemirror/legacy-modes/mode/stex";

type States = Parameters<typeof simpleMode>[0];

/** C 系注释：`//` 与跨行的 `/* *\/`。几门语言共用。 */
const cComments = {
  block: [
    { regex: /\*\//, token: "comment", pop: true },
    { regex: /[^*/]+|[*/]/, token: "comment" },
  ],
};

function stream(states: States): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(simpleMode(states)));
}

const BATCH = stream({
  start: [
    { regex: /\bREM\b.*|::.*/i, token: "comment" },
    { regex: /%[^%\s]+%|![^!\s]+!/, token: "variableName" },
    { regex: /"(?:[^"])*"/, token: "string" },
    {
      regex: /\b(?:if|else|exist|defined|errorlevel|not|for|in|do|set|setlocal|endlocal|goto|call|exit|echo|shift|choice|start|pushd|popd|cd|copy|xcopy|del|erase|move|mkdir|md|rd|rmdir|type|more|find|findstr|pause|cls|title|color|timeout|ping|curl|powershell|attrib|ren|rename|dir|net|sc|reg)\b/i,
      token: "keyword",
    },
    { regex: /\b\d+\b/, token: "number" },
    { regex: /[()=<>|&^@]/, token: "operator" },
  ],
});

const GOMOD = stream({
  start: [
    { regex: /\/\/.*/, token: "comment" },
    { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
    { regex: /\b(?:module|go|require|replace|exclude|retract|toolchain|godebug)\b/, token: "keyword" },
    { regex: /\b(?:indirect|incompatible)\b/, token: "atom" },
    { regex: /\bv\d+(?:\.\d+)*(?:[-+][\w.]+)?\b/, token: "number" },
    { regex: /=>|\/v\d+/, token: "operator" },
    { regex: /[()]/, token: "bracket" },
  ],
});

const PIP_REQUIREMENTS = stream({
  start: [
    { regex: /#.*/, token: "comment" },
    { regex: /--?[a-zA-Z][\w-]*/, token: "keyword" },
    { regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, token: "string" },
    { regex: /\[[^\]]*\]/, token: "typeName" },
    { regex: /(?:===|==|~=|!=|<=|>=|<|>)/, token: "operator" },
    { regex: /[A-Za-z0-9][\w.-]*/, token: "variableName" },
    { regex: /[;,.\-*]/, token: "operator" },
  ],
});

const MAKEFILE = stream({
  start: [
    { regex: /#.*/, token: "comment" },
    // 行首的赋值与目标：simpleMode 的 `sol` 只在行首试，`^` 在这里不作锚点用。
    { regex: /[^\s:=#][^:=#\n]*(?=[:?+!]?=)/, token: "variableName", sol: true },
    { regex: /[^:=\t#\n]+(?=:(?!=))/, token: "def", sol: true },
    { regex: /\$[({][^)}\n]*[)}]|\$[@<^*?%+A-Z]/, token: "variableName" },
    {
      regex: /\b(?:ifeq|ifneq|ifdef|ifndef|else|endif|include|-include|sinclude|export|unexport|define|endef|override|vpath|subst|patsubst|wildcard|shell|foreach|call|eval|origin|dir|notdir|basename|suffix|addprefix|addsuffix|filter|filter-out|sort|word|words|firstword|lastword|strip|findstring)\b/,
      token: "keyword",
    },
    { regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, token: "string" },
    { regex: /\b\d+\b/, token: "number" },
    { regex: /[:=+\-@]/, token: "operator" },
  ],
});

const HCL = stream({
  start: [
    { regex: /#.*|\/\/.*/, token: "comment" },
    { regex: /\/\*/, token: "comment", push: "blockComment" },
    { regex: /<<-?\w+/, token: "string", push: "heredoc" },
    { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
    {
      regex: /\b(?:resource|data|variable|locals|module|provider|terraform|output|backend|required_version|required_providers|for|in|if|each|true|false|null|source|version|depends_on|count|dynamic|content|lookup|merge|file|templatefile|jsonencode|jsondecode|toset|tolist|tomap|length|contains|keys|values)\b/,
      token: "keyword",
    },
    { regex: /\b\d+(?:\.\d+)?\b/, token: "number" },
    { regex: /[{}[\]=?]/, token: "bracket" },
  ],
  blockComment: [
    { regex: /\*\//, token: "comment", pop: true },
    { regex: /[^*/]+|[*/]/, token: "comment" },
  ],
  heredoc: [
    { regex: /^\s*\w+\s*$/, token: "string", pop: true },
    { regex: /.*/, token: "string" },
  ],
});

const BICEP = stream({
  start: [
    { regex: /\/\/.*/, token: "comment" },
    { regex: /'''[\s\S]*?'''|'(?:[^'\\]|\\.)*'/, token: "string" },
    { regex: /@[A-Za-z][\w.]*/, token: "meta" },
    {
      regex: /\b(?:param|var|resource|module|output|targetScope|existing|if|for|in|true|false|null|import|type|func|assert|metadata|extension|using|with|as|provider)\b/,
      token: "keyword",
    },
    { regex: /\b(?:string|int|bool|object|array|any|secureString|secureObject)\b/, token: "typeName" },
    { regex: /\b\d+\b/, token: "number" },
    { regex: /[{}[\]:?!]/, token: "bracket" },
  ],
});

const GRAPHQL = stream({
  start: [
    { regex: /#[^\n]*/, token: "comment" },
    { regex: /"""/, token: "string", push: "blockString" },
    { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
    { regex: /\$[A-Za-z_]\w*/, token: "variableName" },
    { regex: /@[A-Za-z_]\w*/, token: "meta" },
    {
      regex: /\b(?:query|mutation|subscription|fragment|on|type|input|enum|scalar|interface|union|schema|directive|extend|implements|repeatable|true|false|null)\b/,
      token: "keyword",
    },
    { regex: /\b\d+(?:\.\d+)?\b/, token: "number" },
    { regex: /[{}()[\]:!|=,]/, token: "bracket" },
  ],
  blockString: [
    { regex: /"""/, token: "string", pop: true },
    { regex: /[^"]+|"/, token: "string" },
  ],
});

const ELIXIR = stream({
  start: [
    { regex: /#[^\n]*/, token: "comment" },
    { regex: /"""/, token: "string", push: "blockString" },
    { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
    { regex: /'(?:[^'\\]|\\.)*'/, token: "string" },
    { regex: /~[a-zA-Z](?:\([^)]*\)|\[[^\]]*\]|"[^"]*"|\/[^/\n]*\/)[a-z]*/, token: "string" },
    { regex: /:[a-zA-Z_]\w*[?!]?/, token: "atom" },
    { regex: /@[a-zA-Z_]\w*/, token: "meta" },
    {
      regex: /\b(?:def|defp|defmodule|defmacro|defmacrop|defstruct|defimpl|defprotocol|defdelegate|defguard|defexception|do|end|fn|case|cond|if|unless|when|and|or|not|in|for|with|try|rescue|catch|after|raise|import|alias|require|use|true|false|nil|__MODULE__|__DIR__|__ENV__)\b/,
      token: "keyword",
    },
    { regex: /\b\d[\d_]*(?:\.\d+)?\b/, token: "number" },
    { regex: /[()[\],{}|]/, token: "bracket" },
  ],
  blockString: [
    { regex: /"""/, token: "string", pop: true },
    { regex: /[^"]+|"/, token: "string" },
  ],
});

const STRUCTURED_TEXT = stream({
  start: [
    { regex: /\(\*/, token: "comment", push: "blockComment" },
    { regex: /\/\/.*/, token: "comment" },
    { regex: /'(?:[^'$]|\$.)*'/, token: "string" },
    {
      regex: /\b(?:IF|THEN|ELSIF|ELSE|END_IF|CASE|OF|END_CASE|FOR|TO|BY|DO|END_FOR|WHILE|END_WHILE|REPEAT|UNTIL|EXIT|RETURN|CONTINUE|VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|END_VAR|CONSTANT|FUNCTION|END_FUNCTION|FUNCTION_BLOCK|END_FUNCTION_BLOCK|PROGRAM|END_PROGRAM|STRUCT|END_STRUCT|TYPE|END_TYPE|METHOD|END_METHOD|PROPERTY|END_PROPERTY|AND|OR|XOR|NOT|MOD|TRUE|FALSE)\b/i,
      token: "keyword",
    },
    {
      regex: /\b(?:BOOL|BYTE|WORD|DWORD|LWORD|SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|REAL|LREAL|STRING|WSTRING|TIME|LTIME|DATE|TOD|DT|ARRAY|STRUCT|POINTER|REFERENCE|ANY)\b/i,
      token: "typeName",
    },
    { regex: /\b\d[\d_]*(?:\.\d+)?(?:ms|s|m|h|d|us|ns)?\b/i, token: "number" },
    { regex: /:=|=>|<=|>=|<>|[+\-*/=<>]/, token: "operator" },
  ],
  blockComment: [
    { regex: /\*\)/, token: "comment", pop: true },
    { regex: /[^*]+|\*/, token: "comment" },
  ],
});

const MSDAX = stream({
  start: [
    { regex: /\/\/.*|--.*/, token: "comment" },
    { regex: /\/\*/, token: "comment", push: "blockComment" },
    { regex: /"(?:[^"]|"")*"/, token: "string" },
    { regex: /'(?:[^']|'')*'/, token: "string" },
    {
      regex: /\b(?:EVALUATE|DEFINE|MEASURE|COLUMN|TABLE|VAR|RETURN|ORDER|BY|ASC|DESC|START|AT|WITH|ROWS|BETWEEN|AND|OR|NOT|IN|TRUE|FALSE|CALCULATE|FILTER|ALL|ALLEXCEPT|SUM|COUNTROWS|DIVIDE|IF|SWITCH|BLANK)\b/i,
      token: "keyword",
    },
    { regex: /\[[^\]]*\]/, token: "propertyName" },
    { regex: /\b\d+(?:\.\d+)?\b/, token: "number" },
    { regex: /[(){}:,]/, token: "bracket" },
  ],
  blockComment: cComments.block,
});

const POWERQUERY = stream({
  start: [
    { regex: /\/\/.*/, token: "comment" },
    { regex: /\/\*/, token: "comment", push: "blockComment" },
    { regex: /#"(?:[^"]|"")*"/, token: "variableName" },
    { regex: /"(?:[^"]|"")*"/, token: "string" },
    {
      regex: /\b(?:let|in|each|if|then|else|try|otherwise|and|or|not|true|false|null|type|meta|error|as|is|section|shared|where|order|by|ascending|descending|distinct|equals)\b/,
      token: "keyword",
    },
    { regex: /\b(?:Text|Number|Date|DateTime|Time|Duration|Logical|Table|Record|List|Function|Binary|Value)\.\w+/, token: "typeName" },
    { regex: /\b\d+(?:\.\d+)?\b/, token: "number" },
    { regex: /[(){}[\]]/, token: "bracket" },
  ],
  blockComment: cComments.block,
});

const SOLIDITY = stream({
  start: [
    { regex: /\/\/.*/, token: "comment" },
    { regex: /\/\*/, token: "comment", push: "blockComment" },
    { regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, token: "string" },
    { regex: /0x[0-9a-fA-F]+|\b\d[\d_]*(?:\.\d+)?(?:e\d+)?\b/, token: "number" },
    { regex: /\b(?:pragma|solidity|import|as|from|contract|interface|library|abstract|is|function|modifier|event|error|struct|enum|mapping|constructor|fallback|receive|returns|return|emit|require|revert|assert|if|else|for|while|do|break|continue|try|catch|new|delete|using|virtual|override|payable|view|pure|public|private|internal|external|immutable|constant|memory|storage|calldata|indexed|anonymous|unchecked|assembly|true|false)\b/,
      token: "keyword",
    },
    { regex: /\b(?:address|bool|string|bytes|byte|uint\d*|int\d*|u?fixed\w*)\b/, token: "typeName" },
    { regex: /\b(?:wei|gwei|ether|seconds|minutes|hours|days|weeks)\b/, token: "atom" },
    { regex: /[{}[\]=!<>&|+*/%-]/, token: "operator" },
  ],
  blockComment: cComments.block,
});

const WGSL = stream({
  start: [
    { regex: /\/\/.*/, token: "comment" },
    { regex: /\/\*/, token: "comment", push: "blockComment" },
    { regex: /@[a-zA-Z]\w*/, token: "meta" },
    {
      regex: /\b(?:alias|break|case|const|const_assert|continue|continuing|default|diagnostic|discard|else|enable|false|fn|for|if|let|loop|override|requires|return|struct|switch|true|var|while)\b/,
      token: "keyword",
    },
    {
      regex: /\b(?:f32|f16|i32|u32|bool|array|atomic|ptr|sampler|sampler_comparison|texture_[\w]+|vec[234]|mat[234]x[234])\b/,
      token: "typeName",
    },
    { regex: /\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?[fhiu]?\b/, token: "number" },
    { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
    { regex: /[{}[\]=!<>&|+*/%\-.,]/, token: "operator" },
  ],
  blockComment: cComments.block,
});

const TYPESPEC = stream({
  start: [
    { regex: /\/\/.*/, token: "comment" },
    { regex: /\/\*/, token: "comment", push: "blockComment" },
    { regex: /@[A-Za-z_][\w.]*/, token: "meta" },
    { regex: /"""/, token: "string", push: "blockString" },
    { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
    {
      regex: /\b(?:namespace|model|op|interface|enum|union|scalar|alias|extends|is|import|using|extern|dec|fn|init|true|false|null|valueof|never|unknown|void|projection|to|from|where|of)\b/,
      token: "keyword",
    },
    { regex: /\b\d+(?:\.\d+)?\b/, token: "number" },
    { regex: /[{}[\]=<>|&?:,.]/, token: "operator" },
  ],
  blockComment: cComments.block,
  blockString: [
    { regex: /"""/, token: "string", pop: true },
    { regex: /[^"]+|"/, token: "string" },
  ],
});

/**
 * `.http` / `.rest` 请求文件：`###` 分隔线、注释与 `# @name`、`@var = value`、请求行、
 * 头部、`{{变量}}`、`< file` 引用与 `> {% %}` 处理块。
 *
 * 移植自 openidea `features/http-client/language.ts`。其余语言多是 `simpleMode` 正则切片，
 * 这门要跨行状态（前导 → 头部 → 正文、handler 块），所以用完整 `StreamParser`。
 */
interface HttpState {
  phase: "preamble" | "headers" | "body";
  /** 是否在 `> {% … %}` 处理脚本里。 */
  handler: boolean;
  part: "start" | "url" | "headerValue" | "rest";
}

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT"];

function httpVariable(stream: Parameters<StreamParser<HttpState>["token"]>[0]): string | null {
  if (stream.match("{{")) {
    stream.match(/^[^}]*/);
    stream.match("}}");
    return "variableName.special";
  }
  return null;
}

const httpParser: StreamParser<HttpState> = {
  name: "http",
  startState: () => ({ phase: "preamble", handler: false, part: "start" }),
  copyState: (s) => ({ ...s }),
  blankLine(state) {
    if (state.phase === "headers" || (state.phase === "preamble" && state.part === "url")) state.phase = "body";
  },
  token(stream, state) {
    if (stream.sol()) {
      // 请求行的下一行开始是头部。
      if (state.phase === "preamble" && state.part === "url") state.phase = "headers";
      state.part = "start";
      if (stream.match(/^\s*###/)) {
        stream.skipToEnd();
        state.phase = "preamble";
        state.handler = false;
        return "heading";
      }
    }
    if (state.handler) {
      if (stream.match(/^.*%\}/)) {
        state.handler = false;
        return "meta";
      }
      stream.skipToEnd();
      return "comment";
    }
    const v = httpVariable(stream);
    if (v) return v;

    if (state.phase === "preamble") {
      if (state.part === "start") {
        if (stream.eatSpace()) return null;
        if (stream.match(/^(#|\/\/)\s*@name\b/)) {
          state.part = "rest";
          return "meta";
        }
        if (stream.match(/^(#|\/\/)/)) {
          stream.skipToEnd();
          return "comment";
        }
        if (stream.match(/^@[\w.-]+/)) {
          state.part = "rest";
          return "variableName.definition";
        }
        const method = stream.match(new RegExp(`^(${HTTP_METHODS.join("|")})(?=\\s)`));
        if (method) {
          state.part = "url";
          return "keyword";
        }
        if (stream.match(/^(https?:\/\/|\/)/, false)) {
          state.part = "url";
          return null;
        }
        stream.skipToEnd();
        return null;
      }
      if (state.part === "url") {
        if (stream.match(/^\s+HTTP\/[\d.]+\s*$/)) return "meta";
        if (stream.eatSpace()) return null;
        if (!stream.match(/^[^\s{]+/)) stream.next();
        return "link";
      }
      // `@name` / `@var` 的剩余部分。
      if (stream.match(/^\s*=\s*/)) return "operator";
      if (!stream.match(/^[^{]+/)) stream.next();
      return "string";
    }

    if (state.phase === "headers") {
      if (state.part === "start") {
        if (stream.match(/^\s+[?&/]/)) {
          state.part = "url";
          return "link";
        }
        if (stream.match(/^(#|\/\/)/)) {
          stream.skipToEnd();
          return "comment";
        }
        if (stream.match(/^[^:\s]+(?=:)/)) {
          state.part = "headerValue";
          return "propertyName";
        }
        stream.skipToEnd();
        return null;
      }
      if (state.part === "url") {
        if (!stream.match(/^[^\s{]+/)) stream.next();
        return "link";
      }
      if (stream.eat(":")) return "punctuation";
      if (!stream.match(/^[^{]+/)) stream.next();
      return "string";
    }

    // 正文。
    if (state.part === "start") {
      state.part = "rest";
      if (stream.match(/^\s*>\s*\{%/)) {
        state.handler = !stream.match(/^.*%\}\s*$/);
        if (!state.handler) return "meta";
        stream.skipToEnd();
        return "meta";
      }
      if (stream.match(/^\s*(<>|>>|>|<)\s/)) {
        stream.skipToEnd();
        return "meta";
      }
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?\b/)) return "number";
    if (stream.match(/^(true|false|null)\b/)) return "atom";
    if (!stream.match(/^[^"{\d\-tfn]+/)) stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
};

const HTTP = new LanguageSupport(StreamLanguage.define(httpParser));

/**
 * 名字 → 语法。键是 `describeGrammar` 归一化之后的名字（SPELLINGS 的结果），
 * 不是文件后缀。
 */
const legacy = (mode: Parameters<typeof StreamLanguage.define>[0]) =>
  new LanguageSupport(StreamLanguage.define(mode));

const EXTRA: Record<string, () => LanguageSupport> = {
  http: () => HTTP,
  batch: () => BATCH,
  diff: () => legacy(diff),
  haskell: () => legacy(haskell),
  erlang: () => legacy(erlang),
  ocaml: () => legacy(oCaml),
  latex: () => legacy(stex),
  tex: () => legacy(stex),
  sass: () => legacy(sass),
  gomod: () => GOMOD,
  gowork: () => GOMOD,
  "pip-requirements": () => PIP_REQUIREMENTS,
  makefile: () => MAKEFILE,
  hcl: () => HCL,
  bicep: () => BICEP,
  graphql: () => GRAPHQL,
  elixir: () => ELIXIR,
  st: () => STRUCTURED_TEXT,
  msdax: () => MSDAX,
  powerquery: () => POWERQUERY,
  sol: () => SOLIDITY,
  wgsl: () => WGSL,
  typespec: () => TYPESPEC,
};

/** 这一门是不是我们自己补的那批（没补的走 `@codemirror/language-data`）。 */
export function extraGrammar(name: string): LanguageSupport | null {
  return EXTRA[name]?.() ?? null;
}
