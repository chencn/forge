import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AiRequest } from "../../src/lib/aiRuntime";

vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import { AiQuestionCard, AiQuestionResult } from "../../src/components/AiQuestionCard";

/**
 * 提问卡：界面上的取舍都写死在渲染结果里，所以这里量的是 HTML——
 * 「其他」是不是排成最后一项、推荐有没有拆成徽标、答完的卡有没有换成结果行。
 */
function ask(overrides: Partial<AiRequest> = {}): AiRequest {
  return {
    requestId: "q1", runId: "r1", kind: "question", title: "AskUserQuestion", detail: "", active: true,
    questions: [{ id: "lang", question: "用哪种语言？", options: [{ label: "中文" }, { label: "English (recommended)" }] }],
    ...overrides,
  } as AiRequest;
}

describe("AiQuestionCard", () => {
  it("一题时不给页签和进度条，但给整行选项与「其他」", () => {
    const html = renderToStaticMarkup(createElement(AiQuestionCard, { request: ask() }));
    expect(html).not.toContain("ai-question-tabs");
    expect(html).not.toContain("ai-question-progress");
    expect(html).toContain("ai.runtime.singleChoice");
    // 选项做成 label 包 input：点文字同样选中，不必瞄那颗 16px 的圆圈。
    expect(html).toContain('<label class="ai-question-option"');
    expect(html).toContain("English");
    // 「(recommended)」只从正文里拆走，显示成徽标；提交给后端的仍是原文。
    expect(html).not.toContain("(recommended)");
    expect(html).toContain('<em class="ai-question-tag">ai.runtime.recommended</em>');
    expect((html.match(/<label class="ai-question-option/g) ?? []).length).toBe(3);
    // 「其他」永远排在真选项后面：它是兜底项，混进选项中间就看不出哪个是正经答案。
    expect(html.indexOf("ai.runtime.otherAnswer")).toBeGreaterThan(html.indexOf(">English"));
  });
  it("多题时进度、页签和计数一起出现，正文只摆当前这一题", () => {
    const html = renderToStaticMarkup(createElement(AiQuestionCard, {
      request: ask({
        questions: [
          { id: "a", header: "语言", question: "用哪种语言？", options: [{ label: "中文" }] },
          { id: "b", header: "范围", question: "改哪些文件？", multiSelect: true, options: [{ label: "src" }, { label: "tests" }] },
        ],
      }),
    }));
    expect(html).toContain('class="ai-question-progress"');
    // 一题没答，所以进度条是 0%；页签上挂的是短标题，不是整句问题。
    expect(html).toContain('style="width:0%"');
    expect(html).toContain("0/2");
    expect(html).toContain("<span>语言</span>");
    expect(html).not.toContain("<span>用哪种语言？</span>");
    // 正文定高：从「一个选项」那页切到「两个选项」那页，卡片不该跟着变高。
    expect(html).toContain("ai-question-panel");
    expect(html.match(/<label class="ai-question-option/g)).toHaveLength(2);
    expect(html).toContain("ai.runtime.singleChoice");
    expect(html).not.toContain("改哪些文件？");
  });
  it("多选的题给复选框和「多选」徽标", () => {
    const html = renderToStaticMarkup(createElement(AiQuestionCard, {
      request: ask({ questions: [{ id: "b", question: "改哪些文件？", multiSelect: true, options: [{ label: "src" }] }] }),
    }));
    expect(html).toContain("ai.runtime.multiChoice");
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(2);
  });
  it("一题没答完就不给提交", () => {
    const html = renderToStaticMarkup(createElement(AiQuestionCard, { request: ask() }));
    expect(html.match(/class="button is-primary"[^>]*/)?.[0]).toContain("disabled");
  });
  it("只读留档不再摆页脚，且把当时的选择还原成选中态", () => {
    const html = renderToStaticMarkup(createElement(AiQuestionCard, { request: ask(), readOnly: true, answer: { answers: { lang: ["English (recommended)"] } } }));
    expect(html).toContain("ai-question is-read-only");
    expect(html).not.toContain("ai-question-foot");
    expect(html).toContain('class="ai-question-option is-chosen"');
    // 手打的那句排在选中项后面，和提交时给后端的那份顺序一致。
    const typed = renderToStaticMarkup(createElement(AiQuestionCard, { request: ask(), readOnly: true, answer: { answers: { lang: ["用粤语"] } } }));
    expect(typed).toContain('value="用粤语"');
    expect(typed).toContain("ai-question-option is-chosen");
  });
});

describe("AiQuestionResult", () => {
  it("没等到答复也显示问了什么：失效一行摘要 + 点开无选择的只读卡", () => {
    const html = renderToStaticMarkup(createElement(AiQuestionResult, { request: ask() }));
    expect(html).toContain("<details");
    expect(html).toContain("ai.runtime.requestExpired");
    // 摘要带问题正文：只画一句「已失效」等于把「错过了什么」也藏掉。
    expect(html).toContain('<span class="ai-question-record-summary">用哪种语言？</span>');
    // 只读卡没有答案：不摆任何选中态，也不冒充用户答过。
    expect(html).toContain("ai-question is-read-only");
    expect(html).not.toContain('checked');
  });
  it("答过了收一行摘要，展开才是整张卡", () => {
    const html = renderToStaticMarkup(createElement(AiQuestionResult, { request: ask(), answer: { answers: { lang: ["中文"] } } }));
    expect(html).toContain("<details");
    expect(html).toContain("ai.runtime.questionAnswered");
    // 摘要用拆掉「(recommended)」后的正文，多题之间用逗号分隔。
    expect(html).toContain('<span class="ai-question-record-summary">中文</span>');
    expect(html).toContain("ai-question is-read-only");
  });
  it("答案里一题都没选时说实话", () => {
    const html = renderToStaticMarkup(createElement(AiQuestionResult, { request: ask(), answer: { answers: { lang: [] } } }));
    expect(html).toContain("ai.runtime.noChoice");
  });
});
