import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n";
import AiContextDetails from "../../src/components/AiContextDetails";
import AiContextChip from "../../src/components/AiContextChip";
import { normalizeAiContext } from "../../src/lib/aiContext";
import type { AiContext } from "../../src/lib/aiContext";
import { NO_COMPACT_DECISION } from "../../src/lib/aiCompact";

/** 压缩判定由面板算；这里只测快照的新旧与来源，给中性值即可。 */
const compactProps = { compact: NO_COMPACT_DECISION, autoCompact: false, compacting: false, onCompact: () => {}, onCompactLater: () => {}, onAutoCompact: () => {} };

const context = normalizeAiContext({
  detail: "summary", capturedAt: 1700000000000, model: "fixture-resolved", requestedModel: "alias", totalTokens: 6000, rawMaxTokens: 10000,
  categories: [{ name: "System prompt", tokens: 1000, kind: "used" }, { name: "MCP tools", tokens: 2000, kind: "used" }, { name: "Messages", tokens: 3000, kind: "used" }, { name: "deferred-schema", tokens: 90000, kind: "deferred" }],
  systemPromptSections: [{ name: "base-instructions", tokens: 1000 }],
  mcpTools: [{ name: "read-fixture", serverName: "fixture-server", tokens: 2000, isLoaded: true }],
  messageBreakdown: { userMessageTokens: 500, toolResultTokens: 2500 },
}, "run")!;
function render(provider: "claude" | "codex", snapshot?: AiContext, unavailable = false) {
  return renderToStaticMarkup(createElement(I18nProvider, { lang: "zh", onLangChange: () => {}, children: createElement(AiContextDetails, { provider, context: snapshot, unavailable }) }));
}
describe("context composition panel", () => {
  it("shows system, MCP and conversation token counts and window shares", () => {
    const html = render("claude", context);
    for (const text of ["系统提示词", "MCP 工具定义", "会话消息", "1,000", "2,000", "3,000", "10%", "20%", "30%", "60%", "base-instructions", "read-fixture", "fixture-server", "用户消息", "工具返回内容", "CLI 本地估算"]) expect(html).toContain(text);
    expect(html).not.toContain("900%");
    expect(html).not.toContain("CLI 报告用量");
    expect(html).not.toContain("输入 tokens");
    expect(html).not.toContain("费用");
  });
  it("distinguishes unavailable, uncollected and stale snapshots", () => {
    expect(render("claude")).toContain("尚未取得快照");
    expect(render("claude", undefined, true)).toContain("未报告不等于零");
    const stale = render("claude", { ...context, stale: true });
    // 没有新回合时，上一份快照仍是用户唯一能看到的上下文：保留数字，只加过期警告。
    expect(stale).toContain("已过期");
    expect(stale).toContain("5.9 KB");
    expect(render("codex", context)).toContain("暂不提供分类明细");
    expect(render("codex", context)).not.toContain("base-instructions");
  });
  it("keeps the trigger and the detail panel on the same fresh snapshot", () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, { lang: "zh", onLangChange: () => {}, children: createElement(AiContextChip, { provider: "claude", selectedModel: "alias", context, usage: { context: 250, window: 1000, total: 8000 }, ...compactProps }) }));
    // 新鲜快照优先：不能外面显示实时用量、点开又换成另一份数字。
    expect(html).toContain("60%");
    expect(html).not.toContain("25%");
  });
  it("keeps the last known snapshot on the trigger when the model changed", () => {
    const chip = (model: string, stale = false) => renderToStaticMarkup(createElement(I18nProvider, { lang: "zh", onLangChange: () => {}, children: createElement(AiContextChip, { provider: "claude", selectedModel: model, context: { ...context, stale }, ...compactProps }) }));
    expect(chip("alias")).toContain("60%");
    // 换过模型也仍然显示上一份上下文：没有新回合时不能把唯一的数字藏掉。
    expect(chip("different")).toContain("60%");
    expect(chip("alias", true)).toContain("60%");
  });
});
