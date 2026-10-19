import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { TermControl, TermFindOptions, TermFindResults } from "../lib/termSurface";
import { useI18n } from "../i18n";

const NO_RESULTS: TermFindResults = { index: 0, count: 0 };

interface TermFindBarProps {
  /** 查找要作用的那条终端；换会话时浮层跟着在新那条上重找。 */
  control: TermControl | null;
  /** 关掉浮层。Esc 与关闭按钮都走它。 */
  onClose: () => void;
  /** 打开时就带上的关键字（有单行选区时预填）。 */
  initialQuery?: string;
  /**
   * 变了就在当前这条缓冲上原地重找一次。终端换会话时 `control` 本身就是新对象，不需要它；
   * 运行面板只有一个终端、`control` 是稳定引用，切会话重放后靠它把开着的关键字在新缓冲上重跑。
   */
  revision?: string | number;
}

/**
 * 终端 / 运行输出右上角的查找浮层。
 *
 * 边打字边找，全部匹配高亮，当前项另一种颜色，显示「第几个/共几个」。
 * 区分大小写、全字、正则三个开关。Enter / Shift+Enter 下一个 / 上一个，
 * Esc 关掉、清高亮、焦点回终端。高亮上限由 SearchAddon 自己管（2000）。
 */
export default function TermFindBar({
  control,
  onClose,
  initialQuery = "",
  revision,
}: TermFindBarProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState(initialQuery);
  const [findOptions, setFindOptions] = useState<TermFindOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [results, setResults] = useState<TermFindResults>(NO_RESULTS);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // 切会话或改条件时在新的那条上重找；计数跟着那条终端走。
  // `revision` 变了也重跑一次：运行面板的 control 是稳定引用，切会话重放缓冲后靠它在新缓冲上重找。
  useEffect(() => {
    if (!control) return;
    const stop = control.watchFind(setResults);
    if (query) control.findNext(query, findOptions, true);
    else {
      control.clearFind();
      setResults(NO_RESULTS);
    }
    return () => {
      stop();
      control.clearFind();
    };
  }, [control, query, findOptions, revision]);

  const search = (forward: boolean) => {
    if (!control || !query) return;
    if (forward) control.findNext(query, findOptions);
    else control.findPrevious(query, findOptions);
  };

  const toggleOption = (key: keyof TermFindOptions) =>
    setFindOptions((current) => ({ ...current, [key]: !current[key] }));

  const findLabel = query
    ? results.count === 0
      ? t("terminal.findNoResults")
      : results.index > 0
        ? `${results.index}/${results.count}`
        : `${results.count}`
    : "";

  const close = () => {
    onClose();
    control?.focus();
  };

  return (
    <div className="term-find" role="search">
      <input
        ref={inputRef}
        className="term-find-input"
        value={query}
        placeholder={t("terminal.find")}
        aria-label={t("terminal.find")}
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            search(!event.shiftKey);
          } else if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      />
      <span className={`term-find-count${query && results.count === 0 ? " is-empty" : ""}`}>
        {findLabel}
      </span>
      <button
        type="button"
        className={`switch-chip${findOptions.caseSensitive ? " is-on" : ""}`}
        aria-pressed={findOptions.caseSensitive}
        title={t("search.option.case")}
        onClick={() => toggleOption("caseSensitive")}
      >
        Aa
      </button>
      <button
        type="button"
        className={`switch-chip${findOptions.wholeWord ? " is-on" : ""}`}
        aria-pressed={findOptions.wholeWord}
        title={t("search.option.words")}
        onClick={() => toggleOption("wholeWord")}
      >
        W
      </button>
      <button
        type="button"
        className={`switch-chip${findOptions.regex ? " is-on" : ""}`}
        aria-pressed={findOptions.regex}
        title={t("search.option.regex")}
        onClick={() => toggleOption("regex")}
      >
        .*
      </button>
      <span className="term-find-sep" aria-hidden="true" />
      <button
        type="button"
        className="icon-button is-inline"
        disabled={results.count === 0}
        title={`${t("terminal.findPrevious")} (Shift+Enter)`}
        onClick={() => search(false)}
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        className="icon-button is-inline"
        disabled={results.count === 0}
        title={`${t("terminal.findNext")} (Enter)`}
        onClick={() => search(true)}
      >
        <ArrowDown size={14} />
      </button>
      <button
        type="button"
        className="icon-button is-inline"
        title={`${t("terminal.findClose")} (Esc)`}
        onClick={close}
      >
        <X size={14} />
      </button>
    </div>
  );
}
