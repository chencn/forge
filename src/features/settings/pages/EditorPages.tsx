import { useSettings } from "../../../hooks/useSettings";
import { useI18n } from "../../../i18n";
import Select from "../../../components/Select";
import { type KeymapScheme, type SavePolicy } from "../../../lib/settings";

const SWITCHES = ["yes", "no"] as const;
const SWITCH_LABEL: Record<"yes" | "no", "common.yes" | "common.no"> = {
  yes: "common.yes",
  no: "common.no",
};

const TAB_SIZES = [2, 4, 8];

const SAVE_POLICIES: SavePolicy[] = ["manual", "blur"];
const SAVE_POLICY_LABEL: Record<SavePolicy, "savePolicy.manual" | "savePolicy.blur"> = {
  manual: "savePolicy.manual",
  blur: "savePolicy.blur",
};

const KEYMAPS: KeymapScheme[] = ["default", "idea", "eclipse"];
const KEYMAP_LABEL: Record<KeymapScheme, string> = {
  default: "Forge (Default)",
  idea: "IntelliJ IDEA",
  eclipse: "Eclipse",
};

/** 常规编辑器设置页 */
export function EditorGeneralPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">{t("settings.savePolicy")}</span>
          <Select
            label={t("settings.savePolicy")}
            placeholder="—"
            value={settings.editor.savePolicy}
            options={SAVE_POLICIES.map((option) => ({
              value: option,
              label: t(SAVE_POLICY_LABEL[option]),
            }))}
            onChange={(savePolicy) => patch({ editor: { ...settings.editor, savePolicy } })}
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">{t("settings.saveOnExit")}</span>
          <Select
            label={t("settings.saveOnExit")}
            placeholder="—"
            value={settings.editor.saveOnExit ? "yes" : "no"}
            options={SWITCHES.map((option) => ({ value: option, label: t(SWITCH_LABEL[option]) }))}
            onChange={(next) =>
              patch({ editor: { ...settings.editor, saveOnExit: next === "yes" } })
            }
          />
        </div>

      </div>
    </div>
  );
}

/** 字体设置页 */
export function EditorFontPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">字体族 (Font Family)</span>
          <input
            type="text"
            className="text-input"
            value={settings.terminal.fontFamily || "JetBrains Mono"}
            placeholder="JetBrains Mono, Menlo, monospace"
            onChange={(e) => patch({ terminal: { ...settings.terminal, fontFamily: e.target.value } })}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">{t("settings.fontSize")}</span>
          <input
            type="number"
            className="text-input"
            min={10}
            max={32}
            value={settings.editor.fontSize || 13}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (!Number.isNaN(val)) patch({ editor: { ...settings.editor, fontSize: val } });
            }}
          />
          <span className="settings-unit">px</span>
        </div>
      </div>
    </div>
  );
}

/** 配色方案页 */
export function EditorColorSchemePage() {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <p className="settings-hint">
          编辑器语法高亮直接适配当前主题与多色彩模式。可在“外观与行为 › 外观”中选择对应主题方案。
        </p>
      </div>
    </div>
  );
}

/** 代码样式设置页 */
export function EditorCodeStylePage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">{t("settings.tabSize")}</span>
          <Select
            label={t("settings.tabSize")}
            placeholder="—"
            value={settings.editor.tabSize}
            options={TAB_SIZES.map((size) => ({ value: size, label: String(size) }))}
            onChange={(size) => patch({ editor: { ...settings.editor, tabSize: size } })}
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">{t("settings.keymap")}</span>
          <Select
            label={t("settings.keymap")}
            placeholder="—"
            value={settings.editor.keymap}
            options={KEYMAPS.map((scheme) => ({
              value: scheme,
              label: KEYMAP_LABEL[scheme],
            }))}
            onChange={(keymap) => patch({ editor: { ...settings.editor, keymap } })}
          />
        </div>
      </div>
    </div>
  );
}

/** 文件类型与忽略设置页 */
export function EditorFileTypesPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">{t("explorer.showIgnored")}</span>
          <Select
            label={t("explorer.showIgnored")}
            placeholder="—"
            value={settings.explorer.showIgnored ? "yes" : "no"}
            options={SWITCHES.map((option) => ({ value: option, label: t(SWITCH_LABEL[option]) }))}
            onChange={(next) =>
              patch({ explorer: { ...settings.explorer, showIgnored: next === "yes" } })
            }
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">{t("explorer.showHidden")}</span>
          <Select
            label={t("explorer.showHidden")}
            placeholder="—"
            value={settings.explorer.showHidden ? "yes" : "no"}
            options={SWITCHES.map((option) => ({ value: option, label: t(SWITCH_LABEL[option]) }))}
            onChange={(next) =>
              patch({ explorer: { ...settings.explorer, showHidden: next === "yes" } })
            }
          />
        </div>
      </div>
    </div>
  );
}

/** 缩略图设置页 */
export function EditorMinimapPage() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">{t("settings.minimap")}</span>
          <Select
            label={t("settings.minimap")}
            placeholder="—"
            value={settings.editor.minimap ? "yes" : "no"}
            options={SWITCHES.map((option) => ({ value: option, label: t(SWITCH_LABEL[option]) }))}
            onChange={(next) => patch({ editor: { ...settings.editor, minimap: next === "yes" } })}
          />
        </div>
      </div>
    </div>
  );
}
