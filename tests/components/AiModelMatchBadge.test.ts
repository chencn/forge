import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import AiModelMatchBadge from "../../src/components/AiModelMatchBadge";

const render = (props: { requested?: string; served?: string; aliases?: Record<string, string> }) =>
  renderToStaticMarkup(createElement(AiModelMatchBadge, props));

describe("AiModelMatchBadge", () => {
  it("stays quiet when the served model is what was asked for", () => {
    expect(render({ requested: "gpt-5.1-codex", served: "gpt-5.1-codex" })).toBe("");
    expect(render({ requested: "sonnet", served: "claude-sonnet-4-5-20250929", aliases: { sonnet: "claude-sonnet-4-5-20250929" } })).toBe("");
  });

  it("stays quiet rather than guessing when it cannot judge", () => {
    expect(render({ served: "gpt-5.1-codex" })).toBe("");
    expect(render({ requested: "gpt-5.1-codex" })).toBe("");
    // 沿用 CLI 默认时请求侧为空，说什么都缺依据。
    expect(render({ requested: "", served: "gpt-5.1-codex" })).toBe("");
  });

  it("names a same-generation drift without hiding the served id", () => {
    const html = render({ requested: "gpt-5.1-codex", served: "gpt-5.1-codex[1m]" });
    expect(html).toContain("is-variant");
    expect(html).toContain("gpt-5.1-codex[1m]");
    expect(html).toContain("ai.chat.modelVariant");
  });

  it("escalates a different model", () => {
    const html = render({ requested: "gpt-5", served: "gpt-5.1-codex" });
    expect(html).toContain("is-mismatch");
    expect(html).toContain("ai.chat.modelMismatch");
    expect(html).not.toContain("ai.chat.modelVariant");
  });

  it("puts the reason and both ids in the accessible name", () => {
    const html = render({ requested: "claude-sonnet-4-5", served: "claude-opus-4-1" });
    expect(html).toContain('aria-label="ai.chat.modelMismatch · claude-sonnet-4-5 → claude-opus-4-1"');
  });

  it("renders nothing else around it", () => {
    const html = render({ requested: "a", served: "b" });
    expect(html.startsWith('<span class="ai-model-match is-mismatch"')).toBe(true);
  });
});
