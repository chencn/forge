import { shortcutHints } from "../lib/keymapHints";
import type { KeymapScheme } from "../lib/settings";
import { useI18n } from "../i18n";

/** 欢迎页/告示页的入参。 */
interface WelcomeScreenProps {
  /** 告示页只宣传当前方案里真绑着的键位。 */
  keymap: KeymapScheme;
  /** 工程已经开着时不再把应用名写一遍。 */
  workspace: boolean;
  onSearchEverywhere?: () => void;
  onGotoFile?: () => void;
}

/**
 * 空编辑区：几条导航提示，键名右对齐，没有标题和按键框。
 * 开工程这件事只有主工具栏那颗入口，这一页不重复摆按钮。
 */
export default function WelcomeScreen({ keymap, workspace, onSearchEverywhere, onGotoFile }: WelcomeScreenProps) {
  const { t } = useI18n();
  const rows = shortcutHints(keymap);

  return (
    <div className="welcome">
      {workspace ? null : <p className="welcome-title">{t("app.name")}</p>}
      {workspace ? null : <p className="welcome-hint">{t("welcome.hint")}</p>}

      <dl className="welcome-hints">
        {rows.map((row) => {
          const run = row.action === "search" ? onSearchEverywhere : row.action === "gotoFile" ? onGotoFile : undefined;
          return (
            <div key={row.label} className="welcome-hint-row">
              <dt>
                {run ? (
                  <button type="button" className="welcome-hint-button" onClick={run}>{t(row.label)}</button>
                ) : t(row.label)}
              </dt>
              {row.chord ? <dd>{row.chord}</dd> : null}
            </div>
          );
        })}
      </dl>
    </div>
  );
}
