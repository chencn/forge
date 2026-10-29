/**
 * 全局快捷键注册表：默认键位 + 用户覆盖 + 事件匹配。
 *
 * 只收「应用级、挂在窗口上」的那几条；编辑器内的键位归方案那层（lib/cm/keymap.ts），
 * 目录树上的 Ctrl+C/V/F2 是焦点相关的上下文键，都不进这张表。
 *
 * 组合键用平台无关的规范串表示：`Mod` 指平台主修饰键（macOS 上是 Cmd，其余是
 * Ctrl）。匹配要求修饰键精确相等——「Alt+4」
 * 不会在多按了 Shift 时触发，否则就是另一条键位了。
 */
import { MOD_LABEL } from "./sys";

export interface ShortcutDef {
  /** 稳定 id：设置页按它存覆盖，重命名文案不影响已有绑定。 */
  id: string;
  /** 默认组合键，规范串形式。 */
  keys: string;
}

/** 应用级快捷键一览；顺序即设置页里的展示顺序。 */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: "search.findInFiles", keys: "Mod+Shift+F" },
  { id: "search.gotoFile", keys: "Mod+Shift+N" },
  { id: "file.save", keys: "Mod+S" },
  { id: "run.run", keys: "Shift+F10" },
  { id: "run.rerun", keys: "Mod+F5" },
  { id: "run.stop", keys: "Mod+F2" },
  { id: "run.chooseConfig", keys: "Alt+Shift+F10" },
  { id: "run.toggleTool", keys: "Alt+4" },
];

const STORAGE_KEY = "forge:shortcuts:v1";

export type ShortcutOverrides = Record<string, string>;

export function loadShortcutOverrides(): ShortcutOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ShortcutOverrides = {};
    for (const [id, keys] of Object.entries(parsed)) {
      if (typeof keys === "string" && parseCombo(keys)) out[id] = keys;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveShortcutOverrides(overrides: ShortcutOverrides): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // 存不进去就只当本次会话生效；键位不是值得报错打断的事。
  }
  emitShortcutsChange();
}

/** 键位变更的进程内广播：设置页改完，挂键位的 useEffect 立刻重挂。 */
type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribeShortcuts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emitShortcutsChange(): void {
  for (const listener of listeners) listener();
}

/** 某 id 的当前生效组合键：覆盖优先，没覆盖用默认。 */
export function effectiveShortcut(id: string, overrides: ShortcutOverrides): string {
  return overrides[id] ?? SHORTCUT_DEFS.find((def) => def.id === id)?.keys ?? "";
}

/** 展示用文案：Mod 翻成平台名。没定义返回空串。 */
export function formatShortcut(id: string, overrides: ShortcutOverrides): string {
  const combo = effectiveShortcut(id, overrides);
  return combo ? combo.replace(/Mod/g, MOD_LABEL) : "";
}

interface ParsedCombo {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** 解析规范串；认不出的返回 null（覆盖存储时就靠它挡垃圾）。 */
export function parseCombo(combo: string): ParsedCombo | null {
  const raw = combo.split("+");
  // 空段说明分隔符连着或悬在头上尾上（"Mod+Shift+"），直接拒绝；
  // 空格键写 "Space"，不认裸空格写法。
  if (raw.some((part) => part.trim() === "")) return null;
  const parts = raw.map((part) => part.trim());
  const parsed: ParsedCombo = { mod: false, alt: false, shift: false, key: "" };
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    const lower = part.toLowerCase();
    if (!last && (lower === "mod" || lower === "ctrl" || lower === "cmd")) {
      // 主修饰键只能声明一次：Mod+Ctrl+F 这类写法是歧义，宁拒不猜。
      if (parsed.mod) return null;
      parsed.mod = true;
    } else if (!last && lower === "alt") {
      if (parsed.alt) return null;
      parsed.alt = true;
    } else if (!last && lower === "shift") {
      if (parsed.shift) return null;
      parsed.shift = true;
    } else if (last && parsed.key === "") {
      parsed.key = normalizeKey(part);
    } else {
      return null;
    }
  }
  return parsed.key ? parsed : null;
}

function normalizeKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  const lower = key.toLowerCase();
  if (lower === "space") return " ";
  if (lower === "esc") return "Escape";
  return key;
}

/** 把一次真实按键转成规范串；按到的只是修饰键本身时返回 null。 */
export function comboFromEvent(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}): string | null {
  if (["Control", "Meta", "Alt", "Shift", "AltGraph"].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(normalizeKey(event.key));
  return parts.join("+");
}

/** 事件是否精确命中这条组合键：修饰键逐一相等，主键不区分大小写。 */
export function comboMatchesEvent(
  event: {
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    key: string;
  },
  combo: string
): boolean {
  const parsed = parseCombo(combo);
  if (!parsed) return false;
  const mod = event.ctrlKey || event.metaKey;
  if (parsed.mod !== mod) return false;
  if (parsed.alt !== event.altKey) return false;
  if (parsed.shift !== event.shiftKey) return false;
  return normalizeKey(event.key) === parsed.key;
}

/**
 * 新绑定撞了谁的 id；没撞返回 null。双击 Shift 手势不参与。
 * 判等走规范化后的组合键，不比原始串——存量覆盖里 "Ctrl+S"/"Cmd+S" 这类别名
 * 写法（parseCombo 都接受）必须和默认 "Mod+S" 判成同一条，否则撞了查不出来。
 */
export function comboOwner(combo: string, overrides: ShortcutOverrides, excludeId?: string): string | null {
  const signature = comboSignature(combo);
  if (!signature) return null;
  for (const def of SHORTCUT_DEFS) {
    if (def.id === excludeId) continue;
    if (comboSignature(effectiveShortcut(def.id, overrides)) === signature) return def.id;
  }
  return null;
}

/** 组合键的判等键：解析后按统一顺序重新序列化，别名修饰键与大小写差异都归一。 */
function comboSignature(combo: string): string | null {
  const parsed = parseCombo(combo);
  if (!parsed) return null;
  const parts: string[] = [];
  if (parsed.mod) parts.push("Mod");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(parsed.key);
  return parts.join("+");
}
