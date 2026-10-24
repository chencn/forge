import { describe, expect, it } from "vitest";
import { groupAiTimeline, liveThinking, pageProcess, windowAiTimeline, MIN_PROCESS, PROCESS_PAGE } from "../../src/lib/aiTimeline";
import type { AiEntry } from "../../src/lib/aiRuntime";

const entry = (id: string, kind: AiEntry["kind"], extra: Partial<AiEntry> = {}): AiEntry => ({ id, runId: "r1", kind, text: "", ...extra });
const tools = (count: number, runId = "r1"): AiEntry[] => Array.from({ length: count }, (_, index) => entry(`${runId}-tool-${index}`, "tool", { runId, name: "Bash" }));

describe("AI 时间线折叠", () => {
  it("连着够多的工具调用折成一段，说话的还是单独一条", () => {
    const items = groupAiTimeline([entry("u", "user"), ...tools(5), entry("a", "assistant", { text: "结果是这样" })]);
    expect(items.map((item) => item.kind)).toEqual(["entry", "process", "entry"]);
    const process = items[1];
    expect(process.kind === "process" && process.entries).toHaveLength(5);
    expect(process.kind === "process" && process.key).toBe("process:r1-tool-0");
  });
  it("三条是门槛：差一条就不折，别为省一行加一次点击", () => {
    const below = groupAiTimeline([...tools(MIN_PROCESS - 1)]);
    expect(below.map((item) => item.kind)).toEqual(["entry", "entry"]);
    expect(groupAiTimeline(tools(MIN_PROCESS)).map((item) => item.kind)).toEqual(["process"]);
  });
  it("想法和工具算同一段过程，审批卡片绝不进段", () => {
    const items = groupAiTimeline([entry("t1", "tool"), entry("th1", "reasoning", { text: "先看目录" }), entry("t2", "tool"), entry("q", "request", { requestId: "q1" }), entry("t3", "tool"), entry("t4", "tool")]);
    expect(items.map((item) => item.kind)).toEqual(["process", "entry", "entry", "entry"]);
    expect(items[0].kind === "process" && items[0].entries.map((e) => e.id)).toEqual(["t1", "th1", "t2"]);
    // 卡片后面只剩两条工具，够不上门槛，原样铺开——不能把 request 折进任何段里。
    expect(items[1].kind === "entry" && items[1].entry.kind).toBe("request");
    expect(items.slice(2).map((item) => item.kind === "entry" ? item.entry.id : null)).toEqual(["t3", "t4"]);
  });
  it("换轮不并段：上一轮的工具不会和这一轮的折在一起", () => {
    const items = groupAiTimeline([...tools(4, "r1"), entry("u2", "user", { runId: "r2" }), ...tools(4, "r2")]);
    expect(items.map((item) => item.kind)).toEqual(["process", "entry", "process"]);
    expect(items[2].kind === "process" && items[2].runId).toBe("r2");
  });
  it("段里有还在跑的工具就标记 active，界面据此整段展开", () => {
    const idle = groupAiTimeline(tools(3));
    const busy = groupAiTimeline([entry("a", "tool"), entry("b", "tool", { status: "running" }), entry("c", "tool")]);
    expect(idle[0].kind === "process" && idle[0].active).toBe(false);
    expect(busy[0].kind === "process" && busy[0].active).toBe(true);
  });
  it("空输入不产生任何项", () => {
    expect(groupAiTimeline([])).toEqual([]);
  });
});

describe("时间线取窗口", () => {
  const items = groupAiTimeline(Array.from({ length: 40 }, (_, index) => entry(`u${index}`, "user")));
  it("从尾巴取，报得出藏了多少项", () => {
    const window = windowAiTimeline(items, 10);
    expect(window.items).toHaveLength(10);
    expect(window.hidden).toBe(30);
    // 先取到常量再判类型：方法调用每次都是新值，TS 不会把 narrow 带到下一次调用。
    const newest = window.items.at(-1)!;
    const oldest = window.items[0];
    expect(newest.kind === "entry" ? newest.entry.id : null).toBe("u39");
    expect(oldest.kind === "entry" ? oldest.entry.id : null).toBe("u30");
  });
  it("折叠段整段进出，不会被窗口劈开", () => {
    const mixed = groupAiTimeline([entry("u", "user"), ...tools(9)]);
    const window = windowAiTimeline(mixed, 1);
    expect(window.items).toHaveLength(1);
    expect(window.items[0].kind === "process" && window.items[0].entries).toHaveLength(9);
  });
  it("项数没超过窗口时一条不少，也不谎报藏了内容", () => {
    const window = windowAiTimeline(items, 100);
    expect(window.items).toHaveLength(40);
    expect(window.hidden).toBe(0);
  });
  it("窗口下限是 1，不会给出空列表还谎报全都显示", () => {
    expect(windowAiTimeline(items, 0).items).toHaveLength(1);
  });
});

describe("没有正文的思考块", () => {
  const thought = (id: string, text: string): AiEntry => entry(id, "reasoning", { text });
  it("结束的那轮里，空思考一条都不摆：一排「思考」点开什么都没有，看着像界面坏了", () => {
    const items = groupAiTimeline([entry("u", "user"), thought("r-empty", ""), thought("r-real", "先看目录"), entry("a", "assistant", { text: "好了" })]);
    expect(items.map((item) => item.kind === "entry" ? item.entry.id : item.kind)).toEqual(["u", "r-real", "a"]);
  });
  it("还在跑的那轮只留末尾这一条空的，它就是「正在想」的唯一凭证", () => {
    const running = [entry("u", "user"), thought("r-old", ""), thought("r-live", "")];
    expect(groupAiTimeline(running, true).map((item) => item.kind === "entry" ? item.entry.id : item.kind)).toEqual(["u", "r-live"]);
    expect(liveThinking(running, true)?.id).toBe("r-live");
    // 不在末尾的空思考已经想完了：想完了却没正文，就没有可显示的东西。
    expect(groupAiTimeline([entry("u", "user"), thought("r-live", ""), thought("t", "tool-ish")], true)).toHaveLength(2);
  });
  it("本轮停下来之后，刚才那条占位也跟着收掉，不留一条永远点不出的思考", () => {
    const rows = [entry("u", "user"), thought("r-live", "")];
    expect(groupAiTimeline(rows, true)).toHaveLength(2);
    expect(groupAiTimeline(rows, false)).toHaveLength(1);
    expect(liveThinking(rows, false)).toBeNull();
    expect(liveThinking([entry("u", "user")], true)).toBeNull();
  });
  it("空思考不算进折叠段的门槛，免得只为一条占位撑起一段", () => {
    const items = groupAiTimeline([...tools(2), thought("e1", ""), thought("e2", "")]);
    expect(items.map((item) => item.kind)).toEqual(["entry", "entry"]);
  });
});

describe("折叠段露出的条目", () => {
  const many = tools(20);
  it("默认露最近 8 条，剩下的算得出来", () => {
    const page = pageProcess(many);
    expect(page.visible).toHaveLength(PROCESS_PAGE);
    expect(page.visible[0].id).toBe("r1-tool-12");
    expect(page.hidden).toBe(12);
  });
  it("展开更多时露得更多，但不超过实际条数", () => {
    expect(pageProcess(many, 200).visible).toHaveLength(20);
    expect(pageProcess(many, 200).hidden).toBe(0);
    expect(pageProcess(many, 0).visible).toHaveLength(1);
  });
  it("段本来就短于页长时全露出来，hidden 记 0", () => {
    const few = tools(4);
    expect(pageProcess(few).visible).toHaveLength(4);
    expect(pageProcess(few).hidden).toBe(0);
  });
});
