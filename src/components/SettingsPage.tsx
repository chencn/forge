import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import PromptDialog from "./PromptDialog";
import AiActionDialog from "./AiActionDialog";
import AiCommitSettingsPanel from "./AiCommitSettingsPanel";
import AiCliSettingsPanel, { AiCliSettingsControls } from "./AiCliSettingsPanel";
import AiArchivedSessionsPanel from "./AiArchivedSessionsPanel";
import ModelProvidersPanel from "./ModelProvidersPanel";
import SkillsPanel from "./SkillsPanel";
import McpPanel from "./McpPanel";
import HooksSettingsPanel from "./HooksSettingsPanel";
import ShortcutSettingsPanel from "./ShortcutSettingsPanel";
import { useSettings } from "../hooks/useSettings";
import { hasUnsavedSettings } from "../hooks/useUnsavedGuard";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";
import { DEFAULT_SETTINGS } from "../lib/settings";
import {
  AppearanceSystemPage,
  AppearanceThemePage,
} from "../features/settings/pages/AppearancePages";
import {
  EditorCodeStylePage,
  EditorFileTypesPage,
  EditorFontPage,
  EditorGeneralPage,
  EditorMinimapPage,
} from "../features/settings/pages/EditorPages";
import {
  VcsChangesPage,
  VcsCommitChecksPage,
  VcsCommitPage,
  VcsCommitWarningsPage,
  VcsConfirmationPage,
  VcsGitPage,
  VcsMessageInspectionsPage,
  VcsPushPage,
  VcsUpdatePage,
} from "../features/settings/pages/VcsPages";
import { ToolAboutPage, ToolTerminalPage } from "../features/settings/pages/ToolPages";

/** 设置窗口左侧的模块，一行一个。依赖会话总开关的 AI 页只在开启后出现。 */
export type SettingsModule =
  | "general"
  | "editor"
  | "shortcuts"
  | "terminal"
  | "git"
  | "aiCommit"
  | "aiCli"
  | "aiArchived"
  | "modelProviders"
  | "skills"
  | "mcp"
  | "hooks"
  | "about";

/** 设置页模块的展示顺序。 */
const MODULES: SettingsModule[] = [
  "general",
  "editor",
  "shortcuts",
  "terminal",
  "git",
  "aiCommit",
  "aiCli",
  "aiArchived",
  "modelProviders",
  "skills",
  "mcp",
  "hooks",
  "about",
];

/** 各模块侧栏标题的 i18n 键。 */
const MODULE_LABEL: Record<SettingsModule, TranslationKey> = {
  general: "settings.general",
  editor: "settings.editor",
  shortcuts: "settings.shortcuts",
  terminal: "settings.terminal",
  git: "settings.git",
  aiCommit: "settings.aiCommit",
  aiCli: "ai.title",
  aiArchived: "settings.aiArchived",
  modelProviders: "settings.modelProviders",
  skills: "settings.skills",
  mcp: "settings.mcp",
  hooks: "settings.hooks",
  about: "settings.about",
};

/**
 * 受 AI 总开关门控的模块：这些页面展示或操作 AI 会话本身，关掉总开关就没有内容可看。
 *
 * 「模型供应商」不在此列——它只是端点与密钥的登记处，AI 提交这条链路不经过会话总开关，
 * 关掉开关的人照样得能进去配供应商。
 */
const AI_MODULES = new Set<SettingsModule>([
  "aiCli",
  "aiArchived",
  "skills",
  "mcp",
  "hooks",
]);

/**
 * 按 AI 总开关算出导航要渲染的模块。
 *
 * @param aiAssistantsEnabled - 应用级 AI 总开关
 * @returns 展示顺序下的模块清单；关闭时只摘掉依赖会话的 AI 页，模型供应商保留
 */
export function visibleSettingsModules(aiAssistantsEnabled: boolean): SettingsModule[] {
  return aiAssistantsEnabled ? MODULES : MODULES.filter((key) => !AI_MODULES.has(key));
}

/** {@link SettingsPage} 的入参。 */
interface Props {
  /** 当前项目根；「版本控制」页探测 git 与归档会话面板都要用。 */
  workspace: string | null;
  /** 初始或外部要求激活的模块。 */
  initialModule?: SettingsModule;
}

/** 一个模块内的分节：标题 + 对应页面组件，按约定堆在一屏里滚到底。 */
interface Section {
  title: TranslationKey;
  content: ReactNode;
}

/** 设置页：左侧模块导航 + 右侧模块内容。 */
export default function SettingsPage({ workspace, initialModule }: Props) {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const [module, setModule] = useState<SettingsModule>(() =>
    initialModule && (settings.aiAssistantsEnabled || !AI_MODULES.has(initialModule)) ? initialModule : "general",
  );
  /** 「重置所有设置」的二次确认框；确认后才把通用项写回默认值。 */
  const [confirmReset, setConfirmReset] = useState(false);
  /** AI 各页有未保存草稿时，先记下想跳去的模块，等确认框决定去不去。 */
  const [pendingModule, setPendingModule] = useState<SettingsModule | null>(null);

  const visibleModules = visibleSettingsModules(settings.aiAssistantsEnabled);

  // 面板卸载就会丢掉草稿，所以离开前问一句；目标就是当前页时不用管。
  const navigate = (next: SettingsModule) => {
    if (next !== module && hasUnsavedSettings()) setPendingModule(next);
    else setModule(next);
  };

  useEffect(() => {
    if (initialModule) {
      setModule(!settings.aiAssistantsEnabled && AI_MODULES.has(initialModule) ? "general" : initialModule);
    }
  }, [initialModule, settings.aiAssistantsEnabled]);

  useEffect(() => {
    // 重置设置或其他窗口关闭总开关时，不能继续停在已经从导航中移除的页面。
    if (!settings.aiAssistantsEnabled && AI_MODULES.has(module)) setModule("general");
  }, [module, settings.aiAssistantsEnabled]);

  const sections = (): Section[] => {
    switch (module) {
      case "general":
        return [
          { title: "settings.section.theme", content: <AppearanceThemePage /> },
          { title: "settings.section.system", content: <AppearanceSystemPage /> },
        ];
      case "editor":
        return [
          { title: "settings.section.editorGeneral", content: <EditorGeneralPage /> },
          { title: "settings.section.font", content: <EditorFontPage /> },
          { title: "settings.section.codeStyle", content: <EditorCodeStylePage /> },
          { title: "settings.section.fileTypes", content: <EditorFileTypesPage /> },
          { title: "settings.section.minimap", content: <EditorMinimapPage /> },
        ];
      case "git":
        return [
          { title: "settings.section.commit", content: <VcsCommitPage /> },
          { title: "vcs.messageInspections", content: <VcsMessageInspectionsPage /> },
          { title: "vcs.commitChecksTitle", content: <VcsCommitChecksPage /> },
          { title: "settings.section.gitExecutable", content: <VcsGitPage workspace={workspace} /> },
          { title: "vcs.commitWarnings", content: <VcsCommitWarningsPage /> },
          { title: "vcs.pushSettings", content: <VcsPushPage /> },
          { title: "vcs.updateTitle", content: <VcsUpdatePage /> },
          { title: "settings.section.confirmations", content: <VcsConfirmationPage /> },
          { title: "vcs.changesTitle", content: <VcsChangesPage /> },
        ];
      default:
        return [];
    }
  };

  const moduleSections = sections();

  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label={t("settings.title")}>
        <p className="settings-nav-title">{t("settings.title")}</p>
        {visibleModules.map((key) => (
          <button
            key={key}
            type="button"
            className={`settings-nav-item${module === key ? " is-active" : ""}`}
            onClick={() => navigate(key)}
          >
            {t(MODULE_LABEL[key])}
          </button>
        ))}
      </nav>

      <div className="settings-body">
        <header className="settings-head">
          <span className="settings-head-title">{t(MODULE_LABEL[module])}</span>
          <span className="settings-head-spacer" />
          {/* AI 页这里只保留 CLI 检测；应用级总开关归到「通用」。 */}
          {module === "aiCli" ? <AiCliSettingsControls /> : null}
          {/* 把「恢复默认值」放在通用页标题行右端；点开先过一遍确认框。 */}
          {module === "general" ? (
            <button
              type="button"
              className="icon-button settings-reset"
              title={t("settings.resetAll")}
              aria-label={t("settings.resetAll")}
              onClick={() => setConfirmReset(true)}
            >
              <RotateCcw size={14} />
            </button>
          ) : null}
        </header>

        {moduleSections.length > 0 ? (
          <div className="settings-stack">
            {moduleSections.map((section) => (
              <section
                key={section.title}
                className={
                  module === "git" ? "settings-section is-vcs"
                  : module === "general" ? "settings-section is-general"
                  : module === "editor" ? "settings-section is-editor"
                  : undefined
                }
              >
                <h3 className="settings-section-title">{t(section.title)}</h3>
                {section.content}
              </section>
            ))}
          </div>
        ) : module === "shortcuts" ? (
          <ShortcutSettingsPanel />
        ) : module === "terminal" ? (
          <ToolTerminalPage />
        ) : module === "aiCommit" ? (
          <AiCommitSettingsPanel onOpenProviders={() => navigate("modelProviders")} />
        ) : module === "aiCli" ? (
          <AiCliSettingsPanel />
        ) : module === "aiArchived" ? (
          <AiArchivedSessionsPanel workspace={workspace} />
        ) : module === "modelProviders" ? (
          <ModelProvidersPanel />
        ) : module === "skills" ? (
          <SkillsPanel />
        ) : module === "mcp" ? (
          <McpPanel />
        ) : module === "hooks" ? (
          <HooksSettingsPanel />
        ) : (
          <ToolAboutPage />
        )}
      </div>

      {confirmReset ? (
        <PromptDialog
          request={{ kind: "resetSettings", name: "" }}
          onSubmit={() => {
            setConfirmReset(false);
            // 只把通用页这几项恢复默认；编辑器、终端等其它页与最近使用记录都不动。
            patch({
              theme: DEFAULT_SETTINGS.theme,
              language: DEFAULT_SETTINGS.language,
              workspaceMode: DEFAULT_SETTINGS.workspaceMode,
              httpResponse: DEFAULT_SETTINGS.httpResponse,
              httpHistoryRetentionDays: DEFAULT_SETTINGS.httpHistoryRetentionDays,
              closeBehavior: DEFAULT_SETTINGS.closeBehavior,
              explorer: { ...DEFAULT_SETTINGS.explorer },
              shell: { ...DEFAULT_SETTINGS.shell },
            });
          }}
          onCancel={() => setConfirmReset(false)}
        />
      ) : null}

      {pendingModule ? (
        <AiActionDialog
          title={t("settings.unsavedTitle")}
          confirm={t("settings.unsavedConfirm")}
          danger
          onCancel={() => setPendingModule(null)}
          onConfirm={() => {
            const next = pendingModule;
            setPendingModule(null);
            setModule(next);
          }}
        >
          <p className="dialog-body">{t("settings.unsavedHint")}</p>
        </AiActionDialog>
      ) : null}
    </div>
  );
}
