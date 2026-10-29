import { describe, expect, it } from "vitest";
import type { ForgeCommand } from "../../src/lib/commands";
import type { FileHit, SymbolHit, TextHit } from "../../src/lib/fs";
import {
  ALL_TAB_LIMIT,
  RECENT_LIMIT,
  TEXT_WEIGHT,
  buildRows,
  fileItem,
  isSectionRow,
  isTypeKind,
  itemWeight,
  matchActions,
  mixItems,
  parseCommand,
  sectionsFor,
  stableIndex,
  symbolDisplayName,
  symbolItem,
  textItem,
  topResultSettled,
  type SectionId,
  type SectionState,
} from "../../src/lib/seModel";

const cmd = (id: string, label: string, shortcut?: string): ForgeCommand => ({ id, label, shortcut, run: () => {} });
const fileHit = (path: string, name: string, container: string): FileHit => ({ path, name, container, score: 3, isDir: false });
const symbolHit = (name: string, kind = "class", path = "D:/r/src/App.tsx", line = 12, column = 8): SymbolHit => ({
  path,
  name,
  kind,
  container: "src",
  line,
  column,
});

function sections(entries: Array<[SectionId, Partial<SectionState>?]>): Map<SectionId, SectionState> {
  return new Map(entries.map(([id, s]) => [id, { items: [], hasMore: false, loading: false, ...s }]));
}

describe("sectionsFor 分节选择", () => {
  it("空查询只看最近，两类各归各档", () => {
    expect(sectionsFor("all", true)).toEqual(["recent", "recentActions"]);
    expect(sectionsFor("files", true)).toEqual(["recent"]);
    expect(sectionsFor("actions", true)).toEqual(["recentActions"]);
    expect(sectionsFor("classes", true)).toEqual([]);
  });

  it("带查询时 All 混排五节，单档只查自己", () => {
    expect(sectionsFor("all", false)).toEqual(["classes", "files", "symbols", "actions", "text"]);
    expect(sectionsFor("text", false)).toEqual(["text"]);
  });

  it("限量与 openidea 同一套口径", () => {
    expect({ ALL_TAB_LIMIT, RECENT_LIMIT, TEXT_WEIGHT }).toEqual({ ALL_TAB_LIMIT: 6, RECENT_LIMIT: 15, TEXT_WEIGHT: 350 });
  });
});

describe("fileItem 名字下标", () => {
  it("名字里对得上就用名字下标", () => {
    const item = fileItem(fileHit("D:/r/src/components/SearchEverywhere.tsx", "SearchEverywhere.tsx", "src/components"), "search");
    expect(item.nameIndices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(item.dir).toBe("src/components");
    expect(item.key).toBe("f:D:/r/src/components/SearchEverywhere.tsx");
  });

  it("只在相对路径上对上时，下标折算回名字里", () => {
    // "com/ev" 跨过目录与名字的分界，落在名字上的那段要减掉 `dir/` 的长度。
    expect(fileItem(fileHit("D:/r/src/com/Everywhere.tsx", "Everywhere.tsx", "src/com"), "com/ev").nameIndices).toEqual([0, 1]);
  });

  it("`File.kt:42` 那种输入带的行列号原样挂在条目上", () => {
    const item = fileItem(fileHit("D:/r/File.kt", "File.kt", ""), "File", 42, 5);
    expect([item.line, item.col]).toEqual([42, 5]);
  });
});

describe("symbolItem 符号行", () => {
  it("可调用符号展示名带括号，类不带", () => {
    expect(symbolDisplayName("render", "method")).toBe("render()");
    expect(symbolDisplayName("Foo", "class")).toBe("Foo");
    expect(symbolDisplayName("run()", "function")).toBe("run()");
  });

  it("种类表跟 Rust 那边同一张", () => {
    expect(isTypeKind("trait")).toBe(true);
    expect(isTypeKind("variable")).toBe(false);
  });

  it("右侧出处用文件名，行列入乡随俗保持 1 起", () => {
    const item = symbolItem(symbolHit("renderApp", "function"), "render");
    expect(item.file).toBe("App.tsx");
    expect(item.display).toBe("renderApp()");
    expect([item.line, item.col]).toEqual([12, 8]);
    expect(item.indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(item.key).toBe("s:D:/r/src/App.tsx:12:8:renderApp");
  });
});

describe("matchActions 动作档", () => {
  const cmds = [cmd("search.gotoClass", "Go to Class"), cmd("search.gotoSymbol", "Go to Symbol"), cmd("editor.smart", "sMArt step INto")];

  it("同分时短的在前，最近用过的往上抬", () => {
    expect(matchActions(cmds, "go to", []).map((a) => a.id)).toEqual(["search.gotoClass", "search.gotoSymbol"]);
    expect(matchActions(cmds, "go to", ["search.gotoSymbol", "search.gotoClass"]).map((a) => a.id)).toEqual([
      "search.gotoSymbol",
      "search.gotoClass",
    ]);
  });

  it("散落的逐字命中只排在起头的那批后面", () => {
    const hits = matchActions(cmds, "ino", []);
    expect(hits.map((a) => a.id)).toEqual(["editor.smart"]);
    expect(hits[0]?.indices).toEqual([11, 12, 14]);
    expect(matchActions(cmds, "go to", [])[0]!.score).toBeGreaterThan(hits[0]!.score);
  });

  it("标签对不上但 id 包含也收，只给个低分", () => {
    expect(matchActions([cmd("git.commitAll", "提交全部")], "commit", [])).toEqual([
      { kind: "action", key: "a:git.commitAll", id: "git.commitAll", title: "提交全部", shortcut: undefined, indices: [], score: -400 },
    ]);
  });

  it("空查询这一节什么都不出，交给「最近执行」那一档", () => {
    expect(matchActions(cmds, "", [])).toEqual([]);
  });

  it("带快捷键的动作把 shortcut 带上", () => {
    expect(matchActions([cmd("app.settings", "Open Settings", "Ctrl+,")], "open", [])[0]?.shortcut).toBe("Ctrl+,");
  });
});

describe("textItem 正文行", () => {
  it("行首缩进最多留两个空格，命中下标跟着挪", () => {
    const hit: TextHit = {
      path: "D:/r/src/App.tsx",
      name: "App.tsx",
      container: "src",
      line: 7,
      snippetFrom: 1,
      snippet: "    const value = computeTheThing(x);",
      ranges: [{ column: 30, length: 4 }],
    };
    const item = textItem(hit);
    expect(item.text).toBe("  const value = computeTheThing(x);");
    expect(item.indices).toEqual([27, 28, 29, 30]);
    expect([item.col, item.endCol]).toEqual([30, 34]);
  });

  it("片段是从行中间截的，下标按 snippetFrom 折算", () => {
    const hit: TextHit = {
      path: "D:/r/src/App.tsx",
      name: "App.tsx",
      container: "src",
      line: 7,
      snippetFrom: 21,
      snippet: "computeTheThing(x); return value",
      ranges: [{ column: 21, length: 7 }],
    };
    const item = textItem(hit);
    expect(item.col).toBe(21);
    expect(item.indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(item.hit).toBe(hit);
  });
});

describe("混排", () => {
  const mixed = sections([
    ["classes", { items: [symbolItem(symbolHit("Alpha"), "alpha"), symbolItem(symbolHit("Xz"), "alpha")], hasMore: true }],
    ["files", { items: [fileItem(fileHit("D:/r/alpha.ts", "alpha.ts", ""), "alpha")] }],
    ["text", { items: [textItem({ path: "D:/r/src/App.tsx", name: "App.tsx", container: "src", line: 7, snippetFrom: 1, snippet: "alpha", ranges: [{ column: 1, length: 5 }] })], hasMore: true }],
  ]);

  it("节内保持来源顺序，权重被夹成非递增", () => {
    expect(mixItems(mixed, "alpha").map((x) => [x.section, x.weight])).toEqual([
      ["classes", 995],
      ["files", 797],
      ["text", TEXT_WEIGHT],
      ["classes", 0],
    ]);
  });

  it("正文权重固定一档，不跟名字比", () => {
    const item = textItem({ path: "D:/r/src/App.tsx", name: "App.tsx", container: "src", line: 7, snippetFrom: 1, snippet: "alpha", ranges: [{ column: 1, length: 5 }] });
    expect(itemWeight(item, "zzz")).toBe(TEXT_WEIGHT);
    expect(itemWeight(item, "alpha")).toBe(TEXT_WEIGHT);
  });
});

describe("buildRows 平表", () => {
  const mixed = sections([
    ["classes", { items: [symbolItem(symbolHit("Alpha"), "alpha")], hasMore: true }],
    ["files", { items: [fileItem(fileHit("D:/r/alpha.ts", "alpha.ts", ""), "alpha")] }],
    ["text", { items: [] }],
  ]);

  it("分节标题走传入的译文，缺省用分节 id", () => {
    expect(
      buildRows(mixed, { headers: true, titles: { classes: "类", files: "文件" } }).map((r) => [r.kind, r.kind === "section" ? r.title : r.key])
    ).toEqual([
      ["section", "类"],
      ["symbol", "s:D:/r/src/App.tsx:12:8:Alpha"],
      ["more", "+classes"],
      ["section", "文件"],
      ["file", "f:D:/r/alpha.ts"],
    ]);
    expect(buildRows(mixed, { headers: true })[0]).toEqual({ kind: "section", key: "#classes", section: "classes", title: "classes" });
  });

  it("不要标题就只留条目和「更多」行", () => {
    expect(buildRows(mixed, { headers: false }).map((r) => r.kind)).toEqual(["symbol", "more", "file"]);
  });

  it("空结果的分节整节不出现", () => {
    expect(buildRows(sections([["symbols", { items: [], hasMore: false }]]), { headers: true })).toEqual([]);
  });

  it("All 页签混排：条目按权重排，「更多」行殿后，且不插标题", () => {
    const rows = buildRows(mixed, { headers: true, mix: "alpha" });
    expect(rows.map((r) => [r.kind, r.key])).toEqual([
      ["symbol", "s:D:/r/src/App.tsx:12:8:Alpha"],
      ["file", "f:D:/r/alpha.ts"],
      ["more", "+classes"],
    ]);
  });

  it("标题行认得出来，键盘不走它", () => {
    const rows = buildRows(mixed, { headers: true });
    expect(isSectionRow(rows[0])).toBe(true);
    expect(isSectionRow(rows[1])).toBe(false);
  });
});

describe("parseCommand 「/」命令", () => {
  const label = (tab: string) => `T:${tab}`;

  it("光秃秃的 / 列出能跳的五个页签", () => {
    const p = parseCommand("/", label);
    expect(p).toEqual({
      kind: "list",
      rows: [
        { kind: "command", key: "cmd:classes", name: "/classes", tab: "classes", label: "T:classes" },
        { kind: "command", key: "cmd:files", name: "/files", tab: "files", label: "T:files" },
        { kind: "command", key: "cmd:symbols", name: "/symbols", tab: "symbols", label: "T:symbols" },
        { kind: "command", key: "cmd:actions", name: "/actions", tab: "actions", label: "T:actions" },
        { kind: "command", key: "cmd:text", name: "/text", tab: "text", label: "T:text" },
      ],
    });
  });

  it("前缀能筛", () => {
    expect(parseCommand("/fi", label)).toEqual({
      kind: "list",
      rows: [{ kind: "command", key: "cmd:files", name: "/files", tab: "files", label: "T:files" }],
    });
    expect(parseCommand("/zz", label)).toBeNull();
  });

  it("带参数就跳页签并把剩下的当查询，页签名不分大小写", () => {
    expect(parseCommand("/files foo", label)).toEqual({ kind: "run", tab: "files", rest: "foo" });
    expect(parseCommand("/FILES x", label)).toEqual({ kind: "run", tab: "files", rest: "x" });
    expect(parseCommand("/text two words", label)).toEqual({ kind: "run", tab: "text", rest: "two words" });
  });

  it("对不上的命令与平时的输入都当查询本身", () => {
    expect(parseCommand("/nope x", label)).toBeNull();
    expect(parseCommand("hello", label)).toBeNull();
    expect(parseCommand("", label)).toBeNull();
  });
});

describe("topResultSettled 顶端收口", () => {
  it("第一条有结果的分节之前还在转，就没收口", () => {
    expect(
      topResultSettled(
        sections([
          ["classes", { loading: true }],
          ["files", { items: [fileItem(fileHit("D:/r/a", "a", ""), "a")] }],
        ])
      )
    ).toBe(false);
    expect(
      topResultSettled(
        sections([
          ["classes", {}],
          ["files", { loading: true }],
        ])
      )
    ).toBe(false);
    expect(topResultSettled(sections([["files", {}]]))).toBe(true);
  });

  it("混排时名字档还在转就等，正文档自己转但有名字压得住就不等", () => {
    const text: TextHit = { path: "D:/r/a", name: "a", container: "", line: 1, snippetFrom: 1, snippet: "alpha", ranges: [{ column: 1, length: 5 }] };
    const withText = sections([
      ["classes", { loading: true }],
      ["text", { items: [textItem(text)] }],
    ]);
    expect(topResultSettled(withText, "alpha")).toBe(false);
    expect(topResultSettled(sections([["classes", { items: [symbolItem(symbolHit("Alpha"), "alpha")] }], ["text", { loading: true }]]), "alpha")).toBe(true);
    expect(topResultSettled(sections([["text", { items: [textItem(text)], loading: true }]]), "alpha")).toBe(false);
  });
});

describe("stableIndex 选中位钉住", () => {
  const rows = buildRows(
    sections([
      ["classes", { items: [symbolItem(symbolHit("Alpha"), "alpha")] }],
      ["files", { items: [fileItem(fileHit("D:/r/alpha.ts", "alpha.ts", ""), "alpha"), fileItem(fileHit("D:/r/beta.ts", "beta.ts", ""), "beta")] }],
    ]),
    { headers: true }
  );

  it("同一个 key 还在就跟着它走", () => {
    expect(stableIndex(rows, "f:D:/r/beta.ts", 0, false)).toBe(4);
  });

  it("条目没了就夹回最近的可选行，用户没动过则落第一条可选行", () => {
    expect(rows.map((r) => r.key)).toEqual(["#classes", "s:D:/r/src/App.tsx:12:8:Alpha", "#files", "f:D:/r/alpha.ts", "f:D:/r/beta.ts"]);
    expect(stableIndex(rows, "gone", 4, true)).toBe(4);
    expect(stableIndex(rows, "gone", 3, false)).toBe(1);
    expect(stableIndex(rows, null, 0, false)).toBe(1);
  });

  it("空表返回 -1，渲染层自己兜住", () => {
    expect(stableIndex([], "x", 0, true)).toBe(-1);
  });
});
