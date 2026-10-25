import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AiSearchState } from "../../src/hooks/useAiSessionSearch";
import type { AiSearchHit } from "../../src/lib/aiSearch";

vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key) }),
}));

import AiSearchResults from "../../src/components/AiSearchResults";

function hit(over: Partial<AiSearchHit> = {}): AiSearchHit {
  return { sessionId: "s1", sessionTitle: "修构建", provider: "codex", createdAt: 10, seq: 3, kind: "text",
    text: "前面 keyword 后面", start: 3, length: 7, leading: true, trailing: true, ...over };
}

function render(state: AiSearchState, query = "keyword", archived = false) {
  return renderToStaticMarkup(createElement(AiSearchResults, { state, query, archived, onOpen: vi.fn() }));
}

const ready = (over: Partial<AiSearchState> = {}, hits: AiSearchHit[] = [hit()]): AiSearchState => ({
  status: "ready", query: "keyword", archived: false, workspace: "D:/project", error: null,
  result: { hits, scanned: 4, skipped: 0, bytes: 1024, truncated: false }, ...over,
});

describe("AiSearchResults 的归属判定", () => {
  it("查询词已经变了：一条旧命中都不显示", () => {
    expect(render(ready(), "keywor")).toBe("");
    expect(render(ready(), "keywordx")).toBe("");
    // 首尾空白会被归一化掉，那还是同一次查询。
    expect(render(ready(), "  keyword  ")).toContain("修构建");
  });
  it("搜索范围刚切到含已归档：旧范围的命中不能冒充新范围的结论", () => {
    expect(render(ready(), "keyword", true)).toBe("");
    expect(render(ready({ archived: true }, [hit()]), "keyword", true)).toContain("修构建");
  });
});

describe("AiSearchResults 的状态", () => {
  it("扫描中给出进行时，不提前说「没找到」", () => {
    const html = render({ status: "loading", query: "keyword", archived: false, workspace: "D:/project", result: null, error: null });
    expect(html).toContain("ai.search.searching");
    expect(html).not.toContain("ai.search.none");
  });
  it("失败和没命中是两件事，各说各的", () => {
    const failed = render({ status: "failed", query: "keyword", archived: false, workspace: "D:/project", result: null, error: "会话日志不可读" });
    expect(failed).toContain('class="ai-error" role="alert">会话日志不可读');
    expect(failed).not.toContain("ai.search.none");
    expect(render(ready({ result: { hits: [], scanned: 4, skipped: 0, bytes: 1024, truncated: false } })))
      .toContain("ai.search.none:keyword");
  });
  it("空输入不渲染任何东西", () => {
    expect(render({ status: "idle", query: "", archived: false, workspace: null, result: null, error: null }, "")).toBe("");
  });
});

describe("AiSearchResults 的命中列表", () => {
  it("按会话归组，命中片段只高亮后端标出的那一段", () => {
    const html = render(ready({}, [hit(), hit({ seq: 8, sessionId: "s2", sessionTitle: "另一段", text: "keyword 开头", start: 0, length: 7, leading: false })]));
    expect(html.match(/class="ai-search-group-head/g)).toHaveLength(2);
    expect(html).toContain("ai.search.count:2,2,4");
    expect(html).toContain('<mark class="ai-search-mark">keyword</mark>');
    expect(html).toContain("前面 ");
    expect(html).toContain(" 后面");
    // 命中在片段开头就不硬凑一个省略号：第一条前后各一个，第二条只有结尾。
    expect(html.match(/class="ai-search-cut"/g)).toHaveLength(3);
  });
  it("没扫完与读不出的会话都要说明，不能让用户以为看到了全部", () => {
    const html = render(ready({ result: { hits: [hit()], scanned: 9, skipped: 2, bytes: 33, truncated: true } }));
    expect(html).toContain("ai.search.partial");
    expect(html).toContain("ai.search.skipped:2");
    const quiet = render(ready());
    expect(quiet).not.toContain("ai.search.partial");
    expect(quiet).not.toContain("ai.search.skipped");
  });
  it("零命中但确有会话没读过时，仍然要说没读，而不是干净的一句「没有」", () => {
    const html = render(ready({ result: { hits: [], scanned: 1, skipped: 3, bytes: 8, truncated: true } }));
    expect(html).toContain("ai.search.none:keyword");
    expect(html).toContain("ai.search.skipped:3");
    expect(html).toContain("ai.search.partial");
  });
  it("标题为空的会话仍能被打开，占位文案不顶替真实标题", () => {
    const html = render(ready({}, [hit({ sessionTitle: "" })]));
    expect(html).toContain("ai.search.untitled");
    expect(html).toContain('aria-label="ai.search.open ');
  });
});
