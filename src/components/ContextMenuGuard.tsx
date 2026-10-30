import { useSyncExternalStore } from "react";
import ContextMenu, { type MenuAnchor } from "./ContextMenu";
import { contextMenuGuard } from "../lib/contextMenuGuard";

/**
 * 全局右键兜底菜单的渲染宿主（挂 App 顶层一次）：
 * 右键守卫把未接手、落在可读文本上的右键转成这里的「复制」菜单。
 */
export function ContextMenuGuardHost() {
  const menu = useSyncExternalStore(
    contextMenuGuard.subscribe,
    contextMenuGuard.get,
    () => null
  );
  if (!menu) return null;
  return <ContextMenu anchor={menu as MenuAnchor} onClose={contextMenuGuard.close} />;
}
