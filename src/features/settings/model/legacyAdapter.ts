/**
 * 兼容原有 SettingsModule 与新版 PageId 的适配器
 */
export type LegacySettingsModule =
  | "general"
  | "editor"
  | "shortcuts"
  | "terminal"
  | "lsp"
  | "aiCommit"
  | "aiCli"
  | "aiArchived"
  | "modelProviders"
  | "skills"
  | "mcp"
  | "hooks"
  | "about";

/** 旧模块 ID -> 新页面 PageId 映射表 */
const LEGACY_TO_NEW: Record<LegacySettingsModule, string> = {
  general: "appearance.theme",
  editor: "editor.general",
  shortcuts: "keymap",
  terminal: "tools.terminal",
  lsp: "languages.lsp",
  aiCommit: "tools.ai.commit",
  aiCli: "tools.ai.cli",
  aiArchived: "tools.ai.archived",
  modelProviders: "tools.ai.providers",
  skills: "tools.ai.skills",
  mcp: "tools.ai.mcp",
  hooks: "tools.ai.hooks",
  about: "tools.about",
};

/** 新页面 PageId -> 旧模块 ID 反向映射（用于部分依赖旧 ID 的钩子） */
const NEW_TO_LEGACY: Record<string, LegacySettingsModule> = {
  "appearance.general": "general",
  "appearance.system": "general",
  "appearance.notifications": "general",
  keymap: "shortcuts",
  "editor.general": "editor",
  "editor.font": "editor",
  "editor.colorScheme": "editor",
  "editor.codeStyle": "editor",
  "editor.fileTypes": "editor",
  "editor.minimap": "editor",
  "languages.lsp": "lsp",
  "tools.ai.cli": "aiCli",
  "tools.ai.providers": "modelProviders",
  "tools.ai.commit": "aiCommit",
  "tools.ai.skills": "skills",
  "tools.ai.mcp": "mcp",
  "tools.ai.hooks": "hooks",
  "tools.ai.archived": "aiArchived",
  "tools.terminal": "terminal",
  "tools.about": "about",
};

export function resolvePageId(moduleOrPageId: string | undefined): string {
  if (!moduleOrPageId) return "appearance.general";
  if (moduleOrPageId in LEGACY_TO_NEW) {
    return LEGACY_TO_NEW[moduleOrPageId as LegacySettingsModule];
  }
  return moduleOrPageId;
}

export function toLegacyModule(pageId: string): LegacySettingsModule {
  return NEW_TO_LEGACY[pageId] ?? "general";
}
