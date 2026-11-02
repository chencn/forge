import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ChevronRight } from "lucide-react";
import { outlineSnapshot, subscribeOutline, symbolChain, type OutlineSymbol } from "../lib/editorOutline";
import { tooltipAttrs } from "../ui/Tooltip";
import { useI18n } from "../i18n";
import SymbolIcon from "./SymbolIcon";

export function useCodeOutline(path: string) {
  const subscribe = useCallback((notify: () => void) => subscribeOutline(path, notify), [path]);
  const snapshot = useCallback(() => outlineSnapshot(path), [path]);
  const outline = useSyncExternalStore(subscribe, snapshot);
  const chain = useMemo(() => symbolChain(outline.items, outline.position), [outline]);
  return { ...outline, chain };
}

/** 编辑器按需加载，底栏不把 CodeMirror 拉入启动包。偏移取编辑器最新正文。 */
export async function openOutlineSymbol(path: string, item: OutlineSymbol): Promise<void> {
  const { editorFor, revealRange } = await import("../lib/cmEditor");
  const view = editorFor(path);
  if (!view) return;
  const position = Math.min(item.selectionFrom, view.state.doc.length);
  const line = view.state.doc.lineAt(position);
  // 先恢复编辑器焦点，使选区事务同时更新行列状态。
  view.focus();
  revealRange(view, line.number, position - line.from, position - line.from);
}

/** 对齐 OpenIDEA 的编辑器内符号链：点击声明直接定位，独立于全局路径导航。 */
export default function CodeBreadcrumbs({ path }: { path: string }) {
  const { t } = useI18n();
  const { chain } = useCodeOutline(path);
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    // 长链自动露出光标所在的末段；仍允许横向滚动查看外层作用域。
    const nav = navRef.current;
    if (nav) nav.scrollLeft = nav.scrollWidth;
  }, [chain]);
  if (!chain.length) return null;
  return (
    <nav ref={navRef} className="code-crumbs" aria-label={t("breadcrumb.code")}>
      {chain.map((item, index) => (
        <span key={`${item.from}:${item.name}`} className="status-crumb-pair">
          {index > 0 ? <ChevronRight size={12} className="status-crumb-sep" aria-hidden="true" /> : null}
          <button type="button" className="status-crumb" {...tooltipAttrs(item.name)} onClick={() => void openOutlineSymbol(path, item)}>
            <SymbolIcon kind={item.kind} size={14} />
            <span className="status-crumb-label">{item.name}</span>
          </button>
        </span>
      ))}
    </nav>
  );
}
