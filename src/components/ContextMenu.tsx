import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Check, ChevronRight } from "lucide-react";

export interface MenuItem {
  /** 菜单文案；分隔线项不写文案。 */
  label?: string;
  /** 分隔线：只画一条细横线，不吃点击。 */
  separator?: boolean;
  /** 右侧灰字快捷键，画了就必须真绑了键。 */
  shortcut?: string;
  /** 左侧图标，缺省则留空对齐。 */
  icon?: LucideIcon;
  /** 危险动作（删除），用告警色绘制。 */
  danger?: boolean;
  /** 不可点，例如没有选中项时的重命名。 */
  disabled?: boolean;
  /** 点不动的原因，画在悬停提示里；IDEA 那套置灰项都带一句。 */
  hint?: string;
  /** 有子菜单：点这颗不关菜单，而是往右边展开一层。 */
  children?: MenuItem[];
  /** 勾选项：设置类菜单用，画在左侧图标位。 */
  checked?: boolean;
  onSelect?: () => void;
}

export interface MenuAnchor {
  /** 触发点视口坐标，来自右键事件的 clientX。 */
  x: number;
  y: number;
  items: MenuItem[];
}

const MENU_WIDTH = 244;
// 与 CSS 的 --menu-item-height 同步，DOM 尚未量到尺寸时定位也不能沿用旧的高行距。
const ITEM_HEIGHT = 28;
const SEP_HEIGHT = 9;
/** 指针从父层跨进子层要走过两层之间那条缝，这段时间里子层不能被判成「已离开」。 */
const SUBMENU_GRACE_MS = 220;

const menuHeight = (items: MenuItem[]) =>
  items.reduce((sum, item) => sum + (item.separator ? SEP_HEIGHT : ITEM_HEIGHT), 0) + 12;

/** 把分组后的菜单摊平：空组丢掉，组与组之间才画分隔线。 */
export function flatMenu(groups: MenuItem[][]): MenuItem[] {
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ separator: true }, ...group]));
}

/** 一层菜单。带 children 的那行点开在右侧再起一层，父层留着不关。 */
function MenuList({
  items,
  left,
  top,
  onClose,
  onPick,
  onEnter,
  onLeave,
}: {
  items: MenuItem[];
  left: number;
  top: number;
  onClose: () => void;
  /** 只有最外层传：选中末端动作时把整条菜单链关掉。 */
  onPick?: () => void;
  /** 只有子层传：指针进到子层时，父层那份「已离开」要撤回。 */
  onEnter?: () => void;
  onLeave?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left, top });
  /** 展开着的那层子菜单：行号与它自己的坐标。 */
  const [sub, setSub] = useState<{ index: number; left: number; top: number } | null>(null);
  const grace = useRef<number | null>(null);

  const hold = useCallback(() => {
    if (grace.current === null) return;
    window.clearTimeout(grace.current);
    grace.current = null;
  }, []);

  const drop = useCallback(() => {
    hold();
    grace.current = window.setTimeout(() => {
      grace.current = null;
      setSub(null);
    }, SUBMENU_GRACE_MS);
  }, [hold]);

  useEffect(
    () => () => {
      if (grace.current !== null) window.clearTimeout(grace.current);
    },
    []
  );

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    const height = box?.height ?? menuHeight(items);
    const width = box?.width ?? MENU_WIDTH;
    setPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
    });
  }, [left, top, items]);

  return (
    <>
      <div
        ref={ref}
        className="context-menu"
        role="menu"
        style={{ left: position.left, top: position.top }}
        onMouseEnter={() => {
          hold();
          onEnter?.();
        }}
        onMouseLeave={() => {
          drop();
          onLeave?.();
        }}
      >
        {items.map((item, index) =>
          item.separator ? (
            <div key={`sep-${index}`} className="menu-separator" role="separator" />
          ) : (
            <button
              key={`${item.label}-${index}`}
              type="button"
              role="menuitem"
              className={`menu-item${item.danger ? " is-danger" : ""}${
                sub?.index === index ? " is-open" : ""
              }`}
              disabled={item.disabled}
              title={item.hint}
              onMouseEnter={(event) => {
                hold();
                if (!item.children) {
                  if (sub !== null) setSub(null);
                  return;
                }
                const box = event.currentTarget.getBoundingClientRect();
                setSub({ index, left: box.right - 4, top: box.top - 6 });
              }}
              onClick={(event) => {
                if (item.children) {
                  const box = event.currentTarget.getBoundingClientRect();
                  setSub({ index, left: box.right - 4, top: box.top - 6 });
                  return;
                }
                if (onPick) onPick();
                else onClose();
                item.onSelect?.();
              }}
            >
              {item.icon ? (
                <item.icon size={15} aria-hidden="true" />
              ) : item.checked ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <span className="menu-icon-spacer" />
              )}
              <span className="menu-item-label">{item.label}</span>
              {item.shortcut ? <span className="menu-accel">{item.shortcut}</span> : null}
              {item.children ? <ChevronRight size={13} aria-hidden="true" /> : null}
            </button>
          )
        )}
      </div>
      {sub && items[sub.index]?.children ? (
        <MenuList
          items={items[sub.index].children ?? []}
          left={sub.left}
          top={sub.top}
          onClose={() => setSub(null)}
          onPick={onPick ?? onClose}
          onEnter={hold}
          onLeave={drop}
        />
      ) : null}
    </>
  );
}

export default function ContextMenu({ anchor, onClose }: { anchor: MenuAnchor; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div
        className="menu-overlay"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <MenuList items={anchor.items} left={anchor.x} top={anchor.y} onClose={onClose} />
    </>
  );
}
