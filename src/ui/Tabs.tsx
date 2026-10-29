/**
 * 标签页条（Tabs Strip），遵循 JetBrains 现代化药丸标签风格。
 * 支持键盘巡航（←/→ 或纵向模式下的 ↑/↓、Home/End）、可关闭标签（按钮、中键、Delete 键）、
 * 鼠标滚轮横向滚动，以及溢出时的全部标签下拉列表。
 */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { Icon, type LucideIconType } from "./Icon";
import { IconButton } from "./Button";
import { Menu, type MenuItem } from "./Menu";
import { tooltipAttrs } from "./Tooltip";
import { registerDropTarget, startPointerDrag } from "./pointerDrag";
import styles from "./Tabs.module.css";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** 当 label 不是纯文本时，溢出菜单与首字母检索使用的纯文本 */
  text?: string;
  icon?: string | LucideIconType | ReactNode;
  closable?: boolean;
  /** 未保存修改圆点标记 */
  modified?: boolean;
  /** 标签文本颜色（如 VCS 状态色） */
  color?: string;
  /** 标签背景淡底色（文件颜色分类） */
  tint?: string;
  italic?: boolean;
  tooltip?: string;
  /** 尾部插槽（计数器、徽标） */
  trailing?: ReactNode;
}

/** 标签拖拽 DND 配置 */
export interface TabsDnd {
  type: string;
  payload: (id: string) => string;
  onDrop: (payload: string, index: number) => void;
}

/** 计算放置索引 */
export function dropIndex(x: number, rects: ReadonlyArray<{ left: number; width: number }>): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (x < r.left + r.width / 2) return i;
  }
  return rects.length;
}

export interface TabStripHandle {
  closeSelected(): boolean;
}

export const TabStripRegistry = createContext<((handle: TabStripHandle) => () => void) | null>(null);

export interface TabsProps {
  items: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  /** Alt+点击关闭按钮（关闭其他标签页） */
  onCloseOthers?: (id: string) => void;
  onDoubleClick?: (id: string) => void;
  onContextMenu?: (id: string, e: MouseEvent) => void;
  /** `editor`: 32px 编辑器标签; `compact`: 28px 紧凑工具窗标签 */
  variant?: "editor" | "compact";
  /** 标签条右侧尾部扩展内容（动作按钮、面包屑等） */
  trailing?: ReactNode;
  className?: string;
  "aria-label"?: string;
  panelIdPrefix?: string;
  dnd?: TabsDnd;
  /** 标签超出可视宽度时的排版：`scroll` 滚动条, `squeeze` 挤压宽度, `wrap` 折行 */
  layout?: "scroll" | "squeeze" | "wrap";
  closePosition?: "right" | "left";
  orientation?: "horizontal" | "vertical";
}

export function Tabs({
  items,
  activeId,
  onSelect,
  onClose,
  onCloseOthers,
  onDoubleClick,
  onContextMenu,
  variant = "editor",
  trailing,
  className,
  panelIdPrefix,
  dnd,
  layout = "scroll",
  closePosition = "right",
  orientation = "horizontal",
  ...aria
}: TabsProps) {
  const vertical = orientation === "vertical";
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [overflow, setOverflow] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const register = useContext(TabStripRegistry);
  const latest = useRef({ items, activeId, onClose });
  useLayoutEffect(() => {
    latest.current = { items, activeId, onClose };
  });

  useEffect(
    () =>
      register?.({
        closeSelected: () => {
          const { items, activeId, onClose } = latest.current;
          const item = items.find((it) => it.id === activeId);
          if (!item || !onClose || item.closable === false) return false;
          onClose(item.id);
          return true;
        },
      }),
    [register]
  );

  const stripRef = useRef<HTMLDivElement>(null);
  const dropState = useRef({ items, dnd, vertical });
  useLayoutEffect(() => {
    dropState.current = { items, dnd, vertical };
  });

  const dndType = dnd?.type;
  useEffect(() => {
    const el = stripRef.current;
    if (!el || !dndType) return;
    const indexAt = (x: number, y: number) => {
      const { items, vertical } = dropState.current;
      return dropIndex(
        vertical ? y : x,
        items.map((it) => {
          const r = tabRefs.current.get(it.id)?.parentElement?.getBoundingClientRect();
          return vertical
            ? { left: r?.top ?? 0, width: r?.height ?? 0 }
            : { left: r?.left ?? 0, width: r?.width ?? 0 };
        })
      );
    };
    return registerDropTarget(el, {
      accepts: (type) => type === dropState.current.dnd?.type,
      over: (_, x, y) => setDrop(indexAt(x, y)),
      leave: () => setDrop(null),
      drop: (data, x, y) => {
        setDrop(null);
        dropState.current.dnd?.onDrop(data.payload, indexAt(x, y));
      },
    });
  }, [dndType]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setOverflow(!vertical && el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length, vertical]);

  useEffect(() => {
    const tab = activeId ? tabRefs.current.get(activeId)?.parentElement : null;
    const scroller = scrollRef.current;
    if (tab && scroller) {
      (vertical ? revealVertically : revealHorizontally)(scroller, tab);
    }
  }, [activeId, vertical]);

  const focusTab = (index: number) => {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    onSelect(item.id);
    tabRefs.current.get(item.id)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, index: number, item: TabItem) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case vertical ? "ArrowDown" : "ArrowRight":
        focusTab(index + 1);
        break;
      case vertical ? "ArrowUp" : "ArrowLeft":
        focusTab(index - 1);
        break;
      case "Home":
        focusTab(0);
        break;
      case "End":
        focusTab(items.length - 1);
        break;
      case "Delete":
      case "Backspace":
        if (onClose && item.closable !== false) onClose(item.id);
        else return;
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const menuItems: MenuItem[] = items.map((t) => ({
    id: t.id,
    label: t.text ?? (typeof t.label === "string" ? t.label : t.id),
    icon: t.icon,
    checked: t.id === activeId ? true : undefined,
    run: () => onSelect(t.id),
  }));

  return (
    <div
      className={clsx(
        styles.strip,
        styles[variant],
        vertical ? styles.vertical : layout !== "scroll" && styles[layout],
        closePosition === "left" && styles.closeLeft,
        className
      )}
      ref={stripRef}
    >
      {vertical && trailing && <div className={styles.trailing}>{trailing}</div>}
      <div
        ref={scrollRef}
        role="tablist"
        aria-label={aria["aria-label"]}
        aria-orientation={vertical ? "vertical" : undefined}
        className={styles.scroller}
        onWheel={(e) => {
          const el = scrollRef.current;
          if (el && !vertical && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            el.scrollLeft += e.deltaY;
          }
        }}
      >
        {items.map((item, index) => {
          const selected = item.id === activeId;
          const closable = !!onClose && item.closable !== false;
          return (
            <div
              key={item.id}
              className={clsx(
                styles.tab,
                selected && styles.selected,
                closable && styles.closable,
                dragging === item.id && styles.dragging,
                drop === index && styles.dropBefore,
                drop === items.length && index === items.length - 1 && styles.dropAfter,
                item.tint && styles.tinted
              )}
              style={item.tint ? ({ "--tab-tint": item.tint } as CSSProperties) : undefined}
              onPointerDown={
                dnd
                  ? (e) => {
                      if ((e.target as Element).closest("[data-tab-close]")) return;
                      startPointerDrag(
                        e,
                        e.currentTarget,
                        { type: dnd.type, payload: dnd.payload(item.id) },
                        {
                          onStart: () => setDragging(item.id),
                          onEnd: () => setDragging(null),
                        }
                      );
                    }
                  : undefined
              }
              onMouseDown={(e) => {
                if (e.button === 1 && closable) {
                  e.preventDefault();
                  onClose!(item.id);
                }
              }}
              onContextMenu={onContextMenu ? (e) => onContextMenu(item.id, e) : undefined}
            >
              <button
                ref={(el) => {
                  if (el) tabRefs.current.set(item.id, el);
                  else tabRefs.current.delete(item.id);
                }}
                type="button"
                role="tab"
                id={panelIdPrefix ? `${panelIdPrefix}-tab-${item.id}` : undefined}
                aria-controls={panelIdPrefix ? `${panelIdPrefix}-panel-${item.id}` : undefined}
                aria-selected={selected}
                tabIndex={selected || (!activeId && index === 0) ? 0 : -1}
                className={styles.tabButton}
                style={item.color ? { color: item.color } : undefined}
                onClick={() => onSelect(item.id)}
                onDoubleClick={onDoubleClick ? () => onDoubleClick(item.id) : undefined}
                onKeyDown={(e) => onKeyDown(e, index, item)}
                {...tooltipAttrs(item.tooltip)}
              >
                {item.icon && <Icon icon={item.icon} size={14} className={styles.tabIcon} />}
                <span className={clsx(styles.tabLabel, item.italic && styles.italic)}>
                  {item.label}
                </span>
                {item.trailing}
                {item.modified && !closable && <span className={styles.modified} aria-label="已修改" />}
              </button>
              {closable && (
                <span className={styles.closeSlot} data-tab-close>
                  {item.modified && <span className={styles.modified} aria-label="已修改" />}
                  <IconButton
                    icon="close"
                    title="关闭标签"
                    size="small"
                    iconSize={11}
                    tabIndex={-1}
                    className={styles.close}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (e.altKey && onCloseOthers) onCloseOthers(item.id);
                      else onClose!(item.id);
                    }}
                  />
                </span>
              )}
            </div>
          );
        })}
      </div>
      {overflow && (
        <>
          <IconButton
            ref={moreRef}
            icon="chevron-down"
            title="显示更多标签"
            size="small"
            iconSize={12}
            className={styles.more}
            onClick={() => setMenuOpen((v) => !v)}
          />
          <Menu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchor={moreRef}
            items={menuItems}
            placement="bottom-end"
            aria-label="更多标签"
          />
        </>
      )}
      {!vertical && trailing && <div className={styles.trailing}>{trailing}</div>}
    </div>
  );
}

/** 水平滚动容器以展示目标节点全部内容 */
export function revealHorizontally(scroller: HTMLElement, child: HTMLElement) {
  const s = scroller.getBoundingClientRect();
  const c = child.getBoundingClientRect();
  if (c.left < s.left) scroller.scrollLeft -= s.left - c.left;
  else if (c.right > s.right) scroller.scrollLeft += Math.min(c.right - s.right, c.left - s.left);
}

/** 垂直滚动容器以展示目标节点全部内容 */
export function revealVertically(scroller: HTMLElement, child: HTMLElement) {
  const s = scroller.getBoundingClientRect();
  const c = child.getBoundingClientRect();
  if (c.top < s.top) scroller.scrollTop -= s.top - c.top;
  else if (c.bottom > s.bottom) scroller.scrollTop += Math.min(c.bottom - s.bottom, c.top - s.top);
}
