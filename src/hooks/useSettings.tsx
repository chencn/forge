import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { I18nProvider, resolveLang } from "../i18n";
import { loadSettings, saveSettings } from "../lib/settings";
import type { Settings, SettingsPatch } from "../lib/settings";
import type { ThemeMode } from "../lib/window";
import { applyThemeAttributes, resolveThemeId, themeKind } from "../themes/themeManager";

interface SettingsValue {
  /** 当前生效的全局设置。 */
  settings: Settings;
  /** 改哪几个字段就只存那几个字段，存完跟着文件里的全量结果走。 */
  patch: (next: SettingsPatch) => void;
  /** 已经写到 document 上的深浅色。子组件取色要等这一步落地，否则读到的还是上一套令牌。 */
  applied: "light" | "dark";
}

const SettingsContext = createContext<SettingsValue | null>(null);

/** 读全局设置；提供者拿不到就直接报错，设置是渲染的前提。 */
export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings 必须在 SettingsProvider 内使用");
  return value;
}

interface SettingsProviderProps {
  /** 入口在 import 界面之前读好的设置：语言与编辑器文案都在首帧就要对。 */
  initial: Settings;
  children: ReactNode;
}

export function SettingsProvider({ initial, children }: SettingsProviderProps) {
  const [settings, setSettings] = useState<Settings>(initial);
  /** 第几次保存的回包才算数；见下面 `patch`。 */
  const pending = useRef(0);

  /**
   * 改设置：本地先按新值渲染，再把**改动的那几个字段**交给后端合并，最后用合并回来的
   * 全量设置覆盖本地。只发改动项是为了不让这个窗口的旧副本抹掉别的窗口刚存的字段
   * （原来任何一次改动都整份写回，AI 开关就是这么被别的窗口写没的）；用返回值收尾
   * 是让每个窗口都跟文件一致。挂载时不再写盘——一开窗就重写一遍文件没有任何意义。
   * 保存失败就按文件重读：宁可看到旧值，也不让界面停在一个根本没落盘的状态。
   */
  const patch = useCallback((next: SettingsPatch) => {
    // 局部权限补丁在本地同样逐项合并，未切换的开关不能丢失。
    setSettings((current) => ({ ...current, ...next, browser: { ...current.browser, ...next.browser } }));
    // 只有最后一次保存的回包才配覆盖本地：连着改两处会各回一次包，晚到的旧包会把新值倒回去。
    const ticket = ++pending.current;
    void saveSettings(next).then((latest) => {
      if (pending.current === ticket) setSettings(latest);
    }).catch(() => {
      if (pending.current !== ticket) return;
      void loadSettings().then((latest) => { if (pending.current === ticket) setSettings(latest); });
    });
  }, []);

  // 跟随系统时要在系统偏好变化后重算，其它模式写死。
  const mode: ThemeMode = settings.theme;
  // 初值跟着 DOM 而不是跟着模式：属性还没落地时子组件读到的就是浅色，
  // 状态得先如实记成浅色，落地后的那一次 setState 才会把取色副作用再跑一遍。
  const [applied, setApplied] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light"
  );
  useEffect(() => {
    const apply = () => {
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const targetId = resolveThemeId(mode, isDark);
      applyThemeAttributes(targetId);
      const next = themeKind(targetId);
      setApplied(next);
    };
    apply();
    if (mode !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  return (
    <SettingsContext.Provider value={{ settings, patch, applied }}>
      <I18nProvider
        lang={resolveLang(settings.language || null)}
        onLangChange={(lang) => patch({ language: lang })}
      >
        {children}
      </I18nProvider>
    </SettingsContext.Provider>
  );
}
