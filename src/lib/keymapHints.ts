/**
 * 空编辑器告示页要宣传的那几颗命令（纯数据，不引编辑器引擎）。
 *
 * 单独一个模块是因为告示页在启动路径上：跟着 `cm/keymap.ts` 一起写就为了几张键位表
 * 把编辑器本体拉进首屏。`cm/keymap.ts` 那侧才是真正装绑定的地方。
 */
import type { KeymapScheme } from "./settings";
import type { TranslationKey } from "../i18n/lang/zh";

export interface ShortcutHint {
  label: TranslationKey;
  chords: Partial<Record<KeymapScheme, string>>;
}

/**
 * `chords` 按方案给真实键位：某个方案没绑这条命令时就不画这一行，
 * 免得告示页承诺做不到的事。应用级搜索/保存的键位与 `lib/shortcuts.ts` 保持一致。
 */
export const SHORTCUT_HINTS: ShortcutHint[] = [
  // 双击 Shift 是固定的键盘手势，三套方案都一样（`shift SHIFT`）。
  {
    label: "welcome.everywhere",
    chords: { idea: "Shift ×2", vscode: "Shift ×2", eclipse: "Shift ×2" },
  },
  {
    label: "welcome.gotoFile",
    chords: { idea: "Ctrl+Shift+N", vscode: "Ctrl+P", eclipse: "Ctrl+Shift+R" },
  },
  {
    label: "welcome.findInFiles",
    chords: { idea: "Ctrl+Shift+F", vscode: "Ctrl+Shift+F", eclipse: "Ctrl+H" },
  },
  {
    label: "welcome.save",
    chords: { idea: "Ctrl+S", vscode: "Ctrl+S", eclipse: "Ctrl+S" },
  },
  { label: "welcome.find", chords: { idea: "Ctrl+F", vscode: "Ctrl+F", eclipse: "Ctrl+F" } },
  // Eclipse 的替换并进查找面板，没有独立键位，这一行不画。
  { label: "welcome.replace", chords: { idea: "Ctrl+R", vscode: "Ctrl+H" } },
  // 语言服务尚未提供定义跳转、语义重命名和格式化，不提示这些未实现的键位。
  {
    label: "welcome.comment",
    chords: { idea: "Ctrl+/", vscode: "Ctrl+/", eclipse: "Ctrl+/" },
  },
  {
    label: "welcome.copyLine",
    chords: { idea: "Ctrl+D", vscode: "Shift+Alt+Down", eclipse: "Ctrl+Alt+Down" },
  },
  {
    label: "welcome.deleteLine",
    chords: { idea: "Ctrl+Y", vscode: "Ctrl+Shift+K", eclipse: "Ctrl+D" },
  },
];
