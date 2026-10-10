/**
 * 空编辑器告示页要宣传的那几颗命令（纯数据，不引 monaco）。
 *
 * 单独一个模块是因为告示页在启动路径上：跟着 `keymap.ts` 一起写就为了几张键位表
 * 把编辑器本体拉进首屏。`keymap.ts` 那侧才是真正装绑定的地方。
 */
import type { KeymapScheme } from "./settings";
import type { TranslationKey } from "../i18n/lang/zh";

export interface ShortcutHint {
  label: TranslationKey;
  chords: Partial<Record<KeymapScheme, string>>;
}

/**
 * `chords` 按方案给真实键位：某个方案没绑这条命令时就不画这一行，
 * 免得告示页承诺做不到的事。
 */
export const SHORTCUT_HINTS: ShortcutHint[] = [
  // 前三行是应用级的搜索入口，不走 monaco 的键绑定，三个方案里都是同一套键，
  // 所以三档给同一个值。双击 Shift 取的是 IDEA 那条键盘手势（`shift SHIFT`）。
  {
    label: "welcome.everywhere",
    chords: { default: "Shift ×2", idea: "Shift ×2", eclipse: "Shift ×2" },
  },
  {
    label: "welcome.gotoFile",
    chords: { default: "Ctrl+Shift+N", idea: "Ctrl+Shift+N", eclipse: "Ctrl+Shift+N" },
  },
  {
    label: "welcome.findInFiles",
    chords: { default: "Ctrl+Shift+F", idea: "Ctrl+Shift+F", eclipse: "Ctrl+Shift+F" },
  },
  {
    label: "welcome.save",
    chords: { default: "Ctrl+S", idea: "Ctrl+S", eclipse: "Ctrl+S" },
  },
  { label: "welcome.find", chords: { default: "Ctrl+F", idea: "Ctrl+F", eclipse: "Ctrl+F" } },
  { label: "welcome.replace", chords: { default: "Ctrl+H", idea: "Ctrl+R" } },
  {
    label: "welcome.definition",
    chords: { default: "F12", idea: "Ctrl+B", eclipse: "F3" },
  },
  {
    label: "welcome.rename",
    chords: { default: "F2", idea: "Shift+F6", eclipse: "Alt+Shift+R" },
  },
  {
    label: "welcome.format",
    chords: { default: "Shift+Alt+F", idea: "Ctrl+Alt+L", eclipse: "Ctrl+Shift+F" },
  },
  {
    label: "welcome.comment",
    chords: { default: "Ctrl+/", idea: "Ctrl+/", eclipse: "Ctrl+/" },
  },
  { label: "welcome.copyLine", chords: { idea: "Ctrl+D", eclipse: "Ctrl+Alt+Down" } },
  {
    label: "welcome.deleteLine",
    chords: { default: "Ctrl+Shift+K", idea: "Ctrl+Y", eclipse: "Ctrl+D" },
  },
];
