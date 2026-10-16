/**
 * 大文件的高亮只跟屏幕走。
 *
 * Monaco 自己会先给可见行上色，接着在空闲时从第 1 行扫到最后一行，把每行的词法状态都留下。
 * 行数一多，这份状态比正文还沉，而它的「大文件优化」是直接停掉高亮。
 * 这里换成：不到阈值仍整篇扫完；到了阈值就只留可见行的颜色，滚到哪补到哪。颜色一直在。
 */

/** 不到这个行数，空闲时仍把整篇词法状态算完。到了就只给可见行上色。 */
export const VIEWPORT_HIGHLIGHT_LINE_COUNT = 20_000;

const MARK: unique symbol = Symbol("viewportTokenization");

interface LineCountModel {
  getLineCount(): number;
}

interface BackgroundTokenizer {
  dispose(): void;
  requestTokens(startLineNumber: number, endLineNumberExclusive: number): void;
}

export interface TokenizationRegistryLike {
  get(languageId: string): object | null;
  register(languageId: string, support: object): { dispose(): void };
  onDidChange(
    listener: (event: { changedLanguages: string[]; changedColorMap?: boolean }) => void
  ): { dispose(): void };
}

export function isViewportTokenization(support: object): boolean {
  return MARK in support;
}

/**
 * 包一层词法支持。小文件交回 Monaco 自己的整篇扫描；大文件的后台扫描是空的，
 * 可见行仍由 Monaco 在滚动时当场上色。
 */
export function viewportTokenizationSupport<T extends object>(support: T): T {
  if (isViewportTokenization(support)) return support;
  return new Proxy(support, {
    has(target, key) {
      if (key === MARK) return true;
      return Reflect.has(target, key);
    },
    get(target, key, receiver) {
      if (key === MARK) return true;
      if (key === "backgroundTokenizerShouldOnlyVerifyTokens") return false;
      if (key === "createBackgroundTokenizer") {
        return (model: LineCountModel): BackgroundTokenizer | undefined => {
          if (model.getLineCount() < VIEWPORT_HIGHLIGHT_LINE_COUNT) return undefined;
          return {
            dispose() {},
            requestTokens() {},
          };
        };
      }
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 已经注册的语言包一层，之后新注册的也包。重复调用同一份支持不会套第二层。 */
export function installViewportTokenization(
  registry: TokenizationRegistryLike,
  languageIds: readonly string[]
): void {
  const apply = (languageId: string) => {
    const current = registry.get(languageId);
    if (!current || isViewportTokenization(current)) return;
    registry.register(languageId, viewportTokenizationSupport(current));
  };
  registry.onDidChange((event) => {
    for (const languageId of event.changedLanguages) apply(languageId);
  });
  for (const languageId of languageIds) apply(languageId);
}
