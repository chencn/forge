import { describe, expect, it } from "vitest";
import {
  comboMatchesEvent,
  effectiveShortcut,
  parseCombo,
  SHORTCUT_DEFS,
  ShortcutSequence,
} from "../../src/lib/shortcuts";
import { KEYMAP_SCHEMES } from "../../src/lib/settings";
import { cmKey, ideaKeys, ideaStroke, presetKeys } from "../../src/lib/keymaps/idea";

/** 造一次真实按键的形状；修饰键给全，主键必给。 */
function key(k: string, mods: Partial<{ ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }> = {}) {
  return {
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    key: k,
  };
}

describe("parseCombo", () => {
  it("解析平台无关的组合串", () => {
    expect(parseCombo("Mod+Shift+F")).toEqual({ mod: true, alt: false, shift: true, key: "F" });
    expect(parseCombo("Alt+4")).toEqual({ mod: false, alt: true, shift: false, key: "4" });
    expect(parseCombo("Shift+F10")).toEqual({ mod: false, alt: false, shift: true, key: "F10" });
    expect(parseCombo("Mod+F5")).toEqual({ mod: true, alt: false, shift: false, key: "F5" });
    expect(parseCombo("Escape")).toEqual({ mod: false, alt: false, shift: false, key: "Escape" });
  });

  it("垃圾输入一律拒绝", () => {
    expect(parseCombo("")).toBeNull();
    expect(parseCombo("Mod+Ctrl+F")).toBeNull();
    expect(parseCombo("Mod+Shift+")).toBeNull();
    expect(parseCombo("++F")).toBeNull();
  });
});

describe("应用多段键", () => {
  const ids = new Set(SHORTCUT_DEFS.map((def) => def.id));
  const event = (name: string, mods: Parameters<typeof key>[1] = {}, isComposing = false) => ({ ...key(name, mods), isComposing });

  it("单键直接命中对应方案的真实动作", () => {
    const sequence = new ShortcutSequence();
    expect(sequence.match(event("a", { ctrl: true, shift: true }), "idea", ids).id).toBe("search.actions");
    expect(sequence.match(event("a", { ctrl: true, shift: true }), "vscode", ids).id).toBeUndefined();
    expect(sequence.match(event("p", { ctrl: true, shift: true }), "vscode", ids).id).toBe("search.actions");
  });

  it("共享前缀按第二段区分保存全部与关闭全部，修饰键事件不中断", () => {
    const sequence = new ShortcutSequence();
    expect(sequence.match(event("k", { ctrl: true }), "vscode", ids, 0)).toEqual({ pending: true });
    sequence.match(event("Control", { ctrl: true }), "vscode", ids, 10);
    expect(sequence.match(event("s"), "vscode", ids, 20).id).toBe("file.saveAll");
    sequence.match(event("k", { ctrl: true }), "vscode", ids, 30);
    expect(sequence.match(event("w", { ctrl: true }), "vscode", ids, 40).id).toBe("file.closeAll");
    expect(sequence.match(event("w", { ctrl: true }), "vscode", ids, 50).id).toBe("file.closeActive");
  });

  it("超时、Escape、失焦重置、切换方案和输入法组合都取消前缀", () => {
    const sequence = new ShortcutSequence();
    sequence.match(event("k", { ctrl: true }), "vscode", ids, 0);
    expect(sequence.match(event("s"), "vscode", ids, 4001).id).toBeUndefined();
    sequence.match(event("k", { ctrl: true }), "vscode", ids, 2000);
    expect(sequence.match(event("Escape"), "vscode", ids, 2100)).toEqual({ pending: true });
    expect(sequence.match(event("s"), "vscode", ids, 2200).id).toBeUndefined();
    sequence.match(event("k", { ctrl: true }), "vscode", ids, 3000);
    sequence.reset();
    expect(sequence.match(event("s"), "vscode", ids, 3100).id).toBeUndefined();
    sequence.match(event("k", { ctrl: true }), "vscode", ids, 4000);
    expect(sequence.match(event("s"), "idea", ids, 4100).id).toBeUndefined();
    sequence.match(event("k", { ctrl: true }), "vscode", ids, 5000);
    sequence.match(event("Process", {}, true), "vscode", ids, 5100);
    expect(sequence.match(event("s"), "vscode", ids, 5200).id).toBeUndefined();
  });

  it("上下文禁用的动作不能占用前缀，也不能在第二段执行", () => {
    const sequence = new ShortcutSequence();
    expect(sequence.match(event("k", { ctrl: true }), "vscode", new Set(), 0)).toEqual({ pending: false });
    sequence.match(event("k", { ctrl: true }), "vscode", ids, 100);
    expect(sequence.match(event("s"), "vscode", new Set(), 200)).toEqual({ pending: false });
  });
});

describe("comboMatchesEvent", () => {
  it("修饰键必须精确相等", () => {
    expect(comboMatchesEvent(key("f", { ctrl: true, shift: true }), "Mod+Shift+F")).toBe(true);
    expect(comboMatchesEvent(key("f", { meta: true, shift: true }), "Mod+Shift+F")).toBe(true);
    // 多按了 Alt 就是另一条键位。
    expect(comboMatchesEvent(key("f", { ctrl: true, shift: true, alt: true }), "Mod+Shift+F")).toBe(false);
    expect(comboMatchesEvent(key("f", { shift: true }), "Mod+Shift+F")).toBe(false);
  });

  it("主键不区分大小写", () => {
    expect(comboMatchesEvent(key("F", { ctrl: true, shift: true }), "Mod+Shift+F")).toBe(true);
    expect(comboMatchesEvent(key("4", { alt: true }), "Alt+4")).toBe(true);
    expect(comboMatchesEvent(key("4", { alt: true, ctrl: true }), "Alt+4")).toBe(false);
  });

  it("空组合（方案没绑这条动作）不命中任何按键", () => {
    expect(comboMatchesEvent(key("F10", { shift: true }), "")).toBe(false);
  });
});

describe("内置快捷键方案", () => {
  it("id 唯一", () => {
    const ids = SHORTCUT_DEFS.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("默认方案 IDEA 用 IDEA 键位", () => {
    expect(effectiveShortcut("search.findInFiles", "idea")).toBe("Mod+Shift+F");
    expect(effectiveShortcut("search.gotoFile", "idea")).toBe("Mod+Shift+N");
    expect(effectiveShortcut("run.run", "idea")).toBe("Shift+F10");
    expect(effectiveShortcut("run.stop", "idea")).toBe("Mod+F2");
  });

  it("VS Code 与 Eclipse 各自换表", () => {
    expect(effectiveShortcut("search.gotoFile", "vscode")).toBe("Mod+P");
    expect(effectiveShortcut("run.run", "vscode")).toBe("Mod+F5");
    expect(effectiveShortcut("run.stop", "vscode")).toBe("Shift+F5");
    expect(effectiveShortcut("search.gotoFile", "eclipse")).toBe("Mod+Shift+R");
    expect(effectiveShortcut("run.run", "eclipse")).toBe("Mod+F11");
  });

  it("某套方案没有对应动作时留空，不拿别的键凑数", () => {
    expect(effectiveShortcut("run.rerun", "eclipse")).toBe("");
    expect(effectiveShortcut("run.rerun", "vscode")).toBe("");
    expect(effectiveShortcut("run.chooseConfig", "vscode")).toBe("");
    expect(effectiveShortcut("run.chooseConfig", "eclipse")).toBe("");
    expect(effectiveShortcut("run.toggleTool", "eclipse")).toBe("");
  });

  it("每套方案内部没有重复键", () => {
    for (const scheme of KEYMAP_SCHEMES) {
      const keys = SHORTCUT_DEFS.flatMap((def) => (def.keys[scheme] ? [def.keys[scheme]] : []));
      expect(new Set(keys).size, `${scheme} 方案里有重复的按键串`).toBe(keys.length);
    }
  });

  it("三套方案都至少绑了保存与运行", () => {
    for (const scheme of KEYMAP_SCHEMES) {
      expect(effectiveShortcut(scheme === 'idea' ? 'file.saveAll' : 'file.save', scheme)).not.toBe("");
      expect(effectiveShortcut("run.run", scheme)).not.toBe("");
    }
  });
});


describe('完整方案的按键边界', () => {
  it('Shift 标点、数字上档字符和非拉丁布局按物理键匹配', () => {
    expect(comboMatchesEvent({ ...key('>', { alt: true, shift: true }), code: 'Period' }, 'Alt+Shift+.')).toBe(true);
    expect(comboMatchesEvent(key('!', { ctrl: true, shift: true }), 'Mod+Shift+1')).toBe(true);
    expect(comboMatchesEvent({ ...key('ж', { ctrl: true }), code: 'KeyJ' }, 'Mod+J')).toBe(true);
    expect(comboMatchesEvent({ ...key('>', { alt: true, shift: true }), code: 'Period' }, 'Alt+Shift+,')).toBe(false);
  });

  it('保留全部别名、多段键、小键盘键，并尊重子方案显式解绑', () => {
    expect(ideaKeys('FindNext')).toEqual(['F3', 'Ctrl+L']);
    expect(ideaKeys('$Undo')).toEqual(['Ctrl+Z', 'Alt+Backspace']);
    expect(ideaKeys('ExpandToLevel1')).toEqual(['Ctrl+* 1']);
    expect(cmKey('Ctrl++')).toBe('Ctrl-+');
    expect(cmKey('Ctrl+* 1')).toBe('Ctrl-* 1');
    expect(ideaStroke('control shift OPEN_BRACKET')).toBe('Ctrl+Shift+[');
    expect(ideaStroke('alt down')).toBe('Alt+ArrowDown');
    expect(presetKeys('vscode', 'EditorSplitLine')).toEqual([]);
    expect(presetKeys('eclipse', 'EditorDuplicate')).toEqual([]);
    expect(() => ideaStroke('control NOT_A_KEY')).toThrow('Unknown IDEA key');
  });

  it('IDEA Ctrl+S 保存全部，切换 VS Code 后只保存当前文件', () => {
    const sequence = new ShortcutSequence();
    const ids = new Set(SHORTCUT_DEFS.map((definition) => definition.id));
    const event = { ...key('s', { ctrl: true }), isComposing: false };
    expect(sequence.match(event, 'idea', ids).id).toBe('file.saveAll');
    expect(sequence.match(event, 'vscode', ids).id).toBe('file.save');
  });
});
