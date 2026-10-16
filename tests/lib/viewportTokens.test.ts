import { describe, expect, it } from "vitest";
import {
  installViewportTokenization,
  isViewportTokenization,
  VIEWPORT_HIGHLIGHT_LINE_COUNT,
  viewportTokenizationSupport,
  type TokenizationRegistryLike,
} from "../../src/lib/viewportTokens";

function registryWith(id: string, support: object): TokenizationRegistryLike & { get(id: string): object | null } {
  const map = new Map<string, object>([[id, support]]);
  const listeners = new Set<(event: { changedLanguages: string[] }) => void>();
  return {
    get: (languageId) => map.get(languageId) ?? null,
    register(languageId, next) {
      map.set(languageId, next);
      for (const listener of listeners) listener({ changedLanguages: [languageId] });
      return { dispose() {} };
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose() { listeners.delete(listener); } };
    },
  };
}

describe("viewportTokenizationSupport", () => {
  const support = {
    getInitialState: () => "start",
    tokenize: (line: string) => line.length,
  };

  it("小文件仍交给整篇扫描", () => {
    const wrapped = viewportTokenizationSupport(support);
    const create = (
      wrapped as unknown as {
        createBackgroundTokenizer(model: { getLineCount(): number }): unknown;
      }
    ).createBackgroundTokenizer;
    expect(create({ getLineCount: () => VIEWPORT_HIGHLIGHT_LINE_COUNT - 1 })).toBeUndefined();
  });

  it("到了行数阈值不再整篇扫描，原来的词法函数还在", () => {
    const wrapped = viewportTokenizationSupport(support);
    const create = (
      wrapped as unknown as {
        createBackgroundTokenizer(model: { getLineCount(): number }): { requestTokens(): void } | undefined;
      }
    ).createBackgroundTokenizer;
    const background = create({ getLineCount: () => VIEWPORT_HIGHLIGHT_LINE_COUNT });
    expect(background).toBeDefined();
    background?.requestTokens();
    expect(wrapped.tokenize("token")).toBe(5);
    expect(wrapped.getInitialState()).toBe("start");
  });
});

describe("installViewportTokenization", () => {
  it("包一层就停，注册回调不会套第二层", () => {
    const registry = registryWith("typescript", { getInitialState: () => "start" });
    installViewportTokenization(registry, ["typescript"]);
    const wrapped = registry.get("typescript");
    expect(wrapped).not.toBeNull();
    expect(isViewportTokenization(wrapped!)).toBe(true);
    expect(isViewportTokenization(viewportTokenizationSupport(wrapped!))).toBe(true);
  });
});
