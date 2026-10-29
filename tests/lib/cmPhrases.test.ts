// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { cmPhraseKeys, cmPhrases } from "../../src/lib/cm/phrases";
import { en } from "../../src/i18n/lang/en";
import { zh } from "../../src/i18n/lang/zh";
import { zhTW } from "../../src/i18n/lang/zh-TW";

/**
 * 引擎自带面板的文案。
 *
 * CodeMirror 是按「源码里写死的那串英文」查译文的：键差一个字符不报错，只是那一句
 * 悄悄退回英文。所以这份原串清单是从各个包里抄来的，不是从我们这张表反推的——
 * 反推只能证明表和它自己一致。
 */
const SOURCES = [
  "Find",
  "Replace",
  "replace",
  "replace all",
  "all",
  "match case",
  "regexp",
  "by word",
  "next",
  "previous",
  "close",
  "Go to line",
  "go",
  "current match",
  "on line",
  "replaced $ matches",
  "replaced match on line $",
  "Completions",
  "Control character",
  "Selection deleted",
  "Diagnostics",
  "No diagnostics",
  "folded code",
  "Folded lines",
  "Unfolded lines",
  "to",
  "unfold",
  "Fold line",
  "Unfold line",
  "Accept",
  "Reject",
  "Revert this chunk",
  "$ unchanged lines",
];

describe("编辑器面板文案", () => {
  it("引擎要问的那几句都有译文", () => {
    const mapped = new Set(cmPhraseKeys().map(([source]) => source));
    for (const source of SOURCES) {
      expect(mapped.has(source), `CodeMirror 会问「${source}」，这张表里没有`).toBe(true);
    }
  });

  it("每条映射的 i18n 键在三种语言里都有值", () => {
    for (const [source, key] of cmPhraseKeys()) {
      for (const [lang, dict] of [["zh", zh], ["en", en], ["zh-TW", zhTW]] as const) {
        const value = dict[key];
        expect(typeof value === "string" && value.length > 0, `${lang} 缺「${key}」（原串「${source}」）`).toBe(true);
      }
    }
  });

  it("带数字的几句留一个 $ 给引擎填数", () => {
    for (const source of SOURCES.filter((item) => item.includes("$"))) {
      const value = cmPhrases[source];
      expect(value, `原串「${source}」的译文里没有 $`).toContain("$");
      expect(value.match(/\$(?!\d)/g)?.length, `原串「${source}」的译文里 $ 不止一处：${value}`).toBe(1);
    }
  });

  it("挂的是取值函数：换语言不用重建常驻 state", () => {
    const finder = Object.getOwnPropertyDescriptor(cmPhrases, "Find");
    expect(finder?.get).toBeTypeOf("function");
    expect(finder?.enumerable).toBe(true);
    // `EditorState.phrase` 用 hasOwnProperty 判定「有没有译文」，取值属性必须仍然算有。
    const state = EditorState.create({ extensions: [EditorState.phrases.of(cmPhrases)] });
    expect(state.phrase("Find")).toBe(cmPhrases.Find);
    expect(state.phrase("Diagnostics")).toBe(cmPhrases.Diagnostics);
  });

  it("没在表里的原串按引擎自己的写法退回", () => {
    const state = EditorState.create({ extensions: [EditorState.phrases.of(cmPhrases)] });
    expect(state.phrase("Not a phrase")).toBe("Not a phrase");
  });
});
