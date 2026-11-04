import { useEffect, useState } from "react";
import { useSettings } from "../../../hooks/useSettings";
import { useI18n, type Lang } from "../../../i18n";
import Select from "../../../components/Select";
import { AiAssistantsToggle } from "../../../components/AiCliSettingsPanel";
import { withShellFileToggle } from "../../../lib/settings";
import { builtinShellExtensions } from "../../../lib/shellOpen";
import { appendExtraExtension, normalizeExtraExtensions } from "../../../lib/shellWhitelist";
import { IS_WINDOWS } from "../../../lib/sys";
import type {
  CloseBehavior,
  HttpResponseLayout,
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

const HTTP_LAYOUTS: HttpResponseLayout[] = ["bottom", "tab"];
const HTTP_LAYOUT_LABEL: Record<HttpResponseLayout, "httpResponse.bottom" | "httpResponse.tab"> = {
  bottom: "httpResponse.bottom",
  tab: "httpResponse.tab",
};

const SWITCHES = ["yes", "no"] as const;
const SWITCH_LABEL: Record<"yes" | "no", "common.yes" | "common.no"> = {
  yes: "common.yes",
  no: "common.no",
};

/**
 * 外观设置页
 */
export function AppearanceThemePage() {
  const { t, lang, setLang } = useI18n();
  const { settings, patch } = useSettings();

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">{t("settings.themeMode")}</span>
          <Select
            label={t("settings.themeMode")}
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
          <span className="settings-label">{t("settings.uiLanguage")}</span>
          <Select
            label={t("settings.uiLanguage")}
            placeholder="—"
            value={lang}
            options={LANG_OPTIONS}
            onChange={setLang}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * 系统设置页
 */
export function AppearanceSystemPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  /** 内置文本后缀。用来拦住用户把已有格式再追加一遍。 */
  const [builtinExtensions, setBuiltinExtensions] = useState<string[]>([]);
  const [extraDraft, setExtraDraft] = useState("");

  // 右键菜单的「通过 Forge 打开」只在 Windows 生效，内置后缀也由后端给出。
  useEffect(() => {
    if (!IS_WINDOWS) return;
    let cancelled = false;
    void builtinShellExtensions()
      .then((list) => {
        if (!cancelled) setBuiltinExtensions(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 内置名单到手后把历史遗留的非法/重复后缀收干净，避免下拉里出现改不了的条目。
  const extraKey = settings.shell.extraExtensions.join("\0");
  useEffect(() => {
    if (builtinExtensions.length === 0) return;
    const cleaned = normalizeExtraExtensions(settings.shell.extraExtensions, builtinExtensions);
    if (cleaned.join("\0") === extraKey) return;
    patch({ shell: { ...settings.shell, extraExtensions: cleaned } });
  }, [builtinExtensions, extraKey, patch, settings.shell]);

  const addExtra = () => {
    const next = appendExtraExtension(settings.shell.extraExtensions, extraDraft, builtinExtensions);
    setExtraDraft("");
    if (next !== settings.shell.extraExtensions) {
      patch({ shell: { ...settings.shell, extraExtensions: next } });
    }
  };

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        {/* AI 助手是应用级总开关，关闭时 AI 相关设置页整块隐藏，所以必须挂在非 AI 页里才能重新打开 */}
        <div className="settings-row">
          <span className="settings-label">{t("ai.enable")}</span>
          <AiAssistantsToggle />
        </div>

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

        {/* 资源管理器右键菜单：只在 Windows 有这套集成，其它平台整块不渲染。 */}
        {IS_WINDOWS ? (
          <>
            <div className="settings-row">
              <span className="settings-label">{t("shellOpen.folder")}</span>
              <Select
                label={t("shellOpen.folder")}
                placeholder="—"
                value={settings.shell.openFolder ? "yes" : "no"}
                options={SWITCHES.map((option) => ({
                  value: option,
                  label: t(SWITCH_LABEL[option]),
                }))}
                onChange={(next) =>
                  patch({ shell: { ...settings.shell, openFolder: next === "yes" } })
                }
              />
            </div>

            <div className="settings-row">
              <span className="settings-label">{t("shellOpen.file")}</span>
              <Select
                label={t("shellOpen.file")}
                placeholder="—"
                value={settings.shell.openFile ? "yes" : "no"}
                options={SWITCHES.map((option) => ({
                  value: option,
                  label: t(SWITCH_LABEL[option]),
                }))}
                onChange={(next) =>
                  patch({ shell: withShellFileToggle(settings.shell, next === "yes") })
                }
              />
            </div>

            {settings.shell.openFile ? (
              <div className="settings-row">
                <span className="settings-label">{t("shellOpen.default")}</span>
                <Select
                  label={t("shellOpen.default")}
                  placeholder="—"
                  value={settings.shell.defaultFile ? "yes" : "no"}
                  options={SWITCHES.map((option) => ({
                    value: option,
                    label: t(SWITCH_LABEL[option]),
                  }))}
                  onChange={(next) =>
                    patch({ shell: { ...settings.shell, defaultFile: next === "yes" } })
                  }
                />
              </div>
            ) : null}

            {settings.shell.openFile ? (
              <div className="settings-row is-stack">
                <span className="settings-label">{t("shellOpen.extra")}</span>
                <div className="shell-extra">
                  <div className="shell-extra-add">
                    <input
                      className="settings-input"
                      value={extraDraft}
                      placeholder={t("shellOpen.extraPlaceholder")}
                      aria-label={t("shellOpen.extra")}
                      onChange={(event) => setExtraDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        addExtra();
                      }}
                    />
                    <button type="button" className="text-button" onClick={addExtra}>
                      {t("shellOpen.extraAdd")}
                    </button>
                  </div>
                  {settings.shell.extraExtensions.length > 0 ? (
                    <ul className="shell-extra-list">
                      {settings.shell.extraExtensions.map((ext) => (
                        <li key={ext} className="shell-extra-chip">
                          <span>.{ext}</span>
                          <button
                            type="button"
                            aria-label={t("shellOpen.extraRemove", { ext })}
                            onClick={() =>
                              patch({
                                shell: {
                                  ...settings.shell,
                                  extraExtensions: settings.shell.extraExtensions.filter(
                                    (item) => item !== ext
                                  ),
                                },
                              })
                            }
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
