import { useState, useEffect } from "react";
import { useSettings } from "../../../hooks/useSettings";
import { useI18n } from "../../../i18n";
import Select from "../../../components/Select";
import {
  DEFAULT_SETTINGS,
  TERMINAL_BELLS,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_SIZE_RANGE,
  TERMINAL_SCROLLBACK_RANGE,
  TERMINAL_TAB_LAYOUTS,
  type TerminalBell,
  type TerminalCursorStyle,
  type TerminalTabLayout,
} from "../../../lib/settings";
import { shellProbe, type ShellInfo } from "../../../lib/term";
import TerminalProfilesEditor from "../../../components/TerminalProfilesEditor";
import AiCliSettingsPanel from "../../../components/AiCliSettingsPanel";
import ModelProvidersPanel from "../../../components/ModelProvidersPanel";
import AiCommitSettingsPanel from "../../../components/AiCommitSettingsPanel";
import SkillsPanel from "../../../components/SkillsPanel";
import McpPanel from "../../../components/McpPanel";
import HooksSettingsPanel from "../../../components/HooksSettingsPanel";
import AiArchivedSessionsPanel from "../../../components/AiArchivedSessionsPanel";
import {
  checkForUpdate,
  currentVersion,
  type UpdateInfo,
} from "../../../lib/updater";

const CURSOR_STYLE_LABEL: Record<TerminalCursorStyle, "settings.terminalCursor.bar" | "settings.terminalCursor.block" | "settings.terminalCursor.underline"> = {
  bar: "settings.terminalCursor.bar",
  block: "settings.terminalCursor.block",
  underline: "settings.terminalCursor.underline",
};

const TAB_LAYOUT_LABEL: Record<TerminalTabLayout, "settings.terminalTabLayout.horizontal" | "settings.terminalTabLayout.vertical"> = {
  horizontal: "settings.terminalTabLayout.horizontal",
  vertical: "settings.terminalTabLayout.vertical",
};

const BELL_LABEL: Record<TerminalBell, "settings.terminalBell.visual" | "settings.terminalBell.sound" | "settings.terminalBell.none"> = {
  visual: "settings.terminalBell.visual",
  sound: "settings.terminalBell.sound",
  none: "settings.terminalBell.none",
};

const SWITCHES = ["yes", "no"] as const;
const SWITCH_LABEL: Record<"yes" | "no", "common.yes" | "common.no"> = {
  yes: "common.yes",
  no: "common.no",
};

/** 终端设置页面 */
export function ToolTerminalPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const [shells, setShells] = useState<ShellInfo[]>([]);

  useEffect(() => {
    let canceled = false;
    void shellProbe().then((probed) => {
      if (!canceled) setShells(probed);
    });
    return () => {
      canceled = true;
    };
  }, []);

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">{t("settings.shell")}</span>
          <Select
            className="is-wide"
            label={t("settings.shell")}
            placeholder="—"
            value={
              shells.find(
                (shell) =>
                  shell.id === settings.terminal.shell ||
                  shell.path === settings.terminal.shell,
              )?.id ?? (settings.terminal.shell || shells[0]?.id || "")
            }
            options={shells.map((shell) => ({
              value: shell.id,
              label: shell.name,
              detail: [shell.path, ...shell.args].join(" "),
            }))}
            onChange={(shell) => patch({ terminal: { ...settings.terminal, shell } })}
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">{t("settings.terminalFontSize")}</span>
          <input
            className="settings-input"
            type="number"
            min={TERMINAL_FONT_SIZE_RANGE.min}
            max={TERMINAL_FONT_SIZE_RANGE.max}
            value={settings.terminal.fontSize}
            onChange={(event) =>
              patch({
                terminal: {
                  ...settings.terminal,
                  fontSize: Math.min(
                    TERMINAL_FONT_SIZE_RANGE.max,
                    Math.max(
                      TERMINAL_FONT_SIZE_RANGE.min,
                      Number(event.target.value) || DEFAULT_SETTINGS.terminal.fontSize,
                    ),
                  ),
                },
              })
            }
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">{t("settings.terminalFontFamily")}</span>
          <input
            key={settings.terminal.fontFamily}
            className="settings-input is-wide"
            defaultValue={settings.terminal.fontFamily}
            placeholder={t("settings.terminalFontFamilyPlaceholder")}
            onBlur={(event) => {
              const fontFamily = event.target.value.trim();
              if (fontFamily !== settings.terminal.fontFamily) {
                patch({ terminal: { ...settings.terminal, fontFamily } });
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">{t("settings.terminalScrollback")}</span>
          <input
            key={settings.terminal.scrollback}
            className="settings-input"
            type="number"
            min={TERMINAL_SCROLLBACK_RANGE.min}
            max={TERMINAL_SCROLLBACK_RANGE.max}
            step={1000}
            defaultValue={settings.terminal.scrollback}
            onBlur={(event) => {
              const scrollback = Math.min(
                TERMINAL_SCROLLBACK_RANGE.max,
                Math.max(
                  TERMINAL_SCROLLBACK_RANGE.min,
                  Math.round(Number(event.target.value) || DEFAULT_SETTINGS.terminal.scrollback),
                ),
              );
              if (scrollback !== settings.terminal.scrollback) {
                patch({ terminal: { ...settings.terminal, scrollback } });
              } else {
                event.target.value = String(scrollback);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">{t("settings.terminalCursor")}</span>
          <Select
            label={t("settings.terminalCursor")}
            placeholder="—"
            value={settings.terminal.cursorStyle}
            options={TERMINAL_CURSOR_STYLES.map((style) => ({
              value: style,
              label: t(CURSOR_STYLE_LABEL[style]),
            }))}
            onChange={(cursorStyle) =>
              patch({ terminal: { ...settings.terminal, cursorStyle } })
            }
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">{t("settings.terminalTabLayout")}</span>
          <Select
            label={t("settings.terminalTabLayout")}
            placeholder="—"
            value={settings.terminal.tabLayout}
            options={TERMINAL_TAB_LAYOUTS.map((layout) => ({
              value: layout,
              label: t(TAB_LAYOUT_LABEL[layout]),
            }))}
            onChange={(tabLayout) => patch({ terminal: { ...settings.terminal, tabLayout } })}
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">{t("settings.terminalBell")}</span>
          <Select
            label={t("settings.terminalBell")}
            placeholder="—"
            value={settings.terminal.bell}
            options={TERMINAL_BELLS.map((bell) => ({ value: bell, label: t(BELL_LABEL[bell]) }))}
            onChange={(bell) => patch({ terminal: { ...settings.terminal, bell } })}
          />
        </div>

        <TerminalProfilesEditor
          profiles={settings.terminal.profiles}
          shells={shells}
          onChange={(profiles) => patch({ terminal: { ...settings.terminal, profiles } })}
        />
      </div>
    </div>
  );
}

/** 比较工具与 Diff 设置页 */
export function ToolDiffPage() {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <p className="settings-hint">
          Forge 内置高性能双栏与三方冲突合并（Three-way Merge）差异对比视图，并支持行内差异内联渲染与高亮提示。
        </p>
      </div>
    </div>
  );
}

/** AI 助理：命令行助手与总开关 */
export function ToolAiCliPage() {
  return <AiCliSettingsPanel />;
}

/** AI 助理：模型服务商 */
export function ToolAiProvidersPage() {
  return <ModelProvidersPanel />;
}

/** AI 助理：智能提交与摘要 */
export function ToolAiCommitPage() {
  return <AiCommitSettingsPanel />;
}

/** AI 助理：技能与提示词库 */
export function ToolAiSkillsPage() {
  return <SkillsPanel />;
}

/** AI 助理：MCP 模型上下文协议 */
export function ToolAiMcpPage() {
  return <McpPanel />;
}

/** AI 助理：自动化钩子 */
export function ToolAiHooksPage() {
  return <HooksSettingsPanel />;
}

/** AI 助理：归档会话记录 */
export function ToolAiArchivedSessionsPage({ workspace }: { workspace: string | null }) {
  return <AiArchivedSessionsPanel workspace={workspace} />;
}

/** 关于与更新设置页 */
export function ToolAboutPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const [appVersion, setAppVersion] = useState<string>("");
  const [checking, setChecking] = useState<boolean>(false);
  const [hasChecked, setHasChecked] = useState<boolean>(false);
  const [checkInfo, setCheckInfo] = useState<UpdateInfo | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    void currentVersion().then(setAppVersion);
  }, []);

  const handleCheck = async () => {
    setChecking(true);
    setCheckError(null);
    setCheckInfo(null);
    setHasChecked(false);
    try {
      const info = await checkForUpdate();
      setCheckInfo(info);
      setHasChecked(true);
    } catch (e: any) {
      setCheckError(e?.message || String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">{t("about.version")}</span>
          <span className="about-value">{appVersion || "—"}</span>
        </div>

        <div className="settings-row">
          <span className="settings-label">{t("settings.updates.autoDownload")}</span>
          <Select
            label={t("settings.updates.autoDownload")}
            placeholder="—"
            value={settings.updates.autoDownload ? "yes" : "no"}
            options={SWITCHES.map((option) => ({ value: option, label: t(SWITCH_LABEL[option]) }))}
            onChange={(next) =>
              patch({ updates: { ...settings.updates, autoDownload: next === "yes" } })
            }
          />
        </div>

        {settings.updates.autoDownload ? (
          <div className="settings-row">
            <span className="settings-label">{t("settings.updates.autoPromptInstall")}</span>
            <Select
              label={t("settings.updates.autoPromptInstall")}
              placeholder="—"
              value={settings.updates.autoPromptInstall ? "yes" : "no"}
              options={SWITCHES.map((option) => ({
                value: option,
                label: t(SWITCH_LABEL[option]),
              }))}
              onChange={(next) =>
                patch({ updates: { ...settings.updates, autoPromptInstall: next === "yes" } })
              }
            />
          </div>
        ) : null}

        <div className="settings-row">
          <span className="settings-label">{t("settings.updates.proxyEnabled")}</span>
          <Select
            label={t("settings.updates.proxyEnabled")}
            placeholder="—"
            value={settings.updates.proxyEnabled ? "yes" : "no"}
            options={SWITCHES.map((option) => ({ value: option, label: t(SWITCH_LABEL[option]) }))}
            onChange={(next) =>
              patch({ updates: { ...settings.updates, proxyEnabled: next === "yes" } })
            }
          />
        </div>

        {settings.updates.proxyEnabled ? (
          <div className="settings-row">
            <span className="settings-label">{t("settings.updates.proxyUrl")}</span>
            <input
              type="text"
              className="settings-input is-url"
              value={settings.updates.proxyUrl}
              placeholder="https://gh-proxy.com/"
              onChange={(e) =>
                patch({ updates: { ...settings.updates, proxyUrl: e.target.value } })
              }
            />
          </div>
        ) : null}

        <div className="settings-row">
          <span className="settings-label">{t("about.check")}</span>
          <button
            type="button"
            className="text-button"
            disabled={checking}
            onClick={() => void handleCheck()}
          >
            {checking ? "检查中..." : t("about.check")}
          </button>
        </div>

        {hasChecked ? (
          <div className="settings-row">
            <span className="settings-label">检查结果</span>
            <span className="settings-value">
              {checkInfo
                ? `发现新版本 v${checkInfo.version}`
                : "当前已是最新版本"}
            </span>
          </div>
        ) : null}

        {checkError ? (
          <div className="settings-row">
            <span className="settings-label">检查失败</span>
            <span className="settings-value is-error">{checkError}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
