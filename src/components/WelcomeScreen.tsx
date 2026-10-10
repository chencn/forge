import { SHORTCUT_HINTS } from "../lib/keymapHints";
import type { KeymapScheme } from "../lib/settings";
import { useI18n } from "../i18n";

interface WelcomeScreenProps {
  /** 告示页只宣传当前方案里真绑着的键位。 */
  keymap: KeymapScheme;
  /** 工程已经开着时不再把应用名写一遍。 */
  workspace: boolean;
}

/**
 * IDEA 的空编辑区是一张快捷键告示页，不是一片空白。
 * 开工程这件事只有主工具栏那颗入口，这一页不重复摆按钮。
 */
export default function WelcomeScreen({ keymap, workspace }: WelcomeScreenProps) {
  const { t } = useI18n();
  const rows = SHORTCUT_HINTS.map((hint) => ({ label: t(hint.label), chord: hint.chords[keymap] })).filter(
    (row) => row.chord !== undefined
  );

  return (
    <div className="welcome">
      {workspace ? null : <p className="welcome-title">{t("app.name")}</p>}
      <p className="welcome-hint">{t("welcome.hint")}</p>

      {rows.length > 0 ? (
        <dl className="welcome-keys" aria-label={t("welcome.shortcuts")}>
          <p className="welcome-keys-head">{t("welcome.shortcuts")}</p>
          {rows.map((row) => (
            <div key={row.label} className="welcome-key-row">
              <dt>{row.label}</dt>
              <dd>
                <kbd>{row.chord}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
