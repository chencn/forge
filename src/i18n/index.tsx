import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { en } from "./lang/en";
import { zh } from "./lang/zh";
import type { TranslationKey } from "./lang/zh";

export type Lang = "zh" | "en";

const DICTIONARIES: Record<Lang, Record<TranslationKey, string>> = { zh, en };

/** 设置里没写语言时按浏览器语言定，其它值原样采纳。 */
export function resolveLang(stored: string | null): Lang {
  if (stored === "zh" || stored === "en") return stored;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

type TranslateVars = Record<string, string | number>;

interface I18nValue {
  /** 当前界面语言。 */
  lang: Lang;
  /** Intl 用的 BCP 47 标签，跟随 lang。 */
  locale: string;
  setLang: (lang: Lang) => void;
  /** 取译文；缺失键回退到键名本身，vars 替换 {token}。 */
  t: (key: TranslationKey, vars?: TranslateVars) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

interface I18nProviderProps {
  /** 当前语言，由设置层控制。 */
  lang: Lang;
  /** 切换语言时回写设置。 */
  onLangChange: (lang: Lang) => void;
  children: ReactNode;
}

export function I18nProvider({ lang, onLangChange, children }: I18nProviderProps) {
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  const t = useCallback(
    (key: TranslationKey, vars?: TranslateVars) => {
      const template = DICTIONARIES[lang][key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (match, token: string) =>
        token in vars ? String(vars[token]) : match
      );
    },
    [lang]
  );

  const value = useMemo<I18nValue>(
    () => ({ lang, locale: lang === "zh" ? "zh-CN" : "en-US", setLang: onLangChange, t }),
    [lang, onLangChange, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n 必须在 I18nProvider 内使用");
  return value;
}
