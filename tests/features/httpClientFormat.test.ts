import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { bodyKind, formatMs, formatSize, prettyBody, prettyMarkup } from "../../src/features/http-client/format";
import { extraGrammar } from "../../src/lib/cm/extraGrammars";

describe("响应正文", () => {
  it("先看内容类型，否则看正文本身判定种类", () => {
    expect(bodyKind("application/json; charset=utf-8", "x")).toBe("json");
    expect(bodyKind("application/problem+json", "x")).toBe("json");
    expect(bodyKind("text/html", "")).toBe("html");
    expect(bodyKind("application/xml", "")).toBe("xml");
    expect(bodyKind(null, ' {"a":1}')).toBe("json");
    expect(bodyKind(null, "{not json")).toBe("text");
    expect(bodyKind(null, "<!DOCTYPE html><html></html>")).toBe("html");
    expect(bodyKind(null, "<?xml version='1.0'?><a/>")).toBe("xml");
    expect(bodyKind(null, "plain")).toBe("text");
  });

  it("美化 JSON，非法 JSON 原样返回", () => {
    expect(prettyBody("json", '{"a":[1,2],"b":null}')).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": null\n}');
    expect(prettyBody("json", "{oops")).toBe("{oops");
  });

  it("按嵌套重排 XML，纯文本元素保持一行", () => {
    expect(prettyMarkup('<?xml version="1.0"?><a><b>1</b><c/><d><e>x</e></d><f></f></a>')).toBe(
      [
        '<?xml version="1.0"?>',
        "<a>",
        "  <b>1</b>",
        "  <c/>",
        "  <d>",
        "    <e>x</e>",
        "  </d>",
        "  <f></f>",
        "</a>",
      ].join("\n"),
    );
  });

  it("重排 HTML，处理空元素与 script 原样内容", () => {
    const html =
      "<html><head><meta charset=utf-8><script>if (a < b) { x(); }</script></head><body><p>Hi</p><br></body></html>";
    expect(prettyMarkup(html, true)).toBe(
      [
        "<html>",
        "  <head>",
        "    <meta charset=utf-8>",
        "    <script>if (a < b) { x(); }</script>",
        "  </head>",
        "  <body>",
        "    <p>Hi</p>",
        "    <br>",
        "  </body>",
        "</html>",
      ].join("\n"),
    );
  });

  it("格式化大小与耗时", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(null)).toBe("0 B");
    expect(formatMs(12.4)).toBe("12 ms");
    expect(formatMs(1500)).toBe("1.50 s");
  });
});

describe("http 高亮", () => {
  const httpLanguage = extraGrammar("http")!;

  function tokens(text: string): Array<[string, string]> {
    const state = EditorState.create({ doc: text, extensions: httpLanguage });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
    const out: Array<[string, string]> = [];
    tree.iterate({
      enter: (n) => {
        if (n.name !== "Document" && n.from < n.to) out.push([n.name, state.sliceDoc(n.from, n.to)]);
      },
    });
    return out;
  }

  it("标出分隔线、方法、URL、头部、变量与注释", () => {
    const t = tokens('### Users\n# @name list\nGET https://{{host}}/users\nAccept: json\n\n{"a": 1}\n');
    const has = (name: string, text: string) => t.some(([n, s]) => n.includes(name) && s === text);
    expect(has("heading", "### Users")).toBe(true);
    expect(has("keyword", "GET")).toBe(true);
    expect(has("link", "https://")).toBe(true);
    expect(has("variableName", "{{host}}")).toBe(true);
    expect(has("propertyName", "Accept")).toBe(true);
    expect(has("string", " json")).toBe(true);
    expect(has("string", '"a"')).toBe(true);
    expect(has("number", "1")).toBe(true);
    expect(has("meta", "# @name")).toBe(true);
  });
});
