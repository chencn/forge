import { describe, expect, it } from "vitest";
import { describeGrammar, highlightCodeHtml, loadGrammar, pathExtension } from "../../src/lib/cm/grammars";

/**
 * 语言 id → Lezer 语法的判定表。这里守住的是「认不准就不上色」这条底线：
 * `matchLanguageName` 会把 `javascriptreact` 认成 Java、`plaintext` 认成 LaTeX，
 * 拿错语法去染整篇正文比素文本糟得多。
 */
describe("语法判定", () => {
  it("tsx / jsx 按文档后缀纠到 TSX / JSX", () => {
    // editorEnv 给的语言 id 只有 typescript / javascript（那是 tsserver 的口径）。
    expect(describeGrammar("typescript", "tsx")?.name).toBe("TSX");
    expect(describeGrammar("javascript", "jsx")?.name).toBe("JSX");
    expect(describeGrammar("typescript")?.name).toBe("TypeScript");
  });

  it("会认错成别的语言的那些 id 不上错语法", () => {
    expect(describeGrammar("javascriptreact")).toBeNull();
    // reST 不再被模糊匹配拉去 LaTeX（那会把整篇串色），改按 Markdown 近似。
    expect(describeGrammar("restructuredtext")?.name).toBe("Markdown");
  });

  it("显式写着纯文本的标记不查表也不加载", () => {
    expect(describeGrammar("plaintext")).toBeNull();
    expect(describeGrammar("log")).toBeNull();
    expect(describeGrammar("")).toBeNull();
  });

  it("id 与表里叫法不一致的按表里那个名字找", () => {
    expect(describeGrammar("proto")?.name).toBe("ProtoBuf");
    expect(describeGrammar("gradle")?.name).toBe("Groovy");
    expect(describeGrammar("rs")?.name).toBe("Rust");
    expect(describeGrammar("yml")?.name).toBe("YAML");
  });

  it("老的 Monaco 语言 id 一门都不能掉", () => {
    // 这份名单是从删掉的 monacoEnv.ts 里原样抄下来的：换引擎时最容易丢的就是
    // 「表里还在、语法包里没有」的那批，打开就是一篇素文本。
    const old = (
      "bat bicep c clojure cmake coffeescript cpp csharp css cypher dart dockerfile elixir freemarker2 " +
      "fsharp go gradle graphql handlebars hcl html http ini java javascript json julia kotlin less liquid " +
      "lua makefile markdown mdx msdax nsis objective-c pascal perl php powerquery powershell properties " +
      "proto pug python r razor restructuredtext ruby rust scala scheme scss shell sol sparql sql st swift " +
      "systemverilog tcl twig typescript typespec wgsl xml yaml gomod pip-requirements"
    ).split(" ");
    const missing = old.filter((id) => describeGrammar(id) === null);
    expect(missing).toEqual([]);
  });

  it("JVM 那几门都认得（Java / Kotlin / Scala / Groovy / Gradle）", () => {
    expect(describeGrammar("java")?.name).toBe("Java");
    expect(describeGrammar("kotlin")?.name).toBe("Kotlin");
    expect(describeGrammar("kt")?.name).toBe("Kotlin");
    expect(describeGrammar("scala")?.name).toBe("Scala");
    expect(describeGrammar("groovy")?.name).toBe("Groovy");
    expect(describeGrammar("gradle")?.name).toBe("Groovy");
  });

  it("自己补的那批真能出高亮", async () => {
    const cases: Array<[string, string]> = [
      ["hcl", 'resource "x" "y" {}\n'],
      ["graphql", "query Q { user(id: 1) { name } }\n"],
      ["gomod", "module example.com/x\n\nrequire (\n\tgithub.com/a/b v1.2.3\n)\n"],
      ["pip-requirements", "requests==2.31.0  # http\n"],
      ["makefile", "all: build\nbuild:\n\tgo build ./...\n"],
      ["sol", "pragma solidity ^0.8.0;\ncontract A {}\n"],
      ["wgsl", "@fragment fn main() -> vec4<f32> { return vec4<f32>(1.0); }\n"],
      ["st", "IF a AND b THEN\n  x := 1;\nEND_IF\n"],
      ["bicep", "param name string = 'x'\nresource r 'Microsoft.Storage/storageAccounts@2023-01-01' = {}\n"],
      ["elixir", "defmodule A do\n  def hi, do: :ok\nend\n"],
      ["typespec", "namespace Demo;\nmodel Pet { name: string; }\n"],
      ["msdax", "EVALUATE SUMMARIZE(Sales, Sales[Year])\n"],
      ["powerquery", "let\n  x = 1\nin\n  x\n"],
      ["batch", "REM hi\n@echo off\nset X=1\nif exist a del a\n"],
    ];
    for (const [lang, code] of cases) {
      await loadGrammar(lang);
      const html = highlightCodeHtml(code, lang);
      expect(html, lang).toContain("<span");
    }
  });

  it("后缀取文件名最后一段，没有后缀给空串", () => {
    expect(pathExtension("D:/proj/src/a.tsx")).toBe("tsx");
    expect(pathExtension("D:/proj/Makefile")).toBe("");
    expect(pathExtension("D:/proj/.gitignore")).toBe("");
    expect(pathExtension("D:/proj/dir.d/readme")).toBe("");
  });
});
