import { useI18n } from "../i18n";
import { useSettings } from "../hooks/useSettings";
import Select from "./Select";
import { KEYMAP_SCHEMES, type KeymapScheme } from "../lib/settings";

/** 方案名是各编辑器的专有名词，不做翻译。 */
const SCHEME_LABEL: Record<KeymapScheme, string> = {
  idea: "IntelliJ IDEA",
  vscode: "VS Code",
  eclipse: "Eclipse",
};

/**
 * 快捷键设置页：只做方案切换，不提供逐条改键。
 *
 * 三套方案都内置在代码里（`lib/shortcuts.ts` 管应用级、`lib/cm/keymap.ts` 管编辑器内），
 * 默认 IDEA；界面仅保留方案选择，不展示逐条键位或说明列表。
 */
export default function ShortcutSettingsPanel() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const scheme = settings.editor.keymap;

  return (
    <div className="settings-rows is-shortcuts">
      <div className="settings-row">
        <span className="settings-label">{t("shortcuts.scheme")}</span>
        <Select
          label={t("shortcuts.scheme")}
          placeholder="—"
          value={scheme}
          options={KEYMAP_SCHEMES.map((value) => ({ value, label: SCHEME_LABEL[value] }))}
          onChange={(keymap) => patch({ editor: { ...settings.editor, keymap } })}
        />
      </div>
    </div>
  );
}
