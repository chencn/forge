import { useState, useEffect } from "react";
import { useI18n } from "../i18n";
import { hasUnsavedSettings } from "../hooks/useUnsavedGuard";
import type { WakeResult } from "../lib/lspClient";
import AiActionDialog from "./AiActionDialog";
import ShortcutSettingsPanel from "./ShortcutSettingsPanel";
import SettingsLayout from "../features/settings/components/SettingsLayout";
import { resolvePageId } from "../features/settings/model/legacyAdapter";
import {
  AppearanceNotificationsPage,
  AppearanceSystemPage,
  AppearanceThemePage,
} from "../features/settings/pages/AppearancePages";
import {
  EditorCodeStylePage,
  EditorColorSchemePage,
  EditorFileTypesPage,
  EditorFontPage,
  EditorGeneralPage,
  EditorMinimapPage,
} from "../features/settings/pages/EditorPages";
import {
  VcsConfirmationPage,
  VcsGeneralPage,
  VcsGitPage,
} from "../features/settings/pages/VcsPages";
import {
  ProjectRootsPage,
  ProjectSdkPage,
} from "../features/settings/pages/ProjectPages";
import {
  BuildDeploymentPage,
  BuildRunConfigsPage,
  BuildToolsPage,
} from "../features/settings/pages/BuildPages";
import {
  LanguageLspPage,
  LanguageSchemasPage,
} from "../features/settings/pages/LanguagePages";
import {
  ToolAboutPage,
  ToolAiArchivedSessionsPage,
  ToolAiCliPage,
  ToolAiCommitPage,
  ToolAiHooksPage,
  ToolAiMcpPage,
  ToolAiProvidersPage,
  ToolAiSkillsPage,
  ToolDiffPage,
  ToolTerminalPage,
} from "../features/settings/pages/ToolPages";

/** 设置窗口左侧的模块枚举，保留向后兼容 */
export type SettingsModule =
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

interface Props {
  /** 当前项目根；未打开项目时没有可启动的会话，「启动」按钮禁用。 */
  workspace: string | null;
  /** 变更进程之后需要重新执行一次文档与配置的对档。 */
  onLspKick?: () => void;
  /** 让指定 server 立即在项目中启动；返回未能启动的原因。 */
  onLspWake?: (serverId: string) => Promise<WakeResult>;
  /** 初始或外部要求激活的模块。 */
  initialModule?: SettingsModule;
  /** 关闭设置窗口回调。 */
  onClose?: () => void;
}

export default function SettingsPage({
  workspace,
  onLspKick,
  onLspWake,
  initialModule,
  onClose,
}: Props) {
  const { t } = useI18n();

  const [selectedPageId, setSelectedPageId] = useState<string>(() =>
    resolvePageId(initialModule || "general")
  );
  const [pendingPageId, setPendingPageId] = useState<string | null>(null);

  useEffect(() => {
    if (initialModule) {
      setSelectedPageId(resolvePageId(initialModule));
    }
  }, [initialModule]);

  // 当外部导航切换时，如有未保存草稿弹出拦截确认框
  const handleSelectPage = (nextId: string) => {
    if (nextId !== selectedPageId && hasUnsavedSettings()) {
      setPendingPageId(nextId);
    } else {
      setSelectedPageId(nextId);
    }
  };

  /** 根据当前选中的页面 ID 渲染对应的子页面 */
  const renderContent = () => {
    switch (selectedPageId) {
      // 1. 外观与行为
      case "appearance":
      case "appearance.theme":
        return <AppearanceThemePage />;
      case "appearance.system":
        return <AppearanceSystemPage />;
      case "appearance.notifications":
        return <AppearanceNotificationsPage />;

      // 2. 按键映射
      case "keymap":
        return <ShortcutSettingsPanel />;

      // 3. 编辑器
      case "editor":
      case "editor.general":
        return <EditorGeneralPage />;
      case "editor.font":
        return <EditorFontPage />;
      case "editor.colorScheme":
        return <EditorColorSchemePage />;
      case "editor.codeStyle":
        return <EditorCodeStylePage />;
      case "editor.fileTypes":
        return <EditorFileTypesPage />;
      case "editor.minimap":
        return <EditorMinimapPage />;

      // 4. 版本控制
      case "vcs":
      case "vcs.general":
        return <VcsGeneralPage />;
      case "vcs.git":
        return <VcsGitPage />;
      case "vcs.confirmation":
        return <VcsConfirmationPage />;

      // 5. 项目结构
      case "project":
      case "project.sdk":
        return <ProjectSdkPage workspace={workspace} />;
      case "project.roots":
        return <ProjectRootsPage workspace={workspace} />;

      // 6. 构建、执行、部署
      case "build":
      case "build.tools":
        return <BuildToolsPage />;
      case "build.runConfigs":
        return <BuildRunConfigsPage />;
      case "build.deployment":
        return <BuildDeploymentPage />;

      // 7. 语言与框架
      case "languages":
      case "languages.lsp":
        return (
          <LanguageLspPage
            workspace={workspace}
            onLspKick={onLspKick}
            onLspWake={onLspWake}
          />
        );
      case "languages.schemas":
        return <LanguageSchemasPage />;

      // 8. 工具
      case "tools":
      case "tools.terminal":
        return <ToolTerminalPage />;
      case "tools.diff":
        return <ToolDiffPage />;
      case "tools.ai":
      case "tools.ai.cli":
        return <ToolAiCliPage />;
      case "tools.ai.providers":
        return <ToolAiProvidersPage />;
      case "tools.ai.commit":
        return <ToolAiCommitPage />;
      case "tools.ai.skills":
        return <ToolAiSkillsPage />;
      case "tools.ai.mcp":
        return <ToolAiMcpPage />;
      case "tools.ai.hooks":
        return <ToolAiHooksPage />;
      case "tools.ai.archived":
        return <ToolAiArchivedSessionsPage workspace={workspace} />;
      case "tools.about":
        return <ToolAboutPage />;

      default:
        return <AppearanceThemePage />;
    }
  };

  return (
    <div style={{ height: "100%", width: "100%", overflow: "hidden" }}>
      <SettingsLayout
        activePageId={selectedPageId}
        onSelectPage={handleSelectPage}
        onClose={onClose}
        onApply={() => {
          // 当前设置项均已实时自动 patch 并保存至本地 store
        }}
      >
        {renderContent()}
      </SettingsLayout>

      {pendingPageId ? (
        <AiActionDialog
          title={t("settings.unsavedTitle")}
          confirm={t("settings.unsavedConfirm")}
          danger
          onCancel={() => setPendingPageId(null)}
          onConfirm={() => {
            const next = pendingPageId;
            setPendingPageId(null);
            setSelectedPageId(next);
          }}
        >
          <p className="dialog-body">{t("settings.unsavedHint")}</p>
        </AiActionDialog>
      ) : null}
    </div>
  );
}
