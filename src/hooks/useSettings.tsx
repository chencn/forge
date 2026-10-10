import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { I18nProvider, resolveLang } from "../i18n";
import { saveSettings } from "../lib/settings";
import type { Settings } from "../lib/settings";
import { resolveTheme } from "../lib/window";
import type { ThemeMode } from "../lib/window";

interface SettingsValue {
  /** 当前生效的全局设置。 */
  settings: Settings;
  /** 局部覆盖后整份写回文件。 */
  patch: (next: Partial<Settings>) => void;
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
  /** 入口在 import monaco 前读好的设置，语言决定编辑器文案，不能等渲染后再补。 */
  initial: Settings;
  children: ReactNode;
}

export function SettingsProvider({ initial, children }: SettingsProviderProps) {
  const [settings, setSettings] = useState<Settings>(initial);

  const patch = useCallback((next: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...next }));
  }, []);

  // 任何一处改动都整份落盘，文件始终是最新状态。
  useEffect(() => {
    void saveSettings(settings);
  }, [settings]);

  // 跟随系统时要在系统偏好变化后重算，其它模式写死。
  const mode: ThemeMode = settings.theme;
  // 初值跟着 DOM 而不是跟着模式：属性还没落地时子组件读到的就是浅色，
  // 状态得先如实记成浅色，落地后的那一次 setState 才会把取色副作用再跑一遍。
  const [applied, setApplied] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light"
  );
  useEffect(() => {
    const apply = () => {
      const next = resolveTheme(mode);
      document.documentElement.dataset.theme = next;
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
