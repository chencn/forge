// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { snippet } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { beforeAll, describe, expect, it } from "vitest";
import { cmSnippet } from "../../src/lib/cm/snippet";
import { stubTextLayout } from "../helpers/cmLayout";

/**
 * server 的 snippet 模板过一遍换算，再真让 CodeMirror 插一次。
 *
 * 只验字符串对不上是不够的：`$1` 这类简写漏掉时模板仍然插得进去，只是那几个停靠点
 * 变成字面文本，按 Tab 跳不动——正是这条要拦的情形。
 */

beforeAll(stubTextLayout);

function expand(template: string): { text: string; ranges: Array<{ from: number; to: number }> } {
  const view = new EditorView({ state: EditorState.create({ doc: "" }), parent: window.document.body });
  snippet(cmSnippet(template))(view, null, 0, 0);
  const text = view.state.doc.toString();
  const ranges = view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
  view.destroy();
  return { text, ranges };
}

describe("snippet 模板换算", () => {
  it("简写的停靠点补上花括号，choices 取第一项当默认文本", () => {
    expect(cmSnippet("$1")).toBe("${1}");
    expect(cmSnippet("$0")).toBe("${0}");
    expect(cmSnippet("${1|read,write|}")).toBe("${1:read}");
    expect(cmSnippet("无占位")).toBe("无占位");
  });

  it("换算后的模板真能被 CodeMirror 展开成字段", () => {
    const { text, ranges } = expand("if (${1:cond}) {\n  $0\n}");
    expect(text).toBe("if (cond) {\n  \n}");
    // 第一个停靠点默认被选中，接着打字就是改它；落点不对说明花括号补错了位置。
    expect(ranges).toEqual([{ from: 4, to: 8 }]);
  });

  it("重复出现的停靠点不丢文字", () => {
    const { text, ranges } = expand("for (${1:i}=0; $1<n; $1++) {}");
    // `$1` 没换算时这里会留下字面的 "$1"；换成空的 `${1}` 时那两处文字会被吞掉。
    expect(text).toBe("for (i=0; i<n; i++) {}");
    // 这一版 CodeMirror 只把第一处当选中字段（见 snippet.ts 末尾那条说明）。
    expect(ranges).toEqual([{ from: 5, to: 6 }]);
  });

  it("没出现过默认文本时留空位，不硬造一个字", () => {
    expect(cmSnippet("$1 x $1")).toBe("${1} x ${1}");
  });
});
