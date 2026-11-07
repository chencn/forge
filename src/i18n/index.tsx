import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { TranslationKey } from "./lang/zh";

/** 界面语言：简体 / 英文 / 繁体。 */
export type Lang = "zh" | "en" | "zh-TW";

/** 一份语言的词典（键 → 译文）。 */
type Dictionary = Record<TranslationKey, string>;

/**
 * 三份词典各约 140KB 源码。早先三份全是静态 import，等于每个用户都为两种用不上的语言
 * 付一遍解析与求值成本，而且全部压在首屏关键路径上。现在按语言拆成独立 chunk，
 * 启动只装当前语言那一份（预载见 main.tsx 的 `ensureLang`，切换语言见下面的 `setLang`）。
 */
const LOADERS: Record<Lang, () => Promise<Dictionary>> = {
  zh: () => import("./lang/zh").then((module) => module.zh),
  en: () => import("./lang/en").then((module) => module.en),
  "zh-TW": () => import("./lang/zh-TW").then((module) => module.zhTW),
};

/** 已装载词典的缓存。 */
const DICTIONARIES = new Map<Lang, Dictionary>();
/** 装载中的词典（同一语言并发请求合并为一次 import）。 */
const INFLIGHT = new Map<Lang, Promise<Dictionary>>();

/** 装上某种语言的词典；已经装好就立即返回。启动流程与切换语言都要先过这一关。 */
export function ensureLang(lang: Lang): Promise<Dictionary> {
  const loaded = DICTIONARIES.get(lang);
  if (loaded) return Promise.resolve(loaded);
  let pending = INFLIGHT.get(lang);
  if (!pending) {
    pending = LOADERS[lang]().then((dictionary) => {
      DICTIONARIES.set(lang, dictionary);
      INFLIGHT.delete(lang);
      return dictionary;
    });
    INFLIGHT.set(lang, pending);
  }
  return pending;
}

/** 设置里没写语言时按浏览器语言定，其它值原样采纳。繁体中文系统自动优先配给 zh-TW。 */
export function resolveLang(stored: string | null): Lang {
  if (stored === "zh" || stored === "en" || stored === "zh-TW") return stored;
  const nav = (typeof navigator !== "undefined" ? navigator.language : "").toLowerCase();
  if (nav === "zh-tw" || nav === "zh-hk" || nav === "zh-mo" || nav.includes("hant")) {
    return "zh-TW";
  }
  if (nav.startsWith("zh")) return "zh";
  return "en";
}

/** 插值变量的形态（替换译文里的 `{token}`）。 */
type TranslateVars = Record<string, string | number>;

/** 指定语言取译文；词典未装好回键名，不抛错。 */
function translateIn(lang: Lang, key: TranslationKey, vars?: TranslateVars): string {
  // 词典还没装好时按缺键回退键名：预载由启动流程与 setLang 保证，
  // 这里宁可按缺键处理，也不要在渲染途中抛错把整棵树打断。
  const template = DICTIONARIES.get(lang)?.[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, token: string) =>
    token in vars ? String(vars[token]) : match
  );
}

/**
 * React 之外的调用点（事件监听、lib 单例）取当前语言的译文。
 * 语言镜像由 I18nProvider 在每次渲染时同步，挂在 Provider 之下的界面先于它更新。
 */
let activeLang: Lang = resolveLang(null);

/** 用当前界面语言取译文（React 外的调用点用）。 */
export function translate(key: TranslationKey, vars?: TranslateVars): string {
  return translateIn(activeLang, key, vars);
}

/** i18n 上下文的值。 */
interface I18nValue {
  /** 当前界面语言。 */
  lang: Lang;
  /** Intl 用的 BCP 47 标签，跟随 lang。 */
  locale: string;
  setLang: (lang: Lang) => void;
  /** 取译文；缺失键回退到键名本身，vars 替换 {token}。 */
  t: (key: TranslationKey, vars?: TranslateVars) => string;
}

/** i18n 上下文对象；Provider 之外为 null。 */
const I18nContext = createContext<I18nValue | null>(null);

/** {@link I18nProvider} 的入参。 */
interface I18nProviderProps {
  /** 当前语言，由设置层控制。 */
  lang: Lang;
  /** 切换语言时回写设置。 */
  onLangChange: (lang: Lang) => void;
  children: ReactNode;
}

/** i18n 根组件：装词典、同步 React 外的语言镜像、下发 t/setLang。 */
export function I18nProvider({ lang, onLangChange, children }: I18nProviderProps) {
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang === "zh-TW" ? "zh-TW" : "en";
  }, [lang]);

  // 维护 React 之外那份语言镜像：translate() 依赖它跟上当前界面语言。
  activeLang = lang;

  /**
   * 兜底：调用方漏了预载时，挂载后自行把词典补上。成功后推进一版让 `t` 换新引用，
   * 把先渲染出来的键名重刷成译文。常规路径（启动预载 + setLang 预载）不会走到这里。
   */
  const [readyTick, bumpReady] = useState(0);
  useEffect(() => {
    if (DICTIONARIES.has(lang)) return;
    let alive = true;
    void ensureLang(lang).then(() => { if (alive) bumpReady((tick) => tick + 1); });
    return () => { alive = false; };
  }, [lang]);

  const t = useCallback(
    (key: TranslationKey, vars?: TranslateVars) => translateIn(lang, key, vars),
    // readyTick 只是为了让词典到位后换一次引用，不参与取值本身。
    [lang, readyTick]
  );

  const setLang = useCallback(
    async (next: Lang) => {
      // 先把新词典装好再换语言：直接切会闪一帧满屏键名。
      await ensureLang(next);
      onLangChange(next);
    },
    [onLangChange]
  );

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      locale: lang === "zh" ? "zh-CN" : lang === "zh-TW" ? "zh-TW" : "en-US",
      setLang,
      t,
    }),
    [lang, setLang, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** 取 i18n 上下文；漏包 Provider 时直接报错。 */
export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n 必须在 I18nProvider 内使用");
  return value;
}
