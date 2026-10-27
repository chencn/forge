import { describe, expect, it } from "vitest";
import {
  comboFromEvent,
  comboMatchesEvent,
  comboOwner,
  effectiveShortcut,
  parseCombo,
  SHORTCUT_DEFS,
} from "../../src/lib/shortcuts";

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
});

describe("comboFromEvent", () => {
  it("把真实按键转成规范串", () => {
    expect(comboFromEvent(key("f", { ctrl: true, shift: true }))).toBe("Mod+Shift+F");
    expect(comboFromEvent(key("F10", { shift: true }))).toBe("Shift+F10");
    expect(comboFromEvent(key("s", { ctrl: true }))).toBe("Mod+S");
    expect(comboFromEvent(key("4", { alt: true }))).toBe("Alt+4");
  });

  it("只按修饰键时不产出组合", () => {
    expect(comboFromEvent(key("Shift", { shift: true }))).toBeNull();
    expect(comboFromEvent(key("Control", { ctrl: true }))).toBeNull();
    expect(comboFromEvent(key("AltGraph", { alt: true }))).toBeNull();
  });
});

describe("注册表", () => {
  it("id 唯一", () => {
    const ids = SHORTCUT_DEFS.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("覆盖优先生效，没覆盖回落默认", () => {
    expect(effectiveShortcut("run.run", {})).toBe("Shift+F10");
    expect(effectiveShortcut("run.run", { "run.run": "Mod+R" })).toBe("Mod+R");
    expect(effectiveShortcut("no.such.id", {})).toBe("");
  });

  it("comboOwner 找到占用者并排除自己", () => {
    expect(comboOwner("Mod+Shift+F", {})).toBe("search.findInFiles");
    expect(comboOwner("Mod+Shift+F", {}, "search.findInFiles")).toBeNull();
    expect(comboOwner("Mod+Shift+F", { "search.findInFiles": "Mod+Alt+F" })).toBeNull();
    expect(comboOwner("不是组合键", {})).toBeNull();
  });

  it("comboOwner 按规范化后的组合键判等：别名修饰键写法也算撞键", () => {
    // 存量覆盖写的 "Ctrl+Shift+F"（parseCombo 接受的别名）必须和默认 "Mod+Shift+F" 判成同一条。
    expect(comboOwner("Ctrl+Shift+F", {})).toBe("search.findInFiles");
    expect(comboOwner("Mod+Shift+F", { "search.findInFiles": "Ctrl+Shift+F" })).toBe("search.findInFiles");
  });
});
