import { isValidElement, type ComponentType, type ReactNode } from "react";
import {
  LibraryIcon,
  ScratchesIcon,
  LocateIcon,
  CollapseAllIcon,
  ExpandAllIcon,
  ModuleIcon,
  HideIcon,
} from "./icons/ProjectIcons";
import {
  X,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Search,
  Copy,
  Settings,
  Plus,
  Minus,
  RefreshCw,
  Folder,
  File,
  AlertTriangle,
  Info,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Maximize2,
  Minimize2,
  Terminal,
  Code2,
  Play,
  Square,
  MoreHorizontal,
  MoreVertical,
  Filter,
  Trash2,
  Archive,
  Bell,
  Undo2,
  ArrowDownToLine,
  Eye,
  History,
  List,
} from "lucide-react";

export type LucideIconType = ComponentType<{
  size?: number | string;
  color?: string;
  className?: string;
  strokeWidth?: number | string;
}>;

/**
 * 常用操作到 Lucide 图标的名称映射表。
 *
 * 这里**必须**是唯一的字符串名入口：早先还留了一条「查不到就去 `import * as LucideIcons`
 * 全量导出里翻」的兜底，那一个命名空间导入就让 tree-shaking 彻底失效，把 lucide 全部
 * 图标（实测产物里 800KB / gzip 205KB）打进了启动 chunk。全库会走字符串分支的名字已经
 * 逐点核对过，全部落在这张表里；新增图标名请具名导入后补进本表。
 */
const ICON_NAME_MAP: Record<string, LucideIconType> = {
  close: X,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  search: Search,
  copy: Copy,
  settings: Settings,
  plus: Plus,
  minus: Minus,
  refresh: RefreshCw,
  folder: Folder,
  file: File,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
  help: HelpCircle,
  maximize: Maximize2,
  minimize: Minimize2,
  terminal: Terminal,
  code: Code2,
  run: Play,
  stop: Square,
  "more-horizontal": MoreHorizontal,
  "more-vertical": MoreVertical,
  more: MoreVertical,
  filter: Filter,
  trash: Trash2,
  stash: Archive,
  archive: Archive,
  bell: Bell,
  undo: Undo2 as unknown as LucideIconType,
  "arrow-down-to-line": ArrowDownToLine as unknown as LucideIconType,
  "git-pull": ArrowDownToLine as unknown as LucideIconType,
  eye: Eye as unknown as LucideIconType,
  history: History as unknown as LucideIconType,
  list: List as unknown as LucideIconType,
  library: LibraryIcon as unknown as LucideIconType,
  scratches: ScratchesIcon as unknown as LucideIconType,
  locate: LocateIcon as unknown as LucideIconType,
  "expand-all": ExpandAllIcon as unknown as LucideIconType,
  "collapse-all": CollapseAllIcon as unknown as LucideIconType,
  module: ModuleIcon as unknown as LucideIconType,
  hide: HideIcon as unknown as LucideIconType,
};

export interface IconProps {
  /** 可以是映射名，也可以直接是 Lucide 图标组件或任意 ReactNode */
  icon?: string | LucideIconType | ReactNode;
  name?: string;
  size?: number | string;
  className?: string;
  color?: string;
}

/**
 * 统一的 Lucide 图标渲染层，保证移植组件全部使用 Forge 统一的 Lucide 图标规范。
 */
export function Icon({ icon, name, size = 16, className, color }: IconProps) {
  const target = icon ?? name;
  if (!target) return null;

  // 如果已经是 React 元素（如 JSX）
  if (isValidElement(target)) {
    return target;
  }

  // 如果传入了 Lucide 图标组件（包含标准函数式、类或 React.forwardRef 对象）
  if (
    typeof target === "function" ||
    (typeof target === "object" && target !== null && "$$typeof" in (target as object))
  ) {
    const Component = target as unknown as ComponentType<any>;
    return <Component size={size} className={className} color={color} />;
  }

  // 如果传入了字符串名称：只认映射表，查不到就什么都不画。
  if (typeof target === "string") {
    const mapped = ICON_NAME_MAP[target.toLowerCase()];
    if (mapped) {
      const Component = mapped as unknown as ComponentType<any>;
      return <Component size={size} className={className} color={color} />;
    }
  }

  return null;
}
