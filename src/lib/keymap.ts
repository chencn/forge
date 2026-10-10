import * as monaco from "monaco-editor";
import type { KeymapScheme } from "./settings";

/** 一条键位映射。`key` 写成 "Ctrl+Alt+L"，`when` 是 monaco 的上下文表达式。 */
interface KeyBinding {
  command: string;
  key: string;
  /** 生效条件；不给就是任何时候。 */
  when?: string;
}

const MODIFIERS: Record<string, number> = {
  ctrl: monaco.KeyMod.CtrlCmd,
  cmd: monaco.KeyMod.CtrlCmd,
  shift: monaco.KeyMod.Shift,
  alt: monaco.KeyMod.Alt,
  win: monaco.KeyMod.WinCtrl,
};

/** 非字母数字的键名，其余按 Key<Digit>/F<n> 规则推。 */
const NAMED: Record<string, string> = {
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "UpArrow",
  down: "DownArrow",
  left: "LeftArrow",
  right: "RightArrow",
  "-": "Minus",
  "=": "Equal",
  "/": "Slash",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "[": "BracketLeft",
  "]": "BracketRight",
};

const CODES = monaco.KeyCode as unknown as Record<string, number>;

function codeOf(token: string): number | null {
  const named = NAMED[token];
  if (named) return CODES[named] ?? null;
  if (/^[a-z]$/.test(token)) return CODES[`Key${token.toUpperCase()}`] ?? null;
  if (/^[0-9]$/.test(token)) return CODES[`Digit${token}`] ?? null;
  if (/^f([1-9]|1[0-2])$/.test(token)) return CODES[token.toUpperCase()] ?? null;
  return null;
}

/** 把 "Ctrl+Shift+/" 解析成 monaco 的键位掩码，认不出来返回 null。 */
function parseKey(key: string): number | null {
  let mask = 0;
  let base = 0;
  for (const raw of key.split("+")) {
    const token = raw.trim().toLowerCase();
    const modifier = MODIFIERS[token];
    if (modifier !== undefined) {
      mask |= modifier;
      continue;
    }
    const code = codeOf(token);
    if (code === null) return null;
    mask |= code;
    base = code;
  }
  // 光有修饰键不算一条绑定。
  return base === 0 ? null : mask;
}

const EDITABLE = "editorTextFocus && !editorReadonly";

/** IntelliJ IDEA（Windows 默认方案）里 monaco 有对应命令的那部分。 */
const IDEA: KeyBinding[] = [
  { command: "editor.action.commentLine", key: "Ctrl+/", when: EDITABLE },
  { command: "editor.action.blockComment", key: "Ctrl+Shift+/", when: EDITABLE },
  { command: "editor.action.copyLinesDownAction", key: "Ctrl+D", when: EDITABLE },
  { command: "editor.action.deleteLines", key: "Ctrl+Y", when: EDITABLE },
  { command: "editor.action.moveLinesUpAction", key: "Alt+Up", when: EDITABLE },
  { command: "editor.action.moveLinesDownAction", key: "Alt+Down", when: EDITABLE },
  { command: "editor.action.smartSelect.expand", key: "Ctrl+W", when: EDITABLE },
  { command: "editor.action.smartSelect.shrink", key: "Ctrl+Shift+W", when: EDITABLE },
  { command: "editor.action.formatDocument", key: "Ctrl+Alt+L", when: EDITABLE },
  { command: "editor.action.reindentselectedlines", key: "Ctrl+Alt+I", when: EDITABLE },
  { command: "editor.action.revealDefinition", key: "Ctrl+B", when: "editorTextFocus" },
  { command: "editor.action.goToImplementation", key: "Ctrl+Alt+B", when: "editorTextFocus" },
  { command: "editor.action.goToReferences", key: "Alt+F7", when: "editorTextFocus" },
  { command: "editor.action.rename", key: "Shift+F6", when: EDITABLE },
  { command: "editor.action.quickFix", key: "Alt+Enter", when: "editorTextFocus" },
  { command: "editor.action.showHover", key: "Ctrl+Q", when: "editorTextFocus" },
  { command: "editor.action.quickCommand", key: "Ctrl+Shift+A", when: "editorTextFocus" },
  { command: "editor.action.triggerSuggest", key: "Ctrl+Alt+Space", when: "editorTextFocus && !suggestWidgetVisible" },
  { command: "actions.find", key: "Ctrl+F", when: "editorTextFocus" },
  { command: "editor.action.startFindReplaceAction", key: "Ctrl+R", when: EDITABLE },
  { command: "editor.action.marker.next", key: "F2", when: "editorTextFocus" },
  { command: "editor.action.marker.prev", key: "Shift+F2", when: "editorTextFocus" },
  { command: "editor.fold", key: "Ctrl+-", when: "editorTextFocus && foldingEnabled" },
  { command: "editor.unfold", key: "Ctrl+=", when: "editorTextFocus && foldingEnabled" },
  { command: "editor.foldAll", key: "Ctrl+Shift+-", when: "editorTextFocus && foldingEnabled" },
  { command: "editor.unfoldAll", key: "Ctrl+Shift+=", when: "editorTextFocus && foldingEnabled" },
];

/** Eclipse（Windows 默认方案）里有对应命令的那部分。 */
const ECLIPSE: KeyBinding[] = [
  { command: "editor.action.commentLine", key: "Ctrl+/", when: EDITABLE },
  { command: "editor.action.blockComment", key: "Ctrl+Shift+/", when: EDITABLE },
  { command: "editor.action.formatDocument", key: "Ctrl+Shift+F", when: EDITABLE },
  { command: "editor.action.formatSelection", key: "Ctrl+I", when: EDITABLE },
  { command: "editor.action.deleteLines", key: "Ctrl+D", when: EDITABLE },
  { command: "editor.action.moveLinesUpAction", key: "Alt+Up", when: EDITABLE },
  { command: "editor.action.moveLinesDownAction", key: "Alt+Down", when: EDITABLE },
  { command: "editor.action.copyLinesUpAction", key: "Ctrl+Alt+Up", when: EDITABLE },
  { command: "editor.action.copyLinesDownAction", key: "Ctrl+Alt+Down", when: EDITABLE },
  { command: "editor.action.smartSelect.expand", key: "Alt+Shift+Up", when: EDITABLE },
  { command: "editor.action.smartSelect.shrink", key: "Alt+Shift+Down", when: EDITABLE },
  { command: "editor.action.revealDefinition", key: "F3", when: "editorTextFocus" },
  { command: "editor.action.goToReferences", key: "Ctrl+Shift+G", when: "editorTextFocus" },
  { command: "editor.action.rename", key: "Alt+Shift+R", when: EDITABLE },
  { command: "editor.action.quickFix", key: "Ctrl+1", when: "editorTextFocus" },
  { command: "editor.action.showHover", key: "F2", when: "editorTextFocus" },
  { command: "actions.find", key: "Ctrl+F", when: "editorTextFocus" },
  { command: "editor.fold", key: "Ctrl+-", when: "editorTextFocus && foldingEnabled" },
  { command: "editor.unfold", key: "Ctrl+=", when: "editorTextFocus && foldingEnabled" },
];

const BINDINGS: Partial<Record<KeymapScheme, KeyBinding[]>> = {
  idea: IDEA,
  eclipse: ECLIPSE,
};

/**
 * 装上一套键位方案。动态绑定的权重高于 monaco 内置，所以同名键会被覆盖；
 * 返回的 disposable 用来在换方案时把这一套整体撤掉。
 */
export function applyKeymap(scheme: KeymapScheme): monaco.IDisposable | null {
  const bindings = BINDINGS[scheme];
  if (!bindings) return null;
  const rules: monaco.editor.IKeybindingRule[] = [];
  for (const binding of bindings) {
    const keybinding = parseKey(binding.key);
    if (keybinding === null) {
      console.error(`认不出的快捷键「${binding.key}」，已跳过（${binding.command}）`);
      continue;
    }
    rules.push({ command: binding.command, keybinding, when: binding.when });
  }
  return rules.length > 0 ? monaco.editor.addKeybindingRules(rules) : null;
}

