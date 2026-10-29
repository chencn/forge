import { describe, expect, it } from "vitest";
import type { FileHit, SearchOptions, SymbolHit, TextHit, TextPage } from "../../src/lib/fs";
import { SeController, recentFileItem, sectionLimit, TEXT_MIN_QUERY, type SeDeps, type SeRequest, type SeSnapshot } from "../../src/lib/seController";
import type { ForgeCommand } from "../../src/lib/commands";
import type { SectionId, SectionState } from "../../src/lib/seModel";

const ROOT = "D:/r";

const cmd = (id: string, label: string): ForgeCommand => ({ id, label, run: () => {} });
const fHit = (name: string, container = "src"): FileHit => ({ path: `${ROOT}/${container}/${name}`, name, container, score: 3, isDir: false });
const sHit = (name: string, kind: string): SymbolHit => ({ path: `${ROOT}/src/App.tsx`, name, kind, container: "src", line: 4, column: 3 });
const tHit = (snippet: string): TextHit => ({ path: `${ROOT}/src/App.tsx`, name: "App.tsx", container: "src", line: 4, snippetFrom: 1, snippet, ranges: [{ column: 1, length: 4 }] });

/** 假数据源：`calls` 记下每一节被要了多少条、吃了哪个闸门。 */
function fake(d: Partial<SeDeps> = {}) {
  const calls: Array<{ section: string; query: string; limit: number; filter: unknown; options?: SearchOptions }> = [];
  const deps: SeDeps = {
    findFiles: (query, limit, filter) => {
      calls.push({ section: "files", query, limit, filter });
      return Promise.resolve([fHit(`${query}.ts`)]);
    },
    findSymbols: (query, kindFilter, limit, filter) => {
      calls.push({ section: kindFilter, query, limit, filter });
      return Promise.resolve([sHit(query, kindFilter === "types" ? "class" : "function"), sHit(`${query}Box`, "class")]);
    },
    searchText: (query, options, filter) => {
      calls.push({ section: "text", query, limit: options.limit ?? 0, filter, options });
      const page: TextPage = { query, hits: [tHit(query)], files: 1, truncated: false, skipped: 0 };
      return Promise.resolve(page);
    },
    actions: () => [cmd("file.new", "新建文件"), cmd("app.settings", "打开设置")],
    recentFiles: () => [`${ROOT}/src/App.tsx`, "C:/other/Old.tsx"],
    recentActions: () => ["app.settings"],
    root: () => ROOT,
    now: () => 1000,
    ...d
  };
  return { deps, calls };
}

/** 请求底稿，用例只改自己关心的那两格。 */
function request(over: Partial<SeRequest> = {}): SeRequest {
  return { query: "", tab: "all", includeIgnored: false, filter: { showHidden: false, ignored: [`${ROOT}/node_modules`] }, text: {}, extra: {}, ...over };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function run(deps: SeDeps, over?: Partial<SeRequest>) {
  const snaps: SeSnapshot[] = [];
  const c = new SeController(deps, (s) => snaps.push(s));
  c.run(request(over));
  await flush();
  return { c, snaps, snap: c.snapshot() };
}

const itemsOf = (snap: SeSnapshot, id: SectionId) => (snap.sections.get(id) ?? { items: [] as never[] }).items;
const stateOf = (snap: SeSnapshot, id: SectionId): SectionState | undefined => snap.sections.get(id);

describe("sectionLimit 每次要多少", () => {
  it("All 每节只留几行，单档放开，「最近」按自己的档", () => {
    expect(sectionLimit("all", "files", 0)).toBe(6);
    expect(sectionLimit("files", "files", 0)).toBe(50);
    expect(sectionLimit("all", "recent", 15)).toBe(30);
    expect(sectionLimit("actions", "recentActions", 0)).toBe(15);
  });
});

describe("SeController 分节取数", () => {
  it("空查询只问最近两档，且严格按工程根过滤（根外文件不污染推荐列表）", async () => {
    const { deps, calls } = fake();
    const { snap } = await run(deps);
    expect(calls).toEqual([]);
    expect([...snap.sections.keys()].sort()).toEqual(["recent", "recentActions"]);
    expect(itemsOf(snap, "recent")).toHaveLength(1);
    const recentItem = itemsOf(snap, "recent")[0];
    expect(recentItem?.kind === "file" ? recentItem.path : "").toBe(`${ROOT}/src/App.tsx`);
    expect(itemsOf(snap, "recentActions").map((i) => i.key)).toEqual(["a:app.settings"]);
    expect(snap.loading).toBe(false);
  });

  it("All 页签五节各查各的，一次都不落", async () => {
    const { deps, calls } = fake();
    const { snap } = await run(deps, { query: "app" });
    expect(calls.map((c) => c.section).sort()).toEqual(["all", "files", "text", "types"]);
    expect([...snap.sections.keys()].sort()).toEqual(["actions", "classes", "files", "symbols", "text"]);
    expect(calls.find((c) => c.section === "files")?.limit).toBe(7);
    expect(snap.query).toBe("app");
    expect(snap.elapsed).toBe(0);
  });

  it("「类」只要类型；「符号」在 All 里把类型剪掉、多要一半", async () => {
    const { deps, calls } = fake();
    const { snap } = await run(deps, { query: "app", tab: "all" });
    expect(itemsOf(snap, "classes")).toHaveLength(2);
    expect(itemsOf(snap, "symbols")).toHaveLength(1);
    expect(itemsOf(snap, "symbols")[0]?.key).toBe("s:D:/r/src/App.tsx:4:3:app");
    expect(calls.find((c) => c.section === "types")?.limit).toBe(7);
    expect(calls.find((c) => c.section === "all")?.limit).toBe(13);
  });

  it("单档的「符号」不剪类型，限量按单档放开", async () => {
    const { deps, calls } = fake();
    const { snap } = await run(deps, { query: "app", tab: "symbols" });
    expect(calls.find((c) => c.section === "all")?.limit).toBe(51);
    expect(itemsOf(snap, "symbols")).toHaveLength(2);
  });

  it("正文少于两个字符不查，整节直接收口", async () => {
    const { deps, calls } = fake();
    const { snap } = await run(deps, { query: "a", tab: "text" });
    expect(TEXT_MIN_QUERY).toBe(2);
    expect(calls.filter((c) => c.section === "text")).toEqual([]);
    expect(stateOf(snap, "text")).toEqual({ items: [], hasMore: false, loading: false });
  });

  it("正文多要一条才知道截没截，整页结果留给底部查找窗口", async () => {
    const { deps, calls } = fake();
    const { snap } = await run(deps, { query: "compute", tab: "text" });
    expect(calls.filter((c) => c.section === "text")[0]?.limit).toBe(51);
    expect(snap.textPage?.hits).toHaveLength(1);
    expect(itemsOf(snap, "text")[0]).toMatchObject({ kind: "text", line: 4, col: 1 });
  });

  it("`File.kt:42` 剪掉行号再查，行号挂在文件条目上", async () => {
    const { deps, calls } = fake();
    const { snap } = await run(deps, { query: "App:42", tab: "files" });
    expect(calls[0]).toMatchObject({ section: "files", query: "App" });
    expect(itemsOf(snap, "files")[0]).toMatchObject({ line: 42, col: null, name: "App.ts" });
  });

  it("勾了「包括隐藏与忽略项」就把闸门整个放开，不勾时跟着设置", async () => {
    const on = fake();
    await run(on.deps, { query: "app", tab: "files", includeIgnored: true });
    expect(on.calls[0]?.filter).toEqual({ showHidden: true, ignored: [] });
    const off = fake();
    await run(off.deps, { query: "app", tab: "files" });
    expect(off.calls[0]?.filter).toEqual({ showHidden: false, ignored: [`${ROOT}/node_modules`] });
  });

  it("动作档吃命令面板那张表，不吃后端", async () => {
    const { deps, calls } = fake();
    const { snap } = await run(deps, { query: "设置", tab: "actions" });
    expect(calls).toEqual([]);
    expect(itemsOf(snap, "actions").map((i) => i.key)).toEqual(["a:app.settings"]);
  });

  it("正文的开关与文件名过滤原样交给后端，条数由编排补", async () => {
    const { deps, calls } = fake();
    await run(deps, { query: "compute", tab: "text", text: { regex: true, caseSensitive: true, fileMask: "*.ts" } });
    const text = calls.find((c) => c.section === "text");
    expect(text?.query).toBe("compute");
    expect(text?.limit).toBe(51);
    expect(text?.options).toEqual({ regex: true, caseSensitive: true, fileMask: "*.ts", limit: 51 });
  });
});

describe("SeController 重查与顶掉", () => {
  it("同一个词、同一档再来一次不重查，结果原样留着", async () => {
    const { deps, calls } = fake();
    const c = new SeController(deps, () => {});
    c.run(request({ query: "app", tab: "files" }));
    await flush();
    const before = c.snapshot();
    const n = calls.length;
    c.run(request({ query: "app", tab: "files" }));
    await flush();
    expect(calls.length).toBe(n);
    const after = c.snapshot();
    expect(after.gen).toBe(before.gen + 1);
    expect(after.sections.get("files")).toEqual(before.sections.get("files"));
  });

  it("点「更多」加量时只重查那一节，别节原样留着", async () => {
    const { deps, calls } = fake();
    const c = new SeController(deps, () => {});
    c.run(request({ query: "app" }));
    await flush();
    calls.length = 0;
    c.run(request({ query: "app", extra: { files: 15 } }));
    await flush();
    expect(calls.map((x) => x.section)).toEqual(["files"]);
    expect(calls[0]?.limit).toBe(22);
  });

  it("换词把旧查询姗姗来迟的结果顶掉", async () => {
    const resolvers: Array<(hits: FileHit[]) => void> = [];
    const { deps } = fake({ findFiles: () => new Promise<FileHit[]>((resolve) => void resolvers.push(resolve)) });
    const c = new SeController(deps, () => {});
    c.run(request({ query: "slow", tab: "files" }));
    c.run(request({ query: "fast", tab: "files" }));
    resolvers[1]?.([fHit("fast.ts")]);
    await flush();
    resolvers[0]?.([fHit("slow.ts")]);
    await flush();
    expect(itemsOf(c.snapshot(), "files").map((i) => i.key)).toEqual(["f:D:/r/src/fast.ts"]);
    expect(c.snapshot().query).toBe("fast");
  });

  it("某一节报错：整节空掉，原因留给界面说人话", async () => {
    const { deps } = fake({ searchText: () => Promise.reject(new Error("BAD_REGEX")) });
    const { snap } = await run(deps, { query: "app", tab: "text" });
    expect(snap.failed).toBe("BAD_REGEX");
    expect(stateOf(snap, "text")).toEqual({ items: [], hasMore: false, loading: false });
    expect(snap.loading).toBe(false);
  });

  it("换页签把不属于它的分节撤掉", async () => {
    const { deps } = fake();
    const c = new SeController(deps, () => {});
    c.run(request({ query: "app" }));
    await flush();
    c.run(request({ query: "app", tab: "actions" }));
    await flush();
    expect([...c.snapshot().sections.keys()]).toEqual(["actions"]);
  });

  it("dispose 把状态清空，下一趟从头再来", async () => {
    const { deps } = fake();
    const c = new SeController(deps, () => {});
    c.run(request({ query: "app", tab: "files" }));
    await flush();
    c.dispose();
    expect(c.snapshot().sections.size).toBe(0);
    c.run(request({ query: "app", tab: "files" }));
    await flush();
    expect([...c.snapshot().sections.keys()]).toEqual(["files"]);
  });

  it("快照答的是最近发起的那一趟", async () => {
    const { deps } = fake();
    const c = new SeController(deps, () => {});
    c.run(request({ query: "one", tab: "files" }));
    const first = c.snapshot();
    c.run(request({ query: "two", tab: "text" }));
    const second = c.snapshot();
    expect([first.query, first.tab, first.gen, first.textPage]).toEqual(["one", "files", 1, null]);
    expect([second.query, second.tab, second.gen]).toEqual(["two", "text", 2]);
    await flush();
  });
});

describe("recentFileItem 最近文件", () => {
  it("根内的路径拆成相对目录", () => {
    expect(recentFileItem(`${ROOT}/src/components/App.tsx`, ROOT)).toMatchObject({ name: "App.tsx", dir: "src/components", isDir: false });
  });

  it("反斜杠路径与根外的旧路径都不挡显示", () => {
    expect(recentFileItem("D:\\r\\src\\App.tsx", ROOT).dir).toBe("src");
    expect(recentFileItem("C:/other/Old.tsx", ROOT)).toMatchObject({ name: "Old.tsx", dir: "", key: "f:C:/other/Old.tsx" });
  });

  it("直接挂在根下时目录格留空", () => {
    expect(recentFileItem(`${ROOT}/README.md`, ROOT).dir).toBe("");
  });
});
