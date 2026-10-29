import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { ChevronDown, ChevronRight, Check } from "lucide-react";
import { SearchField, Button } from "../../../ui";
import {
  SETTINGS_TREE,
  filterSettingsTree,
  getPageBreadcrumb,
  type SettingsTreeNode,
} from "../model/settingsModel";
import styles from "./SettingsLayout.module.css";

export interface SettingsLayoutProps {
  activePageId: string;
  onSelectPage: (pageId: string) => void;
  onClose?: () => void;
  onResetAll?: () => void;
  onApply?: () => void;
  hasDirtySettings?: boolean;
  headerActions?: ReactNode;
  children: ReactNode;
}

/**
 * IDEA 风格设置页主布局组件
 * 左侧搜索 + 分类树，右侧面包屑 + 设置内容视口 + 底部操作栏
 */
export function SettingsLayout({
  activePageId,
  onSelectPage,
  onClose,
  onResetAll,
  onApply,
  hasDirtySettings = false,
  headerActions,
  children,
}: SettingsLayoutProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    appearance: true,
    editor: true,
    tools: true,
    "tools.ai": true,
  });
  const [savedFeedback, setSavedFeedback] = useState(false);

  // 搜索树节点过滤
  const filteredTree = useMemo(() => {
    return filterSettingsTree(SETTINGS_TREE, query);
  }, [query]);

  // 当搜索有内容时，自动展开所有匹配的分支
  useEffect(() => {
    if (query.trim()) {
      const allKeys: Record<string, boolean> = {};
      function expandAll(nodes: SettingsTreeNode[]) {
        for (const n of nodes) {
          allKeys[n.id] = true;
          if (n.children) expandAll(n.children);
        }
      }
      expandAll(filteredTree);
      setExpanded((prev) => ({ ...prev, ...allKeys }));
    }
  }, [query, filteredTree]);

  const toggleExpand = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const breadcrumb = useMemo(() => {
    return getPageBreadcrumb(activePageId) ?? ["设置"];
  }, [activePageId]);

  const handleApply = () => {
    onApply?.();
    setSavedFeedback(true);
    setTimeout(() => setSavedFeedback(false), 2000);
  };

  /** 递归渲染树节点 */
  const renderTreeNode = (node: SettingsTreeNode, depth = 0) => {
    const hasChildren = node.children && node.children.length > 0;
    const isExpanded = expanded[node.id] ?? false;
    const isSelected = node.pageId === activePageId;
    const isMatched =
      Boolean(query.trim()) &&
      (node.title.toLowerCase().includes(query.toLowerCase()) ||
        node.keywords?.some((k) => k.toLowerCase().includes(query.toLowerCase())));

    return (
      <div key={node.id} className={styles.treeGroup}>
        <button
          type="button"
          className={clsx(
            styles.treeItem,
            isSelected && styles.active,
            isMatched && styles.matched
          )}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => {
            if (node.pageId) {
              onSelectPage(node.pageId);
            } else if (hasChildren) {
              setExpanded((prev) => ({ ...prev, [node.id]: !prev[node.id] }));
            }
          }}
        >
          {hasChildren ? (
            <span
              className={styles.treeExpander}
              onClick={(e) => toggleExpand(node.id, e)}
              aria-label={isExpanded ? "折叠" : "展开"}
            >
              {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          ) : (
            <span className={styles.treeExpanderSpacer} />
          )}

          <span className={styles.treeLabel} title={node.title}>
            {node.title}
          </span>
        </button>

        {hasChildren && isExpanded && (
          <div className={styles.treeSub}>
            {node.children!.map((child) => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.container}>
      {/* 左侧侧边栏 */}
      <aside className={styles.sidebar}>
        <div className={styles.searchWrap}>
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="搜索设置项 (Ctrl+F)..."
            clearable
          />
        </div>

        <nav className={styles.treeScroll} aria-label="设置导航树">
          {filteredTree.map((rootNode) => renderTreeNode(rootNode, 0))}
        </nav>
      </aside>

      {/* 右侧主工作区 */}
      <main className={styles.main}>
        {/* 面包屑标题栏 */}
        <header className={styles.header}>
          <div className={styles.breadcrumb}>
            {breadcrumb.map((segment, index) => {
              const isLast = index === breadcrumb.length - 1;
              return (
                <span key={segment} className={clsx(isLast && styles.breadcrumbCurrent)}>
                  {segment}
                  {!isLast && " › "}
                </span>
              );
            })}
          </div>

          <div className={styles.headerActions}>
            {headerActions}
            {onResetAll && (
              <Button
                variant="ghost"
                size="small"
                onClick={onResetAll}
                title="恢复所有默认设置"
              >
                恢复默认
              </Button>
            )}
          </div>
        </header>

        {/* 动态页面内容 */}
        <section className={styles.content}>{children}</section>

        {/* 底部操作工具栏 */}
        <footer className={styles.footer}>
          <div className={styles.footerStatus}>
            {savedFeedback ? (
              <span className={styles.footerStatusSaved}>
                <Check size={14} style={{ display: "inline", verticalAlign: "middle" }} /> 已应用设置
              </span>
            ) : hasDirtySettings ? (
              <span>存在未生效的修改</span>
            ) : (
              <span>设置实时保存并持久化</span>
            )}
          </div>

          <div className={styles.footerButtons}>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                handleApply();
                onClose?.();
              }}
            >
              确定
            </Button>
            {onClose ? (
              <Button variant="secondary" size="small" onClick={onClose}>
                取消
              </Button>
            ) : null}
            <Button variant="primary" size="small" onClick={handleApply}>
              应用
            </Button>
          </div>
        </footer>
      </main>
    </div>
  );
}

export default SettingsLayout;
