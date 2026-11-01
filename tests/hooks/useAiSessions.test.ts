import { afterEach, describe, expect, it, vi } from "vitest";

// 直接验证 store 的启停行为；订阅与重渲染由 React 自身负责。
vi.mock("react", () => ({
  useEffect: () => {},
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
import { useAiSessions } from "../../src/hooks/useAiSessions";

const session = { id: "old-session", provider: "codex" as const, title: "Existing", createdAt: 1 };
afterEach(() => { vi.unstubAllGlobals(); });

describe("AI 会话 store", () => {
  it("打开动作明确报告会话是否存在，禁止调用方切到空标签", () => {
    const storage = { getItem: vi.fn(() => JSON.stringify({ sessions: [session], openIds: [] })), setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    const result = useAiSessions("D:/known-ai-session");
    // 右侧栏可能先于会话目录刷新收到子代理 ID；未知 ID 必须保持失败，刷新后才能重试。
    expect(result.dispatch({ type: "open", id: "missing-session" })).toBe(false);
    expect(result.dispatch({ type: "open", id: session.id })).toBe(true);
  });
});
