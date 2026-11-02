/**
 * 应用级快捷键注册表：三套内置方案（IDEA / VS Code / Eclipse）+ 事件匹配。
 *
 * 不提供逐条改键——键位完全由设置里选中的那套方案决定，用户只能在三套之间切换。
 * 应用级命令统一由动作表分发；编辑器内的键位归方案那层（lib/cm/keymap.ts），
 * 目录树上的 Ctrl+C/V/F2 是焦点相关的上下文键，都不进这张表。
 *
 * 组合键用平台无关的规范串表示：`Mod` 指平台主修饰键（macOS 上是 Cmd，其余是
 * Ctrl）。匹配要求修饰键精确相等——「Alt+4」
 * 不会在多按了 Shift 时触发，否则就是另一条键位了。
 */
import { MOD_LABEL } from "./sys";
import type { KeymapScheme } from "./settings";
import { ideaKeys, presetKeys } from "./keymaps/idea";

export interface ShortcutDef {
  /** 稳定 id，与命令面板的动作 id 一致。 */
  id: string;
  /**
   * 各方案下的组合键。某套编辑器没有对应的默认键时留空——
   * 按键不会命中。多段组合键用空格分隔，如 Mod+K Mod+S。
   */
  keys: Partial<Record<KeymapScheme, string>>;
  /** 同一动作的其他官方默认键；主键仍供菜单展示。 */
  aliases?: Partial<Record<KeymapScheme, readonly string[]>>;
}

/** 焦点组件只声明自己能处理的动作，仍使用同一套完整方案与多段键状态机。 */
export function contextShortcuts(actions: readonly string[]): ShortcutDef[] {
  return actions.map((id) => {
    const keys: ShortcutDef['keys'] = {}, aliases: NonNullable<ShortcutDef['aliases']> = {};
    for (const scheme of ['idea', 'vscode', 'eclipse'] as const) {
      const [primary = '', ...rest] = presetKeys(scheme, id);
      keys[scheme] = primary;
      aliases[scheme] = rest;
    }
    return { id, keys, aliases };
  });
}

/** 菜单与上下文处理器从相同方案取主键，不能继续显示上一套方案的硬编码提示。 */
export function formatContextShortcut(action: string, scheme: KeymapScheme): string {
  return (presetKeys(scheme, action)[0] ?? '').replace(/\bCtrl\+/g, `${MOD_LABEL}+`);
}

/** 官方动作 id 与应用动作的桥接，不再在这里手抄 IDEA 按键。 */
export const IDEA_APPLICATION_ACTIONS: Readonly<Record<string, string>> = {
  'search.actions': 'GotoAction',
  'search.gotoClass': 'GotoClass',
  'search.gotoSymbol': 'GotoSymbol',
  'search.gotoFile': 'GotoFile',
  'search.findInFiles': 'FindInPath',
  'file.saveAll': 'SaveAll',
  'file.closeActive': 'CloseContent',
  'file.refresh': 'Synchronize',
  'file.copyPath': 'CopyPaths',
  'navigate.nextTab': 'NextTab',
  'navigate.previousTab': 'PreviousTab',
  'view.focusEditor': 'FocusEditor',
  'view.hideToolWindows': 'HideAllWindows',
  'settings.open': 'ShowSettings',
  'pane.open.log': 'ActivateVersionControlToolWindow',
  'pane.open.find': 'ActivateFindToolWindow',
  'pane.open.terminal': 'ActivateTerminalToolWindow',
  'tool.open.explorer': 'ActivateProjectToolWindow',
  'tool.open.git': 'ActivateCommitToolWindow',
  'run.run': 'Run',
  'run.stop': 'Stop',
  'run.rerun': 'Rerun',
  'run.chooseConfig': 'ChooseRunConfiguration',
  'run.toggleTool': 'ActivateRunToolWindow',
  'git.newBranch': 'Git.CreateNewBranch',
  'view.increaseEditorFont': 'EditorIncreaseFontSizeGlobal',
  'view.decreaseEditorFont': 'EditorDecreaseFontSizeGlobal',
};

/**
 * 应用级快捷键；只给已有动作绑定对应方案的默认键。
 *
 * IDEA 沿用 IDEA 默认键位；VS Code / Eclipse 只收各编辑器里公认有默认键的动作：
 * Eclipse 没有「选择运行配置」与「切换运行工具窗口」的默认键，这两条在该方案下留空。
 */
const APPLICATION_BINDINGS: ShortcutDef[] = [
  { id: "search.actions", keys: { idea: "Mod+Shift+A", vscode: "Mod+Shift+P", eclipse: "Mod+3" } },
  { id: "search.gotoClass", keys: { idea: "Mod+N", eclipse: "Mod+Shift+T" } },
  { id: "search.gotoSymbol", keys: { idea: "Mod+Alt+Shift+N", vscode: "Mod+T" } },
  {
    id: "search.findInFiles",
    keys: { idea: "Mod+Shift+F", vscode: "Mod+Shift+F", eclipse: "Mod+H" },
  },
  {
    id: "search.gotoFile",
    keys: { idea: "Mod+Shift+N", vscode: "Mod+P", eclipse: "Mod+Shift+R" },
  },
  { id: "file.save", keys: { vscode: "Mod+S", eclipse: "Mod+S" } },
  { id: "file.saveAll", keys: { vscode: "Mod+K S", eclipse: "Mod+Shift+S" } },
  { id: "file.closeActive", keys: { idea: "Mod+F4", vscode: "Mod+W", eclipse: "Mod+W" } },
  { id: "file.closeAll", keys: { vscode: "Mod+K Mod+W", eclipse: "Mod+Shift+W" } },
  { id: "file.refresh", keys: { idea: "Mod+Alt+Y" } },
  { id: "file.copyPath", keys: { idea: "Mod+Shift+C", vscode: "Alt+Shift+C" }, aliases: { vscode: ['Mod+K P'] } },
  { id: "navigate.locateInSidebar", keys: { idea: "Alt+F1 1" } },
  { id: "navigate.nextTab", keys: { idea: "Alt+ArrowRight", vscode: "Mod+PageDown", eclipse: "Mod+F6" } },
  { id: "navigate.previousTab", keys: { idea: "Alt+ArrowLeft", vscode: "Mod+PageUp", eclipse: "Mod+Shift+F6" } },
  { id: "view.toggleSidebar", keys: { vscode: "Mod+B" } },
  { id: "view.splitRight", keys: { vscode: "Mod+\\" } },
  { id: "view.focusEditor", keys: { idea: "Escape" } },
  { id: "view.hideToolWindows", keys: { idea: "Mod+Shift+F12" } },
  { id: "settings.open", keys: { idea: "Mod+Alt+S", vscode: "Mod+," } },
  { id: "git.commit", keys: { idea: "Mod+K" } },
  { id: "git.push", keys: { idea: "Mod+Shift+K" } },
  { id: "git.pull", keys: { idea: "Mod+T" } },
  { id: "pane.open.log", keys: { idea: "Alt+9" } },
  { id: "pane.open.find", keys: { idea: "Alt+3" } },
  { id: "pane.open.terminal", keys: { idea: "Alt+F12", vscode: "Ctrl+`" } },
  { id: "tool.open.explorer", keys: { idea: "Alt+1", vscode: "Mod+Shift+E", eclipse: "Alt+Shift+Q P" } },
  { id: "tool.open.git", keys: { vscode: "Mod+Shift+G" } },
  { id: "run.run", keys: { idea: "Shift+F10", vscode: "Mod+F5", eclipse: "Mod+F11" } },
  // F5/F11 和 Ctrl+Shift+F5 属于调试器；普通运行不能冒充调试或重启调试。
  { id: "run.rerun", keys: { idea: "Mod+F5" } },
  { id: "run.stop", keys: { idea: "Mod+F2", vscode: "Shift+F5", eclipse: "Mod+F2" } },
  { id: "run.chooseConfig", keys: { idea: "Alt+Shift+F10" } },
  { id: "run.toggleTool", keys: { idea: "Alt+4" } },
  { id: "view.toggleBottomPanel", keys: { vscode: 'Mod+J' } },
  { id: "git.newBranch", keys: {} },
  { id: "view.increaseEditorFont", keys: {} },
  { id: "view.decreaseEditorFont", keys: {} },
];

export const SHORTCUT_DEFS: ShortcutDef[] = APPLICATION_BINDINGS.map((definition) => {
  const action = IDEA_APPLICATION_ACTIONS[definition.id];
  if (!action) return definition;
  const [primary = '', ...aliases] = ideaKeys(action).map((key) => key.replace(/\bCtrl\+/g, 'Mod+'));
  return { ...definition, keys: { ...definition.keys, idea: primary }, aliases: { ...definition.aliases, idea: aliases } };
});

export function effectiveShortcuts(id: string, scheme: KeymapScheme): string[] {
  const definition = SHORTCUT_DEFS.find((item) => item.id === id);
  const primary = definition?.keys[scheme];
  return primary ? [primary, ...definition?.aliases?.[scheme] ?? []] : [];
}

/** 某 id 在指定方案下的组合键；方案没绑返回空串。 */
export function effectiveShortcut(id: string, scheme: KeymapScheme): string {
  return SHORTCUT_DEFS.find((def) => def.id === id)?.keys[scheme] ?? "";
}

/** 展示用文案：Mod 翻成平台名。方案没绑返回空串。 */
export function formatShortcut(id: string, scheme: KeymapScheme): string {
  const combo = effectiveShortcut(id, scheme);
  return combo ? combo.replace(/Mod/g, MOD_LABEL) : "";
}

interface ParsedCombo {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** 解析规范串；认不出的返回 null。 */
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

/** 事件是否精确命中这条组合键：修饰键逐一相等，主键不区分大小写。 */
export function comboMatchesEvent(
  event: {
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    key: string;
    code?: string;
  },
  combo: string
): boolean {
  const parsed = parseCombo(combo);
  if (!parsed) return false;
  const mod = event.ctrlKey || event.metaKey;
  if (parsed.mod !== mod) return false;
  if (parsed.alt !== event.altKey) return false;
  if (parsed.shift !== event.shiftKey) return false;
  // Shift+标点给的是上档字符；绑定按物理键匹配，兼容 Alt+字母产生符号的布局。
  const codeKey = event.code && (/^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
    : /^Digit\d$/.test(event.code) ? event.code.slice(5)
    : ({ Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']',
      Backquote: '`', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Comma: ',', Period: '.' } as Record<string, string>)[event.code]);
  const shifted: Record<string, string> = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '<': ',', '>': '.', '?': '/', ':': ';', '"': "'", '{': '[', '}': ']', '|': '\\', '_': '-', '+': '=', '~': '`' };
  return normalizeKey(codeKey || (event.shiftKey ? shifted[event.key] ?? event.key : event.key)) === parsed.key;
}

/** 同一套动作入口处理单键与多段键；切换方案、失焦或打开模态时丢弃未完成前缀。 */
export class ShortcutSequence {
  constructor(private readonly definitions: readonly ShortcutDef[] = SHORTCUT_DEFS) {}
  private pending: Array<{ id: string; remaining: string[] }> = [];
  private startedAt = 0;
  private scheme: KeymapScheme | null = null;

  reset(): void {
    this.pending = [];
    this.startedAt = 0;
  }

  match(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing">, scheme: KeymapScheme, ids: ReadonlySet<string>, now = Date.now()): { id?: string; pending: boolean } {
    if (scheme !== this.scheme) {
      this.reset();
      this.scheme = scheme;
    }
    if (event.isComposing || event.key === "Process") {
      this.reset();
      return { pending: false };
    }
    // 松开/重按修饰键不能终止 Ctrl+K Ctrl+W 这样的多段键。
    if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return { pending: false };
    // 与 CodeMirror 的等待时间一致，避免一边已过期、另一边仍吞掉第二段。
    const candidates = now - this.startedAt <= 4000 ? this.pending : [];
    if (candidates.length && event.key === "Escape") {
      this.reset();
      return { pending: true };
    }
    this.reset();
    const matches = candidates.filter((binding) => ids.has(binding.id) && comboMatchesEvent(event, binding.remaining[0]));
    const bindings = matches.length ? matches : this.definitions.flatMap((def) => ids.has(def.id)
      ? [def.keys[scheme] ?? '', ...def.aliases?.[scheme] ?? []].filter(Boolean).flatMap((binding) => {
        const remaining = binding.split(' ');
        return comboMatchesEvent(event, remaining[0]) ? [{ id: def.id, remaining }] : [];
      }) : []);
    const complete = bindings.find((binding) => binding.remaining.length === 1);
    if (complete) return { id: complete.id, pending: false };
    this.pending = bindings.map(({ id, remaining }) => ({ id, remaining: remaining.slice(1) }));
    if (this.pending.length) this.startedAt = now;
    return { pending: this.pending.length > 0 };
  }
}
