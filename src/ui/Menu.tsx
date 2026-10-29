import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { Icon, type LucideIconType } from "./Icon";
import { Popup, type PopupAnchor } from "./Popup";
import type { Placement } from "@floating-ui/react-dom";
import styles from "./Menu.module.css";

export type MenuItem =
  | { kind: "separator" }
  | { kind: "header"; label: string }
  | {
      kind?: "item";
      id?: string;
      label: string;
      icon?: string | LucideIconType | ReactNode;
      shortcut?: string;
      disabled?: boolean;
      checked?: boolean;
      danger?: boolean;
      hint?: string;
      title?: string;
      run?: () => void;
      submenu?: MenuItem[];
    };

interface ResolvedItem {
  kind: "item" | "separator" | "header";
  key: string;
  label: string;
  icon?: string | LucideIconType | ReactNode;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  hint?: string;
  title?: string;
  run?: () => void;
  submenu?: MenuItem[];
}

export function resolveMenuItems(items: MenuItem[]): ResolvedItem[] {
  const out: ResolvedItem[] = [];
  items.forEach((item, i) => {
    if (item.kind === "separator") {
      if (out.length && out[out.length - 1]!.kind !== "separator") {
        out.push({ kind: "separator", key: `sep${i}`, label: "" });
      }
      return;
    }
    if (item.kind === "header") {
      out.push({ kind: "header", key: `h${i}`, label: item.label });
      return;
    }
    out.push({
      ...item,
      label: item.label,
      kind: "item",
      key: item.id ?? `${i}:${item.label}`,
    });
  });
  while (out.length && out[out.length - 1]!.kind === "separator") out.pop();
  return out;
}

const selectable = (r: ResolvedItem | undefined) => !!r && r.kind === "item" && !r.disabled;

export interface MenuListProps {
  items: MenuItem[];
  onDone: () => void;
  onCloseLevel?: () => void;
  "aria-label"?: string;
  autoFocusFirst?: boolean;
}

export function MenuList({
  items,
  onDone,
  onCloseLevel,
  autoFocusFirst = true,
  ...aria
}: MenuListProps) {
  const resolved = resolveMenuItems(items);
  const [active, setActive] = useState(() => (autoFocusFirst ? resolved.findIndex(selectable) : -1));
  const [openSub, setOpenSubIndex] = useState<number | null>(null);
  const [subAnchor, setSubAnchor] = useState<HTMLElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setOpenSub = (i: number | null) => {
    setSubAnchor(i === null ? null : (itemRefs.current[i] ?? null));
    setOpenSubIndex(i);
  };

  useLayoutEffect(() => {
    if (active >= 0 && openSub === null) itemRefs.current[active]?.focus({ preventScroll: false });
  }, [active, openSub]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const move = (delta: number, from = active) => {
    const n = resolved.length;
    if (!n) return;
    let i = from;
    for (let step = 0; step < n; step++) {
      i = (i + delta + n) % n;
      if (selectable(resolved[i])) {
        setActive(i);
        return;
      }
    }
  };

  const activate = (i: number) => {
    const item = resolved[i];
    if (!selectable(item)) return;
    if (item!.submenu) {
      setActive(i);
      setOpenSub(i);
      return;
    }
    onDone();
    item!.run?.();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1, active < 0 ? 0 : active);
        break;
      case "Home":
        move(1, -1);
        break;
      case "End":
        move(-1, 0);
        break;
      case "ArrowRight":
        if (resolved[active]?.submenu) setOpenSub(active);
        else return;
        break;
      case "ArrowLeft":
        if (onCloseLevel) onCloseLevel();
        else return;
        break;
      case "Enter":
      case " ":
        activate(active);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div role="menu" aria-label={aria["aria-label"]} className={styles.menu} onKeyDown={onKeyDown}>
      {resolved.map((r, i) => {
        if (r.kind === "separator") return <div key={r.key} role="separator" className={styles.separator} />;
        if (r.kind === "header") {
          return (
            <div key={r.key} role="presentation" className={styles.header}>
              {r.label}
            </div>
          );
        }
        const hasSub = !!r.submenu;
        return (
          <Fragment key={r.key}>
            <button
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role={r.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={r.checked}
              aria-disabled={r.disabled || undefined}
              aria-haspopup={hasSub ? "menu" : undefined}
              aria-expanded={hasSub ? openSub === i : undefined}
              title={r.hint ?? r.title}
              tabIndex={i === active ? 0 : -1}
              className={clsx(
                styles.item,
                i === active && styles.active,
                r.disabled && styles.disabled,
                r.danger && styles.danger
              )}
              onPointerEnter={() => {
                if (r.disabled) return;
                setActive(i);
                clearTimeout(hoverTimer.current);
                hoverTimer.current = setTimeout(() => setOpenSub(hasSub ? i : null), hasSub ? 120 : 200);
              }}
              onClick={() => activate(i)}
            >
              <span className={styles.icon}>
                {r.checked ? <Icon icon="check" size={13} /> : r.icon ? <Icon icon={r.icon} size={14} /> : null}
              </span>
              <span className={styles.label}>{r.label}</span>
              {r.shortcut && <span className={styles.shortcut}>{r.shortcut}</span>}
              {hasSub && <Icon icon="chevron-right" size={14} className={styles.subArrow} />}
            </button>
            {hasSub && openSub === i && subAnchor && (
              <Popup
                open
                anchor={subAnchor}
                placement="right-start"
                offset={2}
                role="presentation"
                autoFocus={false}
                onClose={() => setOpenSub(null)}
                className={styles.popup}
              >
                <MenuList
                  items={r.submenu!}
                  onDone={onDone}
                  onCloseLevel={() => {
                    setOpenSub(null);
                    itemRefs.current[i]?.focus();
                  }}
                />
              </Popup>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  anchor: PopupAnchor;
  items: MenuItem[];
  placement?: Placement;
  "aria-label"?: string;
}

/** 锚定在元素或坐标上的下拉/弹出菜单 */
export function Menu({
  open,
  onClose,
  anchor,
  items,
  placement = "bottom-start",
  ...aria
}: MenuProps) {
  return (
    <Popup
      open={open}
      onClose={onClose}
      anchor={anchor}
      placement={placement}
      role="presentation"
      autoFocus={false}
      className={styles.popup}
    >
      <MenuList items={items} onDone={onClose} aria-label={aria["aria-label"]} />
    </Popup>
  );
}
