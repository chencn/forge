import { describe, expect, it } from "vitest";
import { buildNavRows, navCount, navLabel, NAV_PAGE, visibleNavRows } from "../../src/lib/aiMessageNav";
import type { AiEntry, AiOutlineSnapshot, AiOutlineTurn } from "../../src/lib/aiRuntime";

const EMPTY: AiOutlineSnapshot = { turns: [], complete: false, loaded: false, loading: false, error: null };

function turn(seq: number, label: string, files = 0, runId = `r${seq}`): AiOutlineTurn {
  return { seq, entryId: `${runId}:${seq}`, runId, label, files };
}
function user(id: string, text: string, seq?: number): AiEntry { return { id, runId: id.split(":")[0], kind: "user", text, ...(seq === undefined ? {} : { seq }) }; }
function files(id: string, runId: string, paths: string[]): AiEntry { return { id, runId, kind: "files", text: "", paths }; }
const outline = (...turns: AiOutlineTurn[]): AiOutlineSnapshot => ({ ...EMPTY, turns, complete: true, loaded: true });

describe("消息导航的行", () => {
  it("列出索引里的每一轮，而不是只有正文加载到的那一条", () => {
    const rows = buildNavRows([user("r3:3", "第三条")], outline(turn(1, "第一条"), turn(2, "第二条", 4, "r2"), turn(3, "第三条")));
    expect(rows.map((row) => [row.ordinal, row.label, row.files, row.loaded])).toEqual([
      [1, "第一条", 0, false],
      [2, "第二条", 4, false],
      [3, "第三条", 0, true],
    ]);
    // 未加载的那几行带着 seq，点击时才知道要往前补到第几条事件。
    expect(rows[0].seq).toBe(1);
  });

  it("正文里比索引更早的那几轮按序号归位，不接在末尾冒充最新", () => {
    // 索引一次最多列 2000 轮；这一页正文里还留着索引开始之前的轮次。
    const rows = buildNavRows([user("r1:1", "第一条", 1), user("r9:9", "第九条", 9)], outline(turn(5, "第五条"), turn(9, "第九条")));
    expect(rows.map((row) => [row.ordinal, row.label, row.loaded])).toEqual([
      [1, "第一条", true],
      [2, "第五条", false],
      [3, "第九条", true],
    ]);
    // 本机刚按下、还没落进日志的那一轮没有序号：它确实最新，排最后。
    const tail = buildNavRows([user("r1:1", "第一条", 1), user("rn:0", "正在发的这条")], outline(turn(1, "第一条")));
    expect(tail.map((row) => row.label)).toEqual(["第一条", "正在发的这条"]);
  });

  it("已加载的那一轮用正文里的文件数，索引只是面板打开时的旧快照", () => {
    const entries = [user("r1:1", "改几个文件"), files("f1", "r1", ["a.ts", "b.ts"]), files("f2", "r1", ["b.ts"])];
    const rows = buildNavRows(entries, outline(turn(1, "改几个文件", 9)));
    expect(rows[0]).toMatchObject({ label: "改几个文件", files: 2, loaded: true });
  });

  it("索引之后新发出的轮次接在最后，序号照常往后排", () => {
    const rows = buildNavRows([user("r9:9", "索引之后又发的一条")], outline(turn(1, "第一条")));
    expect(rows.map((row) => [row.ordinal, row.id])).toEqual([[1, "r1:1"], [2, "r9:9"]]);
    expect(rows[1].loaded).toBe(true);
  });

  it("没有索引时也照常列正文里加载到的那些", () => {
    const rows = buildNavRows([user("r1:1", "只有正文"), user("r2:2", "两条")], EMPTY);
    expect(rows.map((row) => row.ordinal)).toEqual([1, 2]);
    expect(rows.every((row) => row.loaded)).toBe(true);
  });

  it("同一轮不会因为在索引和正文里都有就列出两遍", () => {
    const rows = buildNavRows([user("r1:1", "同一条")], outline(turn(1, "同一条")));
    expect(rows).toHaveLength(1);
  });

  it("摘要取第一行非空文字并截断", () => {
    expect(navLabel("\n  \n开头这行\n后面那些")).toBe("开头这行");
    expect(navLabel(undefined)).toBe("");
    expect(navLabel(`问${"啊".repeat(200)}`).length).toBeLessThanOrEqual(120);
  });
});

describe("消息导航的窗口", () => {
  const rows = buildNavRows([], outline(...Array.from({ length: 450 }, (_, index) => turn(index + 1, `第${index + 1}条`))));

  it("先给最近这么多行，因为正文此刻就停在最新那一轮", () => {
    const visible = visibleNavRows(rows, NAV_PAGE);
    expect(visible).toHaveLength(NAV_PAGE);
    expect(visible.at(-1)?.ordinal).toBe(450);
    expect(visible[0]?.ordinal).toBe(450 - NAV_PAGE + 1);
  });

  it("往上加一档就把更早的一段接进来，序号仍然按整个会话数", () => {
    const visible = visibleNavRows(rows, NAV_PAGE * 3);
    expect(visible).toHaveLength(450);
    expect(visible[0]?.ordinal).toBe(1);
  });

  it("没超过一档时全列出来", () => {
    expect(visibleNavRows(buildNavRows([], outline(turn(1, "一"), turn(2, "二"))), NAV_PAGE)).toHaveLength(2);
  });
});

describe("消息导航的条数", () => {
  it("索引没取回时只说已加载的，还有更早的记录就带个 +", () => {
    const rows = buildNavRows([user("r1:1", "一条")], EMPTY);
    expect(navCount(rows, EMPTY, true)).toBe("1+");
    expect(navCount(rows, EMPTY, false)).toBe("1");
  });

  it("索引取回了就报整个会话的轮数；没数到开头时不冒充总数", () => {
    const turns = [turn(1, "一"), turn(2, "二"), turn(3, "三")];
    expect(navCount(buildNavRows([], outline(...turns)), outline(...turns), true)).toBe("3");
    expect(navCount(buildNavRows([], { ...EMPTY, turns, loaded: true }), { ...EMPTY, turns, loaded: true }, false)).toBe("3+");
  });
});
