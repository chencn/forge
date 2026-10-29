import { useMemo } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Menu as UiMenu, type MenuItem as UiMenuItem } from "../ui/Menu";
import type { LucideIconType } from "../ui/Icon";

export interface MenuItem {
  /** 菜单文案；分隔线项不写文案。 */
  label?: string;
  /** 分隔线：只画一条细横线，不吃点击。 */
  separator?: boolean;
  /** 右侧灰字快捷键，画了就必须真绑了键。 */
  shortcut?: string;
  /** 左侧图标，缺省则留空对齐。 */
  icon?: LucideIcon | LucideIconType | string | ReactNode;
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

/** 把分组后的菜单摊平：空组丢掉，组与组之间才画分隔线。 */
export function flatMenu(groups: MenuItem[][]): MenuItem[] {
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ separator: true }, ...group]));
}

/**
 * 将业务 MenuItem 转换为设计系统标准 UiMenuItem 格式
 */
function toUiMenuItem(item: MenuItem): UiMenuItem {
  if (item.separator) {
    return { kind: "separator" };
  }
  return {
    kind: "item",
    label: item.label ?? "",
    icon: item.icon as string | LucideIconType | ReactNode,
    shortcut: item.shortcut,
    disabled: item.disabled,
    checked: item.checked,
    danger: item.danger,
    run: item.onSelect,
    submenu: item.children ? item.children.map(toUiMenuItem) : undefined,
  };
}

/**
 * 右键上下文菜单组件
 * 内部已平滑升级为基于 floating-ui 的设计系统 UI 组件，
 * 获得自动视口边缘避让、子菜单平滑防抖展开以及全局层级栈控制。
 */
export default function ContextMenu({
  anchor,
  onClose,
}: {
  anchor: MenuAnchor;
  onClose: () => void;
}) {
  const uiItems = useMemo(() => anchor.items.map(toUiMenuItem), [anchor.items]);

  return (
    <UiMenu
      open={true}
      onClose={onClose}
      anchor={{ x: anchor.x, y: anchor.y }}
      items={uiItems}
      placement="bottom-start"
    />
  );
}
