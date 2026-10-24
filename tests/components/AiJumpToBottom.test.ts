import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${vars.count}` : key) }),
}));

import AiJumpToBottom from "../../src/components/AiJumpToBottom";

const render = (unseen: number) => renderToStaticMarkup(createElement(AiJumpToBottom, { unseen, onClick: () => {} }));

describe("AiJumpToBottom", () => {
  it("shows only the arrow when nothing has arrived", () => {
    const html = render(0);
    expect(html).toContain('aria-label="ai.chat.scrollToBottom"');
    expect(html).not.toContain("has-count");
    expect(html).not.toContain("ai.chat.newMessages");
  });

  it("switches to the pending count once messages arrive", () => {
    const html = render(3);
    expect(html).toContain('aria-label="ai.chat.newMessages:3"');
    expect(html).toContain("has-count");
    expect(html).toContain(">3</span>");
  });

  it("caps the badge so a long stream cannot stretch it", () => {
    expect(render(100)).toContain(">99+</span>");
    expect(render(99)).toContain(">99</span>");
  });

  it("is a real button so the click reaches the clipboard-free scroll action", () => {
    expect(render(0)).toContain('type="button"');
  });
});
