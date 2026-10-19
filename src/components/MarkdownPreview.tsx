import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import ContextMenu, { type MenuAnchor, type MenuItem } from "./ContextMenu";
import { useI18n } from "../i18n";
import { assetUrl, openExternal } from "../lib/fs";
import { renderMarkdown } from "../lib/markdown";

/** 供分栏模式下双向同步滚动位置的指令句柄。 */
export interface MarkdownPreviewHandle {
  setScrollRatio: (ratio: number) => void;
  getScrollRatio: () => number;
  /** 从外部（顶部视图栏那颗放大镜）打开页内查找条并把焦点落进输入框。 */
  openFind: () => void;
}

interface MarkdownPreviewProps {
  /** markdown 正文。 */
  source: string;
  /** 这份文档的绝对路径；相对图片按它所在目录解析。 */
  docPath: string;
  /** 点本地链接（相对路径的图片或文件）时打开它。 */
  onOpenLocal: (absolute: string) => void;
  /** 切换到源码视图。 */
  onToggleSource?: () => void;
  /** 滚动位置变化时的比例回调（0~1），供分栏模式下与编辑器联动。 */
  onScrollRatio?: (ratio: number) => void;
}

/** 页内查找的三个开关，与底部查找窗口同一档语义。 */
interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** 把正则元字符转义掉，让普通关键词里的 `.` `(` 等按字面匹配。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 按关键词与三个开关拼出正则；拼不出（非法正则）返回 null。 */
function buildFindRegex(query: string, options: FindOptions): RegExp | null {
  const flags = "g" + (options.caseSensitive ? "" : "i");
  const body = options.regex ? query : escapeRegExp(query);
  const pattern = options.wholeWord ? `\\b(?:${body})\\b` : body;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/** 给一处命中涂亮的 <mark> 打上的类名，清高亮与切活动都靠它认。 */
const MARK_CLASS = "md-find-mark";

/**
 * markdown 的渲染视图。
 *
 * 正文由 marked 转成 HTML、DOMPurify 洗过后注入；图片的地址在这一步就换成了
 * asset 协议的 URL，所以本地图片与线上图片走的是同一条 <img> 路径。
 * 链接的点击在容器上统一拦一次：外链交系统浏览器，本地文件交编辑器，
 * 页内锚点留给浏览器自己滚。
 *
 * 这一侧是只读渲染，不像源码那台 Monaco 自带 Ctrl+F，所以这里自己实现一套页内查找：
 * 遍历渲染后的文本节点，把命中的片段套进 <mark>，上一个/下一个在活动的那处滚动定位。
 * 正文换了（重渲染）时 React 会把整段 innerHTML 重设，我们的 <mark> 随之消失，
 * 于是跟着重跑一次当前关键词。
 */
export default forwardRef<MarkdownPreviewHandle, MarkdownPreviewProps>(function MarkdownPreview(
  { source, docPath, onOpenLocal, onToggleSource, onScrollRatio }: MarkdownPreviewProps,
  ref
) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const onScrollRatioRef = useRef(onScrollRatio);
  onScrollRatioRef.current = onScrollRatio;

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findOptions, setFindOptions] = useState<FindOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [matchCount, setMatchCount] = useState<{ total: number; active: number }>({
    total: 0,
    active: 0,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const marksRef = useRef<HTMLElement[]>([]);
  const activeRef = useRef(0);

  useImperativeHandle(
    ref,
    () => ({
      setScrollRatio: (ratio: number) => {
        const host = hostRef.current;
        if (!host) return;
        const max = host.scrollHeight - host.clientHeight;
        if (max > 0) {
          host.scrollTop = Math.round(ratio * max);
        }
      },
      getScrollRatio: () => {
        const host = hostRef.current;
        if (!host) return 0;
        const max = host.scrollHeight - host.clientHeight;
        return max > 0 ? host.scrollTop / max : 0;
      },
      openFind: () => {
        setFindOpen(true);
        inputRef.current?.focus();
        inputRef.current?.select();
      },
    }),
    []
  );

  const handleScroll = () => {
    const host = hostRef.current;
    if (!host) return;
    const max = host.scrollHeight - host.clientHeight;
    if (max > 0) {
      onScrollRatioRef.current?.(host.scrollTop / max);
    }
  };

  const html = useMemo(
    () => renderMarkdown(source, docPath, (absolute) => assetUrl(absolute, 0)),
    [source, docPath]
  );

  // 换文档或重渲染后把滚动位置拉回顶部，免得接着上一篇的位置。
  useEffect(() => {
    hostRef.current?.scrollTo({ top: 0 });
  }, [docPath]);

  // 摘掉我们套进去的 <mark>，把文本节点还原回去，再合并相邻文本恢复原结构。
  const clearMarks = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const marks = host.querySelectorAll<HTMLElement>(`mark.${MARK_CLASS}`);
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    });
    host.normalize();
    marksRef.current = [];
  }, []);

  // 滚到某一处命中：给它挂活动类，其余去掉，再滚到视野中央。
  const gotoMatch = useCallback((index: number, smooth = false) => {
    const marks = marksRef.current;
    if (marks.length === 0) return;
    const wrapped = ((index % marks.length) + marks.length) % marks.length;
    activeRef.current = wrapped;
    marks.forEach((mark, position) => mark.classList.toggle("is-active", position === wrapped));
    marks[wrapped].scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
    setMatchCount({ total: marks.length, active: wrapped + 1 });
  }, []);

  // 按当前关键词重扫一遍正文：先清旧的，再逐文本节点套 <mark>。
  const runFind = useCallback(() => {
    clearMarks();
    const host = hostRef.current;
    if (!findOpen || !host || !findQuery) {
      setMatchCount({ total: 0, active: 0 });
      return;
    }
    const re = buildFindRegex(findQuery, findOptions);
    if (!re) {
      setMatchCount({ total: 0, active: 0 });
      return;
    }
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

    const collected: HTMLElement[] = [];
    for (const node of textNodes) {
      const text = node.nodeValue ?? "";
      if (!text) continue;
      re.lastIndex = 0;
      const ranges: { start: number; end: number }[] = [];
      let match: RegExpExecArray | null;
      while ((match = re.exec(text))) {
        if (match[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        ranges.push({ start: match.index, end: match.index + match[0].length });
      }
      if (ranges.length === 0) continue;

      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const range of ranges) {
        if (range.start > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, range.start)));
        }
        const mark = document.createElement("mark");
        mark.className = MARK_CLASS;
        mark.dataset.mdFind = "1";
        mark.textContent = text.slice(range.start, range.end);
        fragment.appendChild(mark);
        collected.push(mark);
        cursor = range.end;
      }
      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }
      node.parentNode?.replaceChild(fragment, node);
    }

    marksRef.current = collected;
    if (collected.length === 0) {
      setMatchCount({ total: 0, active: 0 });
    } else {
      gotoMatch(0);
    }
  }, [clearMarks, findOpen, findQuery, findOptions, gotoMatch]);

  // 关键词 / 开关 / 正文变了都重扫；关闭查找条时清干净高亮。
  useEffect(() => {
    runFind();
  }, [runFind, html]);

  useEffect(() => {
    if (!findOpen) {
      clearMarks();
      setMatchCount({ total: 0, active: 0 });
    }
  }, [findOpen, clearMarks]);

  // 打开查找条时聚焦输入框（供外部按钮与 Ctrl+F 共用）。
  useEffect(() => {
    if (findOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [findOpen]);

  const closeFind = () => setFindOpen(false);

  const selectAll = () => {
    const host = hostRef.current;
    if (!host) return;
    const range = document.createRange();
    range.selectNodeContents(host);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const anchor = target.closest("a");
    const img = target.closest("img");
    const pre = target.closest("pre");
    const selection = window.getSelection();
    const selectedText = selection ? selection.toString() : "";
    const hasSelection = selectedText.length > 0;

    const items: MenuItem[] = [];

    // 若右击在链接上：优先提供链接相关操作
    if (anchor) {
      const local = anchor.dataset.local;
      const href = anchor.getAttribute("href") ?? "";
      items.push({
        label: t("preview.openLink"),
        onSelect: () => {
          if (local) {
            onOpenLocal(local);
          } else if (/^(https?:|mailto:|tel:)/i.test(href)) {
            void openExternal(href).catch(() => {});
          }
        },
      });
      items.push({
        label: t("preview.copyLink"),
        onSelect: () => {
          const targetUrl = local || href;
          if (targetUrl) void navigator.clipboard.writeText(targetUrl);
        },
      });
      items.push({ separator: true });
    }

    // 若右击在图片上：提供复制图片地址
    if (img) {
      const src = img.getAttribute("src") ?? "";
      if (src) {
        items.push({
          label: t("preview.copyImage"),
          onSelect: () => void navigator.clipboard.writeText(src),
        });
        items.push({ separator: true });
      }
    }

    // 复制选区或复制代码块
    if (hasSelection) {
      items.push({
        label: t("action.copy"),
        onSelect: () => void navigator.clipboard.writeText(selectedText),
      });
    } else if (pre) {
      items.push({
        label: t("preview.copyCode"),
        onSelect: () => {
          const codeText = pre.innerText || pre.textContent || "";
          if (codeText) void navigator.clipboard.writeText(codeText);
        },
      });
    } else {
      items.push({
        label: t("action.copy"),
        disabled: true,
      });
    }

    items.push({
      label: t("action.selectAll"),
      onSelect: selectAll,
    });

    // 切换到源码视图
    if (onToggleSource) {
      items.push({ separator: true });
      items.push({
        label: t("preview.source"),
        onSelect: onToggleSource,
      });
    }

    setMenu({
      x: event.clientX,
      y: event.clientY,
      items,
    });
  };

  const toggleOption = (key: keyof FindOptions) =>
    setFindOptions((current) => ({ ...current, [key]: !current[key] }));

  const findLabel =
    findQuery && matchCount.total === 0
      ? t("terminal.findNoResults")
      : matchCount.total > 0
        ? `${matchCount.active}/${matchCount.total}`
        : "";

  return (
    <>
      {findOpen ? (
        <div className="md-find" role="search">
          <input
            ref={inputRef}
            className="md-find-input"
            value={findQuery}
            placeholder={t("preview.find")}
            aria-label={t("preview.find")}
            spellCheck={false}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                gotoMatch(event.shiftKey ? activeRef.current - 1 : activeRef.current + 1, true);
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeFind();
              }
            }}
          />
          <span className={`md-find-count${findQuery && matchCount.total === 0 ? " is-empty" : ""}`}>
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
          <span className="md-find-sep" aria-hidden="true" />
          <button
            type="button"
            className="icon-button is-inline"
            disabled={matchCount.total === 0}
            title={`${t("terminal.findPrevious")} (Shift+Enter)`}
            onClick={() => gotoMatch(activeRef.current - 1, true)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="icon-button is-inline"
            disabled={matchCount.total === 0}
            title={`${t("terminal.findNext")} (Enter)`}
            onClick={() => gotoMatch(activeRef.current + 1, true)}
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            className="icon-button is-inline"
            title={`${t("terminal.findClose")} (Esc)`}
            onClick={closeFind}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      <div
        ref={hostRef}
        tabIndex={-1}
        className="markdown-body"
        onScroll={handleScroll}
        onContextMenu={handleContextMenu}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
            if (event.key.toLowerCase() === "f") {
              event.preventDefault();
              setFindOpen(true);
              return;
            }
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
            const active = document.activeElement;
            if (active?.tagName !== "INPUT" && active?.tagName !== "TEXTAREA") {
              event.preventDefault();
              selectAll();
            }
          }
          if (event.key === "Escape" && findOpen) {
            event.preventDefault();
            closeFind();
          }
        }}
        onClick={(event) => {
          const anchor = (event.target as HTMLElement).closest("a");
          if (!anchor) return;
          const local = anchor.dataset.local;
          if (local) {
            event.preventDefault();
            onOpenLocal(local);
            return;
          }
          if (anchor.dataset.external) {
            // 外链不在应用内开：webview 里跳走就回不来了，交给系统浏览器。
            // 只放行真正可交给系统的协议；被净化掉 href 的链接（如 javascript:）
            // 没有 href，不能拿空串去起进程。
            const href = anchor.getAttribute("href") ?? "";
            if (/^(https?:|mailto:|tel:)/i.test(href)) {
              event.preventDefault();
              void openExternal(href).catch(() => {});
            }
          }
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
});
