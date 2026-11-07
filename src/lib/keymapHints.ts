/**
 * 空编辑器告示页要宣传的那几颗命令（纯数据，不引编辑器引擎）。
 *
 * 单独一个模块是因为告示页在启动路径上：跟着 `cm/keymap.ts` 一起写就为了几张键位表
 * 把编辑器本体拉进首屏。`cm/keymap.ts` 那侧才是真正装绑定的地方。
 */
import type { KeymapScheme } from "./settings";
import type { TranslationKey } from "../i18n/lang/zh";
import { presetKeys } from "./keymaps/idea";
import { formatShortcut } from "./shortcuts";
import { IS_MAC } from "./sys";

/** 快捷键提示表的一行：文案键、键位串与可选动作。 */
export interface ShortcutHint {
  label: TranslationKey;
  /** 有键位才画右列。拖放那一行没有键。 */
  chord?: string;
  /** 随处搜索、转到文件可以点。拖放提示不能点。 */
  action?: "search" | "gotoFile";
}

/** 方案表里的主键。修饰键按 Ctrl、Alt、Shift 排，多段键用逗号隔开。 */
function schemeChord(scheme: KeymapScheme, action: string): string | undefined {
  const primary = presetKeys(scheme, action)[0];
  if (!primary) return undefined;
  return primary.split(" ").map((stroke) => {
    const parts = stroke.split("+");
    const modifiers = ["Ctrl", "Alt", "Shift"].filter((part) => parts.includes(part));
    const key = parts.filter((part) => !modifiers.includes(part)).join("+");
    return [...modifiers, key].filter(Boolean).join("+").replace(/\bCtrl\b/g, IS_MAC ? "Cmd" : "Ctrl");
  }).join(", ");
}

/**
 * 空编辑区列五行。最近文件和导航栏这边没有动作，只显示、不能点。
 * VS Code 没有「最近文件」的默认键，这一行不写键，避免把 IDEA 方案的 Ctrl+E 漏过去。
 */
export function shortcutHints(scheme: KeymapScheme): ShortcutHint[] {
  const gotoFile = formatShortcut("search.gotoFile", scheme);
  const recent = scheme === "vscode" ? undefined : schemeChord(scheme, "RecentFiles");
  const navbar = schemeChord(scheme, "ShowNavBar");
  return [
    { label: "command.searchEverywhere", chord: IS_MAC ? "⇧⇧" : "Shift, Shift", action: "search" },
    ...(gotoFile ? [{ label: "shortcut.search.gotoFile" as const, chord: gotoFile, action: "gotoFile" as const }] : []),
    { label: "welcome.recentFiles", ...(recent ? { chord: recent } : {}) },
    { label: "welcome.navigationBar", ...(navbar ? { chord: navbar } : {}) },
    { label: "welcome.dropFiles" },
  ];
}
