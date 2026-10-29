/** 活动栏只允许在同一上下分组内排序；左右迁移不改变工具所属分组。 */
export type ToolRailSide = "left" | "right";
export type ToolRailGroup = "top" | "bottom";
export type ToolRailId =
  | "ai"
  | "browser"
  | "explorer"
  | "git"
  | "maven"
  | "terminal"
  | "run"
  | "log"
  | "notifications";

export interface ToolRailLayout {
  left: Record<ToolRailGroup, ToolRailId[]>;
  right: Record<ToolRailGroup, ToolRailId[]>;
}

const STORAGE_KEY = "forge:tool-rail-layout:v3";
const LEGACY_STORAGE_KEY = "forge:tool-rail-layout:v2";

export const TOOL_RAIL_GROUP: Record<ToolRailId, ToolRailGroup> = {
  notifications: "top",
  ai: "top",
  browser: "top",
  explorer: "top",
  git: "top",
  maven: "top",
  terminal: "bottom",
  run: "bottom",
  log: "bottom",
};

export const DEFAULT_TOOL_RAIL_LAYOUT: ToolRailLayout = {
  left: { top: ["explorer", "git"], bottom: ["terminal", "run", "log"] },
  right: { top: ["notifications", "ai", "browser", "maven"], bottom: [] },
};

const TOOL_IDS = Object.keys(TOOL_RAIL_GROUP) as ToolRailId[];

function copyDefault(): ToolRailLayout {
  return {
    left: { top: [...DEFAULT_TOOL_RAIL_LAYOUT.left.top], bottom: [...DEFAULT_TOOL_RAIL_LAYOUT.left.bottom] },
    right: { top: [...DEFAULT_TOOL_RAIL_LAYOUT.right.top], bottom: [...DEFAULT_TOOL_RAIL_LAYOUT.right.bottom] },
  };
}

/** 持久化内容按不可信输入处理：去重、纠正分组，并把新增工具补回默认侧。 */
export function normalizeToolRailLayout(value: unknown): ToolRailLayout {
  const normalized: ToolRailLayout = { left: { top: [], bottom: [] }, right: { top: [], bottom: [] } };
  const seen = new Set<ToolRailId>();
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  for (const side of ["left", "right"] as const) {
    const groups = raw[side] && typeof raw[side] === "object" ? raw[side] as Record<string, unknown> : {};
    for (const group of ["top", "bottom"] as const) {
      const items = Array.isArray(groups[group]) ? groups[group] : [];
      for (const item of items) {
        if (typeof item !== "string" || !(item in TOOL_RAIL_GROUP)) continue;
        const id = item as ToolRailId;
        if (seen.has(id) || TOOL_RAIL_GROUP[id] !== group) continue;
        seen.add(id);
        normalized[side][group].push(id);
      }
    }
  }
  for (const id of TOOL_IDS) {
    if (seen.has(id)) continue;
    const group = TOOL_RAIL_GROUP[id];
    const side = DEFAULT_TOOL_RAIL_LAYOUT.left[group].includes(id) ? "left" : "right";
    normalized[side][group].push(id);
  }
  return normalized;
}

export function loadToolRailLayout(): ToolRailLayout {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      const parsed = normalizeToolRailLayout(JSON.parse(stored));
      // 1:1 对标 openidea 规范 (anchor: "right", order: 0)：
      // notifications 必须且永远置于右侧顶端第一位，严禁遗留在 bottom 或其他位置。
      parsed.left.bottom = parsed.left.bottom.filter((id) => id !== "notifications");
      parsed.right.bottom = parsed.right.bottom.filter((id) => id !== "notifications");
      parsed.left.top = parsed.left.top.filter((id) => id !== "notifications");
      parsed.right.top = ["notifications", ...parsed.right.top.filter((id) => id !== "notifications")];
      saveToolRailLayout(parsed);
      return parsed;
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY) ?? localStorage.getItem("forge:tool-rail-layout:v1");
    if (legacy === null) return copyDefault();
    const migrated = normalizeToolRailLayout(JSON.parse(legacy));
    // 迁移升级：若旧版本中 ai 在左侧则迁至右侧；notifications 强制置于右侧顶端首位
    const leftTopClean = migrated.left.top.filter((id) => id !== "notifications" && id !== "ai");
    const rightTopClean = migrated.right.top.filter((id) => id !== "notifications" && id !== "ai");
    const next: ToolRailLayout = {
      left: {
        top: leftTopClean,
        bottom: migrated.left.bottom.filter((id) => id !== "notifications"),
      },
      right: {
        top: ["notifications", "ai", ...rightTopClean],
        bottom: migrated.right.bottom.filter((id) => id !== "notifications"),
      },
    };
    saveToolRailLayout(next);
    return next;
  } catch {
    return copyDefault();
  }
}

export function saveToolRailLayout(layout: ToolRailLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeToolRailLayout(layout)));
  } catch {
    // 布局偏好写失败不应影响工具窗口本身继续工作。
  }
}

export function sideOfTool(layout: ToolRailLayout, id: ToolRailId): ToolRailSide {
  const group = TOOL_RAIL_GROUP[id];
  return layout.left[group].includes(id) ? "left" : "right";
}

/** 拖拽只能命中同侧同组工具；before=false 表示放到目标之后。 */
export function reorderToolRail(
  layout: ToolRailLayout,
  dragged: ToolRailId,
  target: ToolRailId,
  before: boolean,
): ToolRailLayout {
  const group = TOOL_RAIL_GROUP[dragged];
  if (dragged === target || TOOL_RAIL_GROUP[target] !== group) return layout;
  const side = sideOfTool(layout, dragged);
  if (sideOfTool(layout, target) !== side) return layout;
  const current = layout[side][group];
  const without = current.filter((id) => id !== dragged);
  const targetIndex = without.indexOf(target);
  if (targetIndex < 0) return layout;
  const next = [...without];
  next.splice(targetIndex + (before ? 0 : 1), 0, dragged);
  if (next.every((id, index) => id === current[index])) return layout;
  return { ...layout, [side]: { ...layout[side], [group]: next } };
}

export function moveToolRail(layout: ToolRailLayout, id: ToolRailId, side: ToolRailSide): ToolRailLayout {
  const group = TOOL_RAIL_GROUP[id];
  const from = side === "left" ? "right" : "left";
  if (!layout[from][group].includes(id)) return layout;
  return {
    ...layout,
    [from]: { ...layout[from], [group]: layout[from][group].filter((item) => item !== id) },
    [side]: { ...layout[side], [group]: [...layout[side][group], id] },
  };
}
