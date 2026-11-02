/** IDEA Windows/Linux 完整官方基表。动作是否可用由调用方的真实处理器和焦点决定。 */
import defaults from './idea-default.json';
import vscode from './vscode.json';
import eclipse from './eclipse.json';
import type { KeymapScheme } from '../settings';

export const IDEA_DEFAULT = defaults;

export interface PresetAction {
  keyboard: string[];
  mouse: string[];
  gestures: Array<{ keystroke: string; modifier: string }>;
}

/** 空动作是显式解绑；必须整项覆盖，不能将父表键位重新补回来。 */
export const PRESET_ACTIONS: Record<KeymapScheme, Readonly<Record<string, PresetAction>>> = {
  idea: defaults.actions,
  vscode: { ...defaults.actions, ...vscode.actions },
  eclipse: { ...defaults.actions, ...eclipse.actions },
};

const names: Record<string, string> = {
  UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight',
  PAGE_UP: 'PageUp', PAGE_DOWN: 'PageDown', BACK_SPACE: 'Backspace',
  ENTER: 'Enter', ESCAPE: 'Escape', INSERT: 'Insert', DELETE: 'Delete',
  HOME: 'Home', END: 'End', TAB: 'Tab', SPACE: 'Space', CONTEXT_MENU: 'ContextMenu',
  OPEN_BRACKET: '[', CLOSE_BRACKET: ']', BACK_SLASH: '\\', SLASH: '/', DIVIDE: '/',
  BACK_QUOTE: '`', COMMA: ',', PERIOD: '.', QUOTE: "'", MINUS: '-', SUBTRACT: '-',
  SEMICOLON: ';',
  EQUALS: '=', ADD: '+', MULTIPLY: '*',
};

/** JB 的兼容方案与原生编辑器有差异。这些已核对的原生键覆盖兼容表，空数组表示解绑。 */
const nativeKeys: Partial<Record<KeymapScheme, Record<string, string[]>>> = {
  vscode: {
    EditorSelectLine: ['Ctrl+L'], FindNext: ['F3'], FindPrevious: ['Shift+F3'],
    SmartUnSelect: ['Alt+Shift+ArrowLeft'], EditorDuplicateLinesUp: ['Alt+Shift+ArrowUp'],
    CommentByLineComment: ['Ctrl+/'], CommentLine: ['Ctrl+K Ctrl+C'], UncommentLine: ['Ctrl+K Ctrl+U'],
    SelectNextOccurrence: ['Ctrl+D'], FindWordAtCaret: ['Ctrl+F3'], FindPrevWordAtCaret: ['Ctrl+Shift+F3'],
    CopyPaths: ['Alt+Shift+C', 'Ctrl+K P'],
    NextDiff: ['Alt+F5'], PreviousDiff: ['Alt+Shift+F5'],
  },
  eclipse: {
    Find: ['Ctrl+F'], Replace: [], MoveLineUp: ['Alt+ArrowUp'], MoveLineDown: ['Alt+ArrowDown'],
    EditorDuplicateLinesUp: ['Ctrl+Alt+ArrowUp'], EditorMatchBrace: ['Ctrl+Shift+P'],
    '$Redo': ['Ctrl+Y'],
  },
};

/** Swing 键名转成统一的 DOM 键名，多段键仍保留分段边界。未知命名立即报错。 */
export function ideaStroke(stroke: string): string {
  const parts = stroke.trim().split(/\s+/);
  const raw = parts.pop()!.toUpperCase();
  const key = names[raw] ?? (/^[A-Z0-9]$|^F\d+$/.test(raw) ? raw : /^NUMPAD\d$/.test(raw) ? raw.slice(-1) : null);
  if (!key) throw new Error(`Unknown IDEA key: ${raw}`);
  const modifiers = parts.map((part) => {
    const modifier = ({ control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' } as Record<string, string>)[part.toLowerCase()];
    if (!modifier) throw new Error(`Unknown IDEA modifier: ${part}`);
    return modifier;
  });
  return [...modifiers, key].join('+');
}

export function ideaKeys(action: string): string[] {
  return presetKeys('idea', action);
}

export function presetKeys(scheme: KeymapScheme, action: string): string[] {
  const native = nativeKeys[scheme]?.[action];
  if (native) return native;
  const definition = PRESET_ACTIONS[scheme][action];
  return [...new Set((definition?.keyboard ?? []).map((key) => key.split(' > ').map(ideaStroke).join(' ')))];
}

/** CodeMirror 使用连字符和小写字符键；不改变多段键中的空格。 */
export function cmKey(binding: string): string {
  return binding.split(' ').map((stroke) => {
    const split = stroke.lastIndexOf('+');
    // Ctrl++ 的最后一个加号是主键，不是分隔符。
    const boundary = stroke.endsWith('++') ? split - 1 : split;
    const key = stroke.slice(boundary + 1);
    const modifiers = boundary < 0 ? '' : stroke.slice(0, boundary).replaceAll('+', '-') + '-';
    return modifiers + (key.length === 1 ? key.toLowerCase() : key);
  }).join(' ');
}
