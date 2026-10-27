import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      key === "ai.deleteConfirm" ? `Delete ${vars?.name}?` : key,
  }),
}));

import AiSessionTabMenu from "../../src/components/AiSessionTabMenu";
import type { AiSession } from "../../src/lib/aiSessions";

describe("AiSessionTabMenu 标签栏会话菜单", () => {
  const sampleSession: AiSession = {
    id: "session-123",
    title: "测试会话",
    provider: "codex",
    createdAt: 1000,
  };

  it("初始渲染包含更多操作按钮（三个点）", () => {
    const html = renderToStaticMarkup(
      createElement(AiSessionTabMenu, {
        session: sampleSession,
        onAction: vi.fn(),
        onNew: vi.fn(),
        onSettings: vi.fn(),
      })
    );
    expect(html).toContain("ai-session-tab-menu-btn");
    expect(html).toContain('aria-label="ai.sidebar.moreOptions"');
  });
});
