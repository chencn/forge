/** Monaco 内部的词法注册表。和编辑器加载的是同一份单例，公开 API 没有这一项。 */
declare module "monaco-editor/editor/common/languages.js" {
  export const TokenizationRegistry: {
    get(languageId: string): object | null;
    register(languageId: string, support: object): { dispose(): void };
    onDidChange(
      listener: (event: { changedLanguages: string[]; changedColorMap?: boolean }) => void
    ): { dispose(): void };
  };
}

declare module "monaco-editor/platform/configuration/common/configuration.js" {
  export const IConfigurationService: unknown;
}

declare module "monaco-editor/editor/standalone/browser/standaloneServices.js" {
  export const StandaloneServices: {
    get(id: unknown): unknown;
  };
  export function updateConfigurationService(
    configurationService: unknown,
    source: { largeFileOptimizations?: boolean },
    isDiffEditor: boolean
  ): void;
}
