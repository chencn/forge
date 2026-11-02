/**
 * 空编辑器告示页要宣传的那几颗命令（纯数据，不引编辑器引擎）。
 *
 * 单独一个模块是因为告示页在启动路径上：跟着 `cm/keymap.ts` 一起写就为了几张键位表
 * 把编辑器本体拉进首屏。`cm/keymap.ts` 那侧才是真正装绑定的地方。
 */
import type { KeymapScheme } from "./settings";
import type { TranslationKey } from "../i18n/lang/zh";
import { formatContextShortcut, formatShortcut } from "./shortcuts";

export interface ShortcutHint {
  label: TranslationKey;
  chord: string;
}

/**
 * 展示只声明动作，键位取自执行时使用的同一来源，避免方案更新后提示仍显示旧键。
 * 方向键统一用箭头显示，内部绑定仍保留 DOM 键名。
 */
export function shortcutHints(scheme: KeymapScheme): ShortcutHint[] {
  const application: Array<[TranslationKey, string]> = [
    ["welcome.gotoFile", "search.gotoFile"],
    ["welcome.findInFiles", "search.findInFiles"],
    // IDEA 的 Ctrl+S 实际保存全部，提示也须使用同一动作名称。
    scheme === "idea" ? ["command.saveAll", "file.saveAll"] : ["welcome.save", "file.save"],
  ];
  const editor: Array<[TranslationKey, string]> = [
    ["welcome.find", "Find"],
    ["welcome.replace", "Replace"],
    ["welcome.comment", "CommentByLineComment"],
    ["welcome.copyLine", scheme === "idea" ? "EditorDuplicate" : "EditorDuplicateLines"],
    ["welcome.deleteLine", "EditorDeleteLine"],
  ];
  return [
    // 双击 Shift 由应用的 DoubleShiftDetector 固定处理，不是普通组合键。
    { label: "welcome.everywhere" as const, chord: "Shift ×2" },
    ...application.map(([label, action]) => ({ label, chord: formatShortcut(action, scheme) })),
    ...editor.map(([label, action]) => ({ label, chord: formatContextShortcut(action, scheme) })),
  ].filter(({ chord }) => chord !== "").map(({ label, chord }) => ({
    label,
    // 上游 XML 的修饰键顺序不固定；各段分别整理，不能打乱多段组合键。
    chord: chord.split(" ").map((stroke) => {
      const parts = stroke.split("+");
      const modifiers = ["Ctrl", "Cmd", "Meta", "Alt", "Shift"].filter((part) => parts.includes(part));
      return [...modifiers, ...parts.filter((part) => !modifiers.includes(part))].join("+");
    }).join(" ").replace(/Arrow(Up|Down|Left|Right)/g, (_, direction: string) =>
      ({ Up: "↑", Down: "↓", Left: "←", Right: "→" })[direction] ?? direction),
  }));
}
