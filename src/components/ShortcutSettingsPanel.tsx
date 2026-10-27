import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";
import {
  SHORTCUT_DEFS,
  comboFromEvent,
  comboOwner,
  formatShortcut,
  loadShortcutOverrides,
  saveShortcutOverrides,
  type ShortcutOverrides,
} from "../lib/shortcuts";

/** 注册表 id 的展示名；设置页列表按 SHORTCUT_DEFS 的顺序渲染。 */
const SHORTCUT_LABEL: Record<string, TranslationKey> = {
  "search.findInFiles": "shortcut.search.findInFiles",
  "search.gotoFile": "shortcut.search.gotoFile",
  "file.save": "shortcut.file.save",
  "run.run": "shortcut.run.run",
  "run.rerun": "shortcut.run.rerun",
  "run.stop": "shortcut.run.stop",
  "run.chooseConfig": "shortcut.run.chooseConfig",
  "run.toggleTool": "shortcut.run.toggleTool",
};

/**
 * 快捷键设置页：列出全部应用级键位，点「修改」后下一次按键就是新组合。
 *
 * 捕获挂在 window 捕获阶段并吞掉默认行为——捕获途中不能让老键位把设置页自己关了
 * 或者把某个面板打开。只按到修饰键时等待主键；Esc 取消；撞了别的动作报错不落盘。
 */
export default function ShortcutSettingsPanel() {
  const { t } = useI18n();
  const [overrides, setOverrides] = useState<ShortcutOverrides>(loadShortcutOverrides);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(null);
        setError(null);
        return;
      }
      const combo = comboFromEvent(event);
      // 只按了修饰键本身：等主键落下来再成组合。
      if (!combo) return;
      const owner = comboOwner(combo, overrides, capturing);
      if (owner) {
        const label = SHORTCUT_LABEL[owner];
        setError(t("shortcuts.duplicate", { name: label ? t(label) : owner }));
        return;
      }
      const next = { ...overrides, [capturing]: combo };
      setOverrides(next);
      saveShortcutOverrides(next);
      setCapturing(null);
      setError(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, overrides, t]);

  const reset = (id: string) => {
    const next = { ...overrides };
    delete next[id];
    setOverrides(next);
    saveShortcutOverrides(next);
    setError(null);
  };
  const resetAll = () => {
    setOverrides({});
    saveShortcutOverrides({});
    setError(null);
  };

  return (
    <div className="settings-rows">
      {error ? <p className="settings-note is-error" role="alert">{error}</p> : null}
      {SHORTCUT_DEFS.map((def) => {
        const label = SHORTCUT_LABEL[def.id];
        const overridden = overrides[def.id] !== undefined;
        return (
          <div className="settings-row is-shortcut" key={def.id}>
            <span className="settings-label">{label ? t(label) : def.id}</span>
            <span className="settings-shortcut">
              {capturing === def.id ? (
                <kbd className="shortcut-capture">{t("shortcuts.captureHint")}</kbd>
              ) : (
                <kbd>{formatShortcut(def.id, overrides)}</kbd>
              )}
              <button
                type="button"
                className="button"
                disabled={capturing !== null}
                onClick={() => {
                  setError(null);
                  setCapturing(capturing === def.id ? null : def.id);
                }}
              >
                {t("shortcuts.rebind")}
              </button>
              <button
                type="button"
                className="icon-button is-inline"
                disabled={!overridden || capturing !== null}
                title={t("shortcuts.reset")}
                aria-label={t("shortcuts.reset")}
                onClick={() => reset(def.id)}
              >
                <RotateCcw size={14} />
              </button>
            </span>
          </div>
        );
      })}
      <div className="settings-row">
        <span className="settings-label" />
        <span className="settings-actions">
          <button type="button" className="button" disabled={Object.keys(overrides).length === 0} onClick={resetAll}>
            {t("shortcuts.resetAll")}
          </button>
        </span>
      </div>
      <p className="settings-note">{t("shortcuts.note")}</p>
    </div>
  );
}
