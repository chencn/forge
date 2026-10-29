import { useSettings } from "../../../hooks/useSettings";
import { useI18n, type Lang } from "../../../i18n";
import Select from "../../../components/Select";
import { requestNativeNotificationPermission } from "../../../lib/notifications";
import type {
  CloseBehavior,
  HttpResponseLayout,
  NotificationGroupRule,
  NotificationPopupType,
  NotificationPosition,
  WorkspaceMode,
} from "../../../lib/settings";
import type { ThemeMode } from "../../../lib/window";
import {
  applyThemeAttributes,
  type BuiltinThemeId,
} from "../../../themes/themeManager";

const THEME_OPTIONS: ThemeMode[] = [
  "system",
  "dark",
  "light",
  "dark-hc",
];

const THEME_LABEL: Record<ThemeMode, string> = {
  system: "跟随系统 (Auto)",
  dark: "Islands Dark (暗色)",
  light: "Islands Light (浅色)",
  "dark-hc": "High Contrast (高对比度)",
};

const LANG_OPTIONS: { value: Lang; label: string }[] = [
  { value: "zh", label: "简体中文" },
  { value: "en", label: "English" },
  { value: "zh-TW", label: "繁體中文" },
];

const CLOSE_BEHAVIORS: CloseBehavior[] = ["quit", "tray"];
const CLOSE_LABEL: Record<CloseBehavior, "closeBehavior.quit" | "closeBehavior.tray"> = {
  quit: "closeBehavior.quit",
  tray: "closeBehavior.tray",
};

const WORKSPACE_MODES: WorkspaceMode[] = ["single", "multi"];
const WORKSPACE_MODE_LABEL: Record<WorkspaceMode, "workspaceMode.single" | "workspaceMode.multi"> = {
  single: "workspaceMode.single",
  multi: "workspaceMode.multi",
};

const HTTP_LAYOUTS: HttpResponseLayout[] = ["split", "tab"];
const HTTP_LAYOUT_LABEL: Record<HttpResponseLayout, "httpResponse.split" | "httpResponse.tab"> = {
  split: "httpResponse.split",
  tab: "httpResponse.tab",
};

const NOTIFICATION_POSITION_OPTIONS: NotificationPosition[] = [
  "bottom-right",
  "top-right",
  "bottom-left",
  "top-left",
];

const NOTIFICATION_POSITION_LABEL: Record<
  NotificationPosition,
  | "notificationPosition.bottomRight"
  | "notificationPosition.topRight"
  | "notificationPosition.bottomLeft"
  | "notificationPosition.topLeft"
> = {
  "bottom-right": "notificationPosition.bottomRight",
  "top-right": "notificationPosition.topRight",
  "bottom-left": "notificationPosition.bottomLeft",
  "top-left": "notificationPosition.topLeft",
};

/**
 * 外观设置页
 */
export function AppearanceThemePage() {
  const { lang, setLang } = useI18n();
  const { settings, patch } = useSettings();

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">主题方案 (Theme)</span>
          <Select
            label="主题方案"
            placeholder="—"
            value={settings.theme}
            options={THEME_OPTIONS.map((theme) => ({
              value: theme,
              label: THEME_LABEL[theme] || theme,
            }))}
            onChange={(theme) => {
              patch({ theme });
              if (theme !== "system") {
                applyThemeAttributes(theme as BuiltinThemeId);
              } else {
                const isDark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
                applyThemeAttributes(isDark ? "dark" : "light");
              }
            }}
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">界面语言 (Language)</span>
          <Select
            label="界面语言"
            placeholder="—"
            value={lang}
            options={LANG_OPTIONS}
            onChange={setLang}
          />
        </div>

        <p className="settings-hint">
          Forge 内置精选暗色 (Islands Dark)、浅色 (Islands Light) 与高对比度无障碍模式，支持随操作系统外观自动同步切换。
        </p>
      </div>
    </div>
  );
}

export const AppearanceGeneralPage = AppearanceThemePage;

/**
 * 系统设置页
 */
export function AppearanceSystemPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">{t("settings.workspaceMode")}</span>
          <Select
            label={t("settings.workspaceMode")}
            placeholder="—"
            value={settings.workspaceMode}
            options={WORKSPACE_MODES.map((option) => ({
              value: option,
              label: t(WORKSPACE_MODE_LABEL[option]),
            }))}
            onChange={(workspaceMode) => patch({ workspaceMode })}
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">{t("settings.closeBehavior")}</span>
          <Select
            label={t("settings.closeBehavior")}
            placeholder="—"
            value={settings.closeBehavior}
            options={CLOSE_BEHAVIORS.map((option) => ({
              value: option,
              label: t(CLOSE_LABEL[option]),
            }))}
            onChange={(closeBehavior) => patch({ closeBehavior })}
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">{t("settings.httpResponse")}</span>
          <Select
            label={t("settings.httpResponse")}
            placeholder="—"
            value={settings.httpResponse}
            options={HTTP_LAYOUTS.map((option) => ({
              value: option,
              label: t(HTTP_LAYOUT_LABEL[option]),
            }))}
            onChange={(httpResponse) => patch({ httpResponse })}
          />
        </div>
      </div>
    </div>
  );
}

const NOTIFICATION_POPUP_OPTIONS: { value: NotificationPopupType; label: string }[] = [
  { value: "balloon", label: "气泡 (Balloon)" },
  { value: "sticky", label: "常驻气泡 (Sticky)" },
  { value: "none", label: "无气泡 (No popup)" },
];

const NOTIFICATION_GROUP_LABELS: Record<string, string> = {
  git: "Git 版本控制 (VCS)",
  maven: "Maven 构建与依赖",
  build: "运行与编译 (Run & Build)",
  lsp: "代码分析与语言服务 (LSP)",
  ai: "AI 助手会话与操作",
  dependencies: "项目依赖同步 (Dependencies)",
  terminal: "终端与会话 (Terminal)",
  system: "系统与应用更新 (System)",
};

/**
 * 1:1 对标 openidea / IntelliJ IDEA 的通知设置页
 */
export function AppearanceNotificationsPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();

  const handleGroupRuleChange = (
    groupId: string,
    field: keyof NotificationGroupRule,
    val: unknown
  ) => {
    const current = settings.notificationGroups[groupId] ?? {
      displayType: "balloon",
      log: true,
      system: false,
    };
    patch({
      notificationGroups: {
        ...settings.notificationGroups,
        [groupId]: { ...current, [field]: val },
      },
    });
  };

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        {/* 1. 全局停靠位置 */}
        <div className="settings-row">
          <span className="settings-label">{t("settings.notificationPosition")}</span>
          <Select
            label={t("settings.notificationPosition")}
            placeholder="—"
            value={settings.notificationPosition}
            options={NOTIFICATION_POSITION_OPTIONS.map((pos) => ({
              value: pos,
              label: t(NOTIFICATION_POSITION_LABEL[pos]),
            }))}
            onChange={(notificationPosition) => patch({ notificationPosition })}
          />
        </div>
        <p className="settings-hint">
          全局弹窗与重要事件提示的出现停靠角落。
        </p>

        {/* 2. 勿扰模式开关 */}
        <div className="settings-row" style={{ marginTop: 16 }}>
          <span className="settings-label">勿扰模式 (Do Not Disturb)</span>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={settings.notificationDoNotDisturb}
              onChange={(e) => patch({ notificationDoNotDisturb: e.target.checked })}
            />
            静默所有浮动气泡，仅静默记录到通知工具窗口
          </label>
        </div>

        {/* 3. 通知组独立配置表格 */}
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            通知组与弹出行为 (Notification Groups)
          </div>
          <p className="settings-hint" style={{ marginBottom: 12 }}>
            针对各子系统独立配置气泡弹出模式（自动淡出 / 常驻不消失 / 不弹气泡）、是否记入历史日志或发送操作系统通知。
          </p>

          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 12,
              background: "var(--color-bg-base)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <thead>
              <tr style={{ background: "var(--color-bg-hover)", borderBottom: "1px solid var(--color-border-subtle)", textAlign: "left" }}>
                <th style={{ padding: "8px 12px", fontWeight: 600 }}>功能组</th>
                <th style={{ padding: "8px 12px", fontWeight: 600, width: 170 }}>弹出形态 (Popup)</th>
                <th style={{ padding: "8px 12px", fontWeight: 600, width: 80, textAlign: "center" }}>记入日志</th>
                <th style={{ padding: "8px 12px", fontWeight: 600, width: 80, textAlign: "center" }}>系统通知</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(NOTIFICATION_GROUP_LABELS).map((groupId) => {
                const rule = settings.notificationGroups[groupId] ?? {
                  displayType: "balloon",
                  log: true,
                  system: false,
                };
                return (
                  <tr
                    key={groupId}
                    style={{
                      borderBottom: "1px solid var(--color-border-subtle)",
                    }}
                  >
                    <td style={{ padding: "8px 12px" }}>
                      {NOTIFICATION_GROUP_LABELS[groupId] ?? groupId}
                    </td>
                    <td style={{ padding: "6px 12px" }}>
                      <select
                        value={rule.displayType}
                        style={{
                          width: "100%",
                          padding: "4px 8px",
                          borderRadius: 3,
                          background: "var(--color-bg-input)",
                          color: "var(--color-text-main)",
                          border: "1px solid var(--color-border-subtle)",
                          fontSize: 12,
                        }}
                        onChange={(e) =>
                          handleGroupRuleChange(
                            groupId,
                            "displayType",
                            e.target.value as NotificationPopupType
                          )
                        }
                      >
                        {NOTIFICATION_POPUP_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ padding: "6px 12px", textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={rule.log}
                        onChange={(e) =>
                          handleGroupRuleChange(groupId, "log", e.target.checked)
                        }
                      />
                    </td>
                    <td style={{ padding: "6px 12px", textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={rule.system}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          if (checked) {
                            void requestNativeNotificationPermission();
                          }
                          handleGroupRuleChange(groupId, "system", checked);
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
