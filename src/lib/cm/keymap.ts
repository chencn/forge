/**
 * 编辑器键位方案：设置里那三档（默认 / IntelliJ IDEA / Eclipse）在 CodeMirror 上的落地。
 *
 * 原来这一层是给 Monaco 动态加 `addKeybindingRules`，命令名是 Monaco 的 action id。
 * 换成 CodeMirror 之后按能力一一对应：能直接对上 CM 命令的就绑，对不上的先空着
 * （缺的那几条写在 IDEA 那张表上面），不拿别的命令凑数——凑出来的键比没键更糟。
 *
 * 优先级用 `Prec.high`：这三档是「照着别的编辑器按」的，同名键必须盖过 CM 自带那套
 * （比如 Eclipse 的 Ctrl+Alt+Up 是多光标还是复制行，听方案的，不听引擎的）。
 */
import { startCompletion } from "@codemirror/autocomplete";
import {
  blockComment,
  copyLineDown,
  copyLineUp,
  deleteLine,
  indentSelection,
  lineComment,
  moveLineDown,
  moveLineUp,
  selectParentSyntax,
  simplifySelection,
} from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { nextDiagnostic, previousDiagnostic } from "@codemirror/lint";
import { Prec, type Extension } from "@codemirror/state";
import { openSearchPanel } from "@codemirror/search";
import { keymap, type Command, type EditorView } from "@codemirror/view";
import type { KeymapScheme } from "../settings";
import { findUsages, formatDocument, gotoDefinition, gotoImplementation, showDocumentation } from "./lsp";

/** 只读文档上不该动的命令：按下去不算命中，让按键继续往下走。 */
function writable(command: Command): Command {
  return (view: EditorView) => (view.state.readOnly ? false : command(view));
}

/**
 * 打开查找面板。`replace` 为真时再把焦点挪到替换那一栏——
 * 面板本身就在 `view.dom` 里，查找与替换两栏一起摆出来（只读时没有替换栏），
 * 所以这里只是换一格焦点，不是另开一个面板。
 */
function find(replace: boolean): Command {
  return (view: EditorView) => {
    openSearchPanel(view);
    if (replace && !view.state.readOnly) {
      view.dom.querySelector<HTMLInputElement>(".cm-search input[name=\"replace\"]")?.focus();
    }
    return true;
  };
}

interface Binding {
  key: string;
  command: Command;
}

/**
 * IDEA（Windows 默认方案）。
 *
 * 这几条这版还没给：Shift+F6 重命名、Alt+Enter 快速修复、Ctrl+Shift+A 命令面板。
 * 前两条要弹输入框或跨文件改一批文档，第三条是整个应用的命令面板，都不是编辑器引擎这一层能给。
 */
const IDEA: Binding[] = [
  { key: "Ctrl-/", command: writable(lineComment) },
  { key: "Shift-Ctrl-/", command: writable(blockComment) },
  { key: "Ctrl-d", command: writable(copyLineDown) },
  { key: "Ctrl-y", command: writable(deleteLine) },
  { key: "Alt-ArrowUp", command: writable(moveLineUp) },
  { key: "Alt-ArrowDown", command: writable(moveLineDown) },
  { key: "Ctrl-w", command: selectParentSyntax },
  { key: "Shift-Ctrl-w", command: simplifySelection },
  { key: "Ctrl-Alt-l", command: writable(formatDocument) },
  { key: "Ctrl-Alt-i", command: writable(indentSelection) },
  { key: "Ctrl-b", command: gotoDefinition },
  { key: "Ctrl-Alt-b", command: gotoImplementation },
  { key: "F12", command: gotoDefinition },
  { key: "Alt-F7", command: findUsages },
  { key: "Ctrl-Alt-Space", command: startCompletion },
  { key: "Ctrl-f", command: find(false) },
  { key: "Ctrl-r", command: find(true) },
  { key: "Ctrl-q", command: showDocumentation },
  { key: "F2", command: nextDiagnostic },
  { key: "Shift-F2", command: previousDiagnostic },
  { key: "Ctrl--", command: foldCode },
  { key: "Ctrl-=", command: unfoldCode },
  { key: "Shift-Ctrl--", command: foldAll },
  { key: "Shift-Ctrl-=", command: unfoldAll },
];

/** Eclipse（Windows 默认方案）。同样缺重命名与快速修复。 */
const ECLIPSE: Binding[] = [
  { key: "Ctrl-/", command: writable(lineComment) },
  { key: "Shift-Ctrl-/", command: writable(blockComment) },
  { key: "Shift-Ctrl-f", command: writable(formatDocument) },
  { key: "Ctrl-i", command: writable(indentSelection) },
  { key: "Ctrl-d", command: writable(deleteLine) },
  { key: "Alt-ArrowUp", command: writable(moveLineUp) },
  { key: "Alt-ArrowDown", command: writable(moveLineDown) },
  { key: "Ctrl-Alt-ArrowUp", command: writable(copyLineUp) },
  { key: "Ctrl-Alt-ArrowDown", command: writable(copyLineDown) },
  { key: "Alt-Shift-ArrowUp", command: selectParentSyntax },
  { key: "Alt-Shift-ArrowDown", command: simplifySelection },
  { key: "F3", command: gotoDefinition },
  { key: "Shift-Ctrl-g", command: findUsages },
  { key: "Ctrl-Alt-Space", command: startCompletion },
  { key: "Ctrl-f", command: find(false) },
  { key: "Ctrl--", command: foldCode },
  { key: "Ctrl-=", command: unfoldCode },
];

/**
 * 「默认」档只补引擎没有、而原来 Monaco 自带的那条：Ctrl+D 复制当前行。
 * 其余（Ctrl+Shift+K 删行、Alt+↑↓ 移行、Ctrl+/ 注释、Ctrl+[ / ] 缩进）CodeMirror
 * 的 defaultKeymap 本来就有，不用再加一遍。
 *
 * 导出这三张表只为让测试能逐条检查键名——绑错名字不会报错，只会变成一条死键。
 */
const DEFAULT: Binding[] = [{ key: "Ctrl-d", command: writable(copyLineDown) }];

const BINDINGS: Partial<Record<KeymapScheme, Binding[]>> = {
  default: DEFAULT,
  idea: IDEA,
  eclipse: ECLIPSE,
};

export function keymapBindings(): Array<[KeymapScheme, Binding[]]> {
  return Object.entries(BINDINGS) as Array<[KeymapScheme, Binding[]]>;
}

export function forgeKeymap(scheme: KeymapScheme): Extension {
  const bindings = BINDINGS[scheme];
  if (!bindings) return [];
  return Prec.high(keymap.of(bindings.map((binding) => ({ key: binding.key, run: binding.command }))));
}
