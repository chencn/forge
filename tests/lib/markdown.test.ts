import { describe, expect, it, vi } from "vitest";

// node 环境里 DOMPurify 拿不到 window，连 sanitize 方法都不会挂上（和
// tests/components/AiSessionPane.test.ts 同样的处理）。所以这里断言的是 marked + hljs
// 产出的标记形状；白名单真正洗掉了什么，只能在浏览器里验。
const sanitize = vi.hoisted(() => vi.fn((html: string) => html));
vi.mock("dompurify", () => ({ default: { sanitize } }));

import { renderChatMarkdown, renderCodeBlock, renderMarkdown } from "../../src/lib/markdown";

describe("renderCodeBlock", () => {
  it("highlights a known language and labels it", () => {
    const html = renderCodeBlock("const a = 1;", "TypeScript");
    expect(html).toContain('<div class="code-block-wrapper">');
    expect(html).toContain('class="hljs language-typescript"');
    expect(html).toContain('<span class="code-lang-tag">typescript</span>');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  it("escapes code when highlighting is skipped", () => {
    const html = renderCodeBlock("<script>alert(1)</script>", "plaintext");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("hljs-keyword");
  });

  it("still wraps an unknown language instead of dropping it", () => {
    const html = renderCodeBlock("plain words only", "klingon");
    expect(html).toContain('class="hljs language-klingon"');
    expect(html).toContain("<pre><code");
  });

  it("omits the copy affordance unless a label is given", () => {
    expect(renderCodeBlock("a", "ts")).not.toContain("data-code-copy");
    const html = renderCodeBlock("a", "ts", "复制代码");
    expect(html).toContain('class="code-copy"');
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-code-copy="1"');
    expect(html).toContain('aria-label="复制代码"');
    // 按钮排在标签之后、pre 之前：靠 DOM 顺序压在语言标签上方。
    expect(html.indexOf("code-lang-tag")).toBeLessThan(html.indexOf("code-copy"));
    expect(html.indexOf("code-copy")).toBeLessThan(html.indexOf("<pre>"));
  });

  it("escapes the copy label", () => {
    const html = renderCodeBlock("a", "ts", '</span><b class="x">');
    expect(html).not.toContain('<b class="x">');
    expect(html).toContain("&lt;b");
  });
});

describe("renderChatMarkdown", () => {
  it("renders fenced code with highlight and a copy button", () => {
    const html = renderChatMarkdown("```ts\nconst a = 1;\n```\n", "Copy");
    expect(html).toContain('class="hljs language-ts"');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('data-code-copy="1"');
    expect(html).toContain(">Copy</span>");
  });

  it("gives every fenced block its own button", () => {
    const html = renderChatMarkdown("```sh\na\n```\ntext\n```sh\nb\n```", "复制");
    expect(html.match(/data-code-copy="1"/g)).toHaveLength(2);
    expect(html.match(/class="code-block-wrapper"/g)).toHaveLength(2);
  });

  it("leaves prose and inline code untouched", () => {
    const html = renderChatMarkdown("看 `src/a.ts` 这行。", "复制");
    expect(html).toContain("<p>");
    expect(html).toContain("<code>src/a.ts</code>");
    expect(html).not.toContain("code-block-wrapper");
  });

  it("marks a file link with its path and line", () => {
    const html = renderChatMarkdown("见 [a.ts](src/a.ts:12)。", "复制");
    expect(html).toContain('class="ai-file-link"');
    expect(html).toContain('href="#"');
    expect(html).toContain('data-file-path="src/a.ts"');
    expect(html).toContain('data-file-line="12"');
    expect(html).toContain('title="src/a.ts:12"');
    expect(html).toContain(">a.ts</a>");
  });

  it("recognises a root file position and a hash line", () => {
    expect(renderChatMarkdown("[a.ts](a.ts:3)", "复制")).toContain('data-file-path="a.ts"');
    expect(renderChatMarkdown("[a.md](a.md#L9)", "复制")).toContain('data-file-line="9"');
  });

  it("reads a Windows path whose separators got percent-encoded", () => {
    const html = renderChatMarkdown(String.raw`[a.ts](C:\repo\a.ts:12)`, "复制");
    expect(html).toContain('data-file-path="C:/repo/a.ts"');
    expect(html).toContain('data-file-line="12"');
  });

  it("leaves web links as ordinary links", () => {
    const html = renderChatMarkdown("[docs](https://example.com/a)", "复制");
    expect(html).toContain('<a href="https://example.com/a">docs</a>');
    expect(html).not.toContain("data-file-path");
  });
});

describe("renderMarkdown", () => {
  it("keeps the doc-preview code block copy-free", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```", "D:/docs/a.md", (p) => `asset:///${p}`);
    expect(html).toContain('class="hljs language-ts"');
    expect(html).toContain('<span class="code-lang-tag">ts</span>');
    expect(html).not.toContain("data-code-copy");
  });
});
